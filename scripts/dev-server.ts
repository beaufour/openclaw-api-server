/**
 * Standalone dev server for testing webhook endpoints without OpenClaw.
 *
 * Usage: npx tsx scripts/dev-server.ts
 *
 * Mounts the same handlers on a plain Node HTTP server at localhost:8000.
 * Prints received payloads to stdout instead of triggering wake events.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { loadConfig } from "../src/config.js";

// Load .env file if it exists
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
const logger = createLogger("dev-server");
const PORT = Number(process.env.PORT ?? 8000);

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
			logger.info("WOULD TRIGGER wake event", { source: "gmail", payload: result.payload });
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
			logger.info("WOULD TRIGGER wake event", { source: "asana", payload: result.payload });
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
				logger.info("WOULD TRIGGER wake event", { source: "strava", payload: result.payload });
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
	logger.info(`Dev server listening on http://localhost:${PORT}`);
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
		"DATA_DIR",
	];
	const set = envVars.filter((v) => process.env[v]);
	const unset = envVars.filter((v) => !process.env[v]);
	if (set.length > 0) {
		logger.info("Config set:", { vars: set });
	}
	if (unset.length > 0) {
		logger.warn("Config not set:", { vars: unset });
	}
});
