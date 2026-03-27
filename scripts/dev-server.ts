/**
 * Standalone dev server for testing webhook endpoints without OpenClaw.
 *
 * Usage: npx tsx scripts/dev-server.ts
 *
 * Mounts the same handlers on a plain Node HTTP server at localhost:8000.
 * Prints received payloads to stdout instead of triggering wake events.
 */

import http from "node:http";
import { loadConfig } from "../src/config.js";
import { handleAsanaWebhook } from "../src/handlers/asana.js";
import type { GmailPubSubMessage } from "../src/handlers/gmail.js";
import { handleGmailWebhook } from "../src/handlers/gmail.js";
import type { StravaEvent } from "../src/handlers/strava.js";
import {
	handleStravaValidation,
	handleStravaWebhook,
} from "../src/handlers/strava.js";
import { createLogger } from "../src/logger.js";

const config = loadConfig();
const logger = createLogger("dev-server");
const PORT = Number(process.env.PORT ?? 8000);

// Placeholder JWT verifier — accepts everything in dev mode
const devJwtVerifier = {
	verify: async () => ({ email: "dev@localhost" }),
};

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
			devJwtVerifier,
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
	logger.info("JWT validation is DISABLED in dev mode");
});
