/**
 * Webhook receiver server for OpenClaw.
 *
 * Receives webhooks from Gmail, Asana, and Strava, validates auth,
 * and forwards events to the OpenClaw Gateway.
 *
 * Usage:
 *   npx tsx scripts/server.ts              # Forward events to OpenClaw Gateway
 *   npx tsx scripts/server.ts --dry-run    # Log events without forwarding
 *
 * Config via .env file or environment variables (see .env.example).
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

// Load .env file if it exists (before importing config)
try {
	const envFile = readFileSync(".env", "utf-8");
	for (const line of envFile.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx);
		const value = trimmed.slice(eqIdx + 1);
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
} catch {
	// No .env file, that's fine
}

import { loadConfig } from "../src/config.js";
import {
	createAgentGatewayClient,
	createDryRunClient,
	type GatewayBackend,
} from "../src/gateway.js";
import { createFixedWindowCoalescer } from "../src/fixed-window-coalescer.js";
import { handleAsanaWebhook } from "../src/handlers/asana.js";
import type { GmailPubSubMessage } from "../src/handlers/gmail.js";
import { handleGmailWebhook } from "../src/handlers/gmail.js";
import { createGmailHeadersFetcher } from "../src/handlers/gmail-headers-fetcher.js";
import { startGmailWatchRenewal } from "../src/gmail-watch-renewer.js";
import type { StravaEvent } from "../src/handlers/strava.js";
import {
	handleStravaValidation,
	handleStravaWebhook,
} from "../src/handlers/strava.js";
import {
	createHealthMonitor,
	type HealthAlert,
	type HealthCheckDefinition,
} from "../src/health-monitor.js";
import { googleJwtVerifier } from "../src/jwt-verifier.js";
import { createLogger } from "../src/logger.js";

const config = loadConfig();
const logger = createLogger("webhook-server");
const PORT = Number(process.env.PORT ?? 18790);
const DRY_RUN = process.argv.includes("--dry-run");
const LOG_PAYLOAD = process.argv.includes("--log-payload");
const GATEWAY_BACKEND = (process.env.AGENT_GATEWAY_BACKEND ??
	"openclaw") as GatewayBackend;
if (GATEWAY_BACKEND !== "openclaw" && GATEWAY_BACKEND !== "hermes") {
	throw new Error(
		`AGENT_GATEWAY_BACKEND must be "openclaw" or "hermes", got "${GATEWAY_BACKEND}"`,
	);
}
const GATEWAY_URL =
	GATEWAY_BACKEND === "hermes"
		? (process.env.HERMES_WEBHOOK_URL ?? "http://localhost:8644")
		: (process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789");
const GATEWAY_SECRET =
	GATEWAY_BACKEND === "hermes"
		? (process.env.HERMES_WEBHOOK_SECRET ?? "")
		: (process.env.OPENCLAW_HOOK_TOKEN ?? "");

const gateway = DRY_RUN
	? createDryRunClient(logger)
	: createAgentGatewayClient({
			backend: GATEWAY_BACKEND,
			baseUrl: GATEWAY_URL,
			secret: GATEWAY_SECRET,
			logger,
			logPayload: LOG_PAYLOAD,
			routeProfiles: { gmail: "default" },
		});

// Operational alerts go to a Hermes deliver-only route ("ops-alert"), which
// posts the text straight to Slack without an agent run. Delivery must be
// confirmed; otherwise the alert stays queued and is retried.
const alertGateway =
	!DRY_RUN && GATEWAY_BACKEND === "hermes"
		? createAgentGatewayClient({
				backend: "hermes",
				baseUrl: GATEWAY_URL,
				secret: GATEWAY_SECRET,
				logger,
				routeProfiles: { "ops-alert": "default" },
				requireDelivered: true,
			})
		: undefined;
async function sendHealthAlert(alert: HealthAlert): Promise<boolean> {
	if (!alertGateway) {
		logger.warn("Health alert (not forwarded: no Hermes backend)", {
			check: alert.check,
			kind: alert.kind,
			text: alert.text,
		});
		return true;
	}
	return alertGateway.forward(
		"ops-alert",
		{ check: alert.check, kind: alert.kind, text: alert.text },
		`ops-alert-${alert.check}-${alert.kind}-${Date.now()}`,
	);
}

const gmailPubsubTopic = process.env.GMAIL_PUBSUB_TOPIC ?? "";
const healthChecks: Record<string, HealthCheckDefinition> = {};
if (config.gmailRequireDkim) {
	healthChecks["gmail-oauth"] = {
		title: "Gmail OAuth token refresh",
		impact:
			"New mail is not being vetted, approved, or forwarded to Hermes.",
		remedy:
			"create a Desktop OAuth client in the Pub/Sub topic's GCP project, run scripts/reauth-gmail.sh --new-client (or plain reauth-gmail.sh if only the grant was revoked), then restart openclaw-api-server.",
	};
}
if (gmailPubsubTopic) {
	healthChecks["gmail-watch"] = {
		title: "Gmail watch renewal",
		impact:
			"Gmail push notifications stop entirely once the current watch expires (7 days after the last renewal).",
		remedy:
			"check openclaw-api-server logs; a token error needs scripts/reauth-gmail.sh, a watch() 403/404 needs the Pub/Sub topic and its gmail-api-push publisher grant checked.",
		maxSilenceMs: 36 * 3_600_000,
	};
}
const health = createHealthMonitor({
	statePath: join(config.dataDir, "health_alerts.json"),
	checks: healthChecks,
	send: sendHealthAlert,
	logger,
	source: "Gmail receiver",
});

// Only build the headers fetcher when DKIM enforcement is on, so the rest of
// the server has no dependency on Gmail OAuth credentials being present.
const gmailHeadersFetcher = config.gmailRequireDkim
	? createGmailHeadersFetcher({
			dataDir: config.dataDir,
			logger,
			onTokenRefresh: (result) =>
				result.ok
					? health.ok("gmail-oauth")
					: health.fail("gmail-oauth", result.detail, {
							permanent: result.permanent,
						}),
		})
	: undefined;

// Gmail emits several Pub/Sub pushes per change. Waking immediately and then
// again on the trailing edge creates concurrent autonomous runs that can both
// process the same approved queue. Hold the first wake for one fixed window and
// collapse the whole burst into one trailing dispatch. The receiver still vets
// every push, while the single agent run sweeps every approved message.
const GMAIL_WAKE_DEBOUNCE_MS = Number(
	process.env.GMAIL_WAKE_DEBOUNCE_MS ?? 15000,
);
const scheduleGmailWake = createFixedWindowCoalescer<Record<string, unknown>>({
	delayMs: GMAIL_WAKE_DEBOUNCE_MS,
	dispatch: async (payload) => {
		await gateway.forward("gmail", payload);
	},
	onError: (error) =>
		logger.error("Failed to forward coalesced Gmail wake", {
			error: error instanceof Error ? error.message : String(error),
		}),
});

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

function parseUrl(url: string): {
	pathname: string;
	query: Record<string, string>;
} {
	const parsed = new URL(url, "http://localhost");
	const query: Record<string, string> = {};
	for (const [k, v] of parsed.searchParams) {
		query[k] = v;
	}
	return { pathname: parsed.pathname, query };
}

const server = http.createServer(async (req, res) => {
	const method = req.method ?? "GET";
	const { pathname, query } = parseUrl(req.url ?? "/");

	// Health check
	if (pathname === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
		return;
	}

	// Gmail
	if (pathname === "/webhook/gmail" && method === "POST") {
		const raw = await readBody(req);
		const body = JSON.parse(raw) as GmailPubSubMessage;
		const result = await handleGmailWebhook(
			body,
			req.headers.authorization,
			config,
			googleJwtVerifier,
			logger,
			gmailHeadersFetcher,
		);
		if (result.payload) {
			scheduleGmailWake(result.payload);
		}
		res.writeHead(result.status);
		res.end();
		return;
	}

	// Asana
	if (pathname === "/webhook/asana" && method === "POST") {
		const raw = await readBody(req);
		const result = handleAsanaWebhook(
			raw,
			req.headers["x-hook-secret"] as string | undefined,
			req.headers["x-hook-signature"] as string | undefined,
			config,
			logger,
		);
		if (result.payload) {
			await gateway.forward("asana", result.payload);
		}
		const headers: Record<string, string> = { ...result.headers };
		res.writeHead(result.status, headers);
		res.end();
		return;
	}

	// Strava — match /webhook/strava/<secret>
	const stravaMatch = pathname.match(/^\/webhook\/strava\/([^/]+)$/);
	if (stravaMatch) {
		const pathSecret = stravaMatch[1];

		if (method === "GET") {
			const result = handleStravaValidation(
				pathSecret,
				query["hub.mode"] ?? "",
				query["hub.challenge"] ?? "",
				query["hub.verify_token"] ?? "",
				config,
				logger,
			);
			res.writeHead(result.status, { "Content-Type": "application/json" });
			res.end(result.body ? JSON.stringify(result.body) : "");
			return;
		}

		if (method === "POST") {
			const raw = await readBody(req);
			const body = JSON.parse(raw) as StravaEvent;
			const result = handleStravaWebhook(pathSecret, body, config, logger);
			if (result.payload) {
				await gateway.forward("strava", result.payload);
			}
			res.writeHead(result.status);
			res.end();
			return;
		}
	}

	res.writeHead(404);
	res.end("Not found");
});

server.listen(PORT, () => {
	logger.info(`Server listening on http://localhost:${PORT}`);
	if (DRY_RUN) {
		logger.info("DRY RUN mode — events logged but not forwarded");
	} else {
		logger.info("Forwarding events to gateway", {
			backend: GATEWAY_BACKEND,
			url: GATEWAY_URL,
		});
	}
	// Evaluate silence limits and retry undelivered alerts periodically.
	const HEALTH_TICK_MS = Number(process.env.HEALTH_TICK_MS ?? 600_000);
	setInterval(() => void health.tick(), HEALTH_TICK_MS);
	void health.tick();

	logger.info("Routes:", {
		routes: [
			"GET  /health",
			"POST /webhook/gmail",
			"POST /webhook/asana",
			"GET  /webhook/strava/:secret",
			"POST /webhook/strava/:secret",
		],
	});
	const envVars = [
		"STRAVA_WEBHOOK_SECRET",
		"STRAVA_VERIFY_TOKEN",
		"ASANA_WEBHOOK_SECRET",
		"GMAIL_PUBSUB_AUDIENCE",
		"GMAIL_PUBSUB_SERVICE_ACCOUNT",
		"GMAIL_REQUIRE_DKIM",
		"GMAIL_DKIM_MODE",
		"OPENCLAW_HOOK_TOKEN",
		"HERMES_WEBHOOK_SECRET",
		"DATA_DIR",
	];
	const set = envVars.filter((v) => process.env[v]);
	if (set.length > 0) {
		logger.info("Config set:", { vars: set });
	}

	// Non-sensitive effective config — actual values, so the log shows the
	// live DKIM gate state at a glance (secrets like tokens are NOT logged).
	logger.info("Gmail DKIM config", {
		require_dkim: config.gmailRequireDkim,
		mode: config.gmailDkimMode,
		trusted_authserv: process.env.GMAIL_TRUSTED_AUTHSERV ?? "mx.google.com",
		allowlist_entries: config.gmailSenderAllowlist.length,
		data_dir: config.dataDir,
	});

	// Check for persisted Asana secret
	if (!config.asanaWebhookSecret) {
		import("../src/handlers/asana.js").then(({ getSecret }) => {
			if (getSecret(config)) {
				logger.info("Asana webhook secret loaded from persisted file");
			}
		});
	}

	if (gmailPubsubTopic) {
		startGmailWatchRenewal({
			dataDir: config.dataDir,
			topic: gmailPubsubTopic,
			logger,
			report: (ok, detail, permanent) =>
				ok
					? health.ok("gmail-watch")
					: health.fail("gmail-watch", detail ?? "unknown error", {
							permanent,
						}),
		});
	} else {
		logger.warn(
			"GMAIL_PUBSUB_TOPIC not set — automatic Gmail watch renewal is disabled",
		);
	}
});
