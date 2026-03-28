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
import { createDryRunClient, createGatewayClient } from "../src/gateway.js";
import { handleAsanaWebhook } from "../src/handlers/asana.js";
import type { GmailPubSubMessage } from "../src/handlers/gmail.js";
import { handleGmailWebhook } from "../src/handlers/gmail.js";
import type { StravaEvent } from "../src/handlers/strava.js";
import {
	handleStravaValidation,
	handleStravaWebhook,
} from "../src/handlers/strava.js";
import { googleJwtVerifier } from "../src/jwt-verifier.js";
import { createLogger } from "../src/logger.js";

const config = loadConfig();
const logger = createLogger("webhook-server");
const PORT = Number(process.env.PORT ?? 18790);
const DRY_RUN = process.argv.includes("--dry-run");
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";
const HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN ?? "";

const gateway = DRY_RUN
	? createDryRunClient(logger)
	: createGatewayClient(GATEWAY_URL, HOOK_TOKEN, logger);

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

function parseUrl(url: string): { pathname: string; query: Record<string, string> } {
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
		);
		if (result.payload) {
			await gateway.forward("gmail", result.payload);
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
		logger.info("Forwarding events to gateway", { url: GATEWAY_URL });
	}
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
		"GMAIL_REQUIRE_DKIM",
		"OPENCLAW_HOOK_TOKEN",
		"DATA_DIR",
	];
	const set = envVars.filter((v) => process.env[v]);
	if (set.length > 0) {
		logger.info("Config set:", { vars: set });
	}

	// Check for persisted Asana secret
	if (!config.asanaWebhookSecret) {
		import("../src/handlers/asana.js").then(({ getSecret }) => {
			if (getSecret(config)) {
				logger.info("Asana webhook secret loaded from persisted file");
			}
		});
	}
});
