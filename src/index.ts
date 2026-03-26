/**
 * OpenClaw plugin entry point.
 *
 * Registers webhook HTTP routes on the Gateway for Gmail, Asana, and Strava.
 * Each route validates auth, parses the payload, and triggers a wake event
 * so the agent can process the incoming notification.
 */

import { loadConfig } from "./config.js";
import { handleAsanaWebhook } from "./handlers/asana.js";
import {
	type GmailPubSubMessage,
	handleGmailWebhook,
	type JwtVerifier,
} from "./handlers/gmail.js";
import {
	handleStravaValidation,
	handleStravaWebhook,
	type StravaEvent,
} from "./handlers/strava.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger("webhook-receiver");

// Placeholder JWT verifier — in production, wire up google-auth-library
const jwtVerifier: JwtVerifier = {
	async verify(_token: string, _audience: string) {
		// TODO: Implement with google-auth-library's OAuth2Client.verifyIdToken()
		throw new Error("JWT verification not yet configured");
	},
};

/**
 * OpenClaw plugin registration.
 *
 * The exact Gateway plugin API may vary by OpenClaw version.
 * This plugin registers HTTP routes for webhook reception.
 * Adapt the `register()` call to match your Gateway's plugin API.
 */
export default {
	id: "webhook-receiver",
	name: "Webhook Receiver",

	register(api: PluginAPI) {
		logger.info("Registering webhook routes");

		// Gmail Pub/Sub push
		api.addRoute("POST", "/webhook/gmail", async (req) => {
			const result = await handleGmailWebhook(
				req.body as unknown as GmailPubSubMessage,
				req.headers.authorization,
				config,
				jwtVerifier,
				logger,
			);
			if (result.payload) {
				await api.triggerWakeEvent("gmail", result.payload);
			}
			return { status: result.status };
		});

		// Asana webhooks
		api.addRoute("POST", "/webhook/asana", async (req) => {
			const result = handleAsanaWebhook(
				req.rawBody,
				req.headers["x-hook-secret"],
				req.headers["x-hook-signature"],
				config,
				logger,
			);
			if (result.payload) {
				await api.triggerWakeEvent("asana", result.payload);
			}
			return {
				status: result.status,
				headers: result.headers,
			};
		});

		// Strava validation (GET)
		api.addRoute("GET", "/webhook/strava/:pathSecret", async (req) => {
			const result = handleStravaValidation(
				req.params.pathSecret,
				req.query["hub.mode"] ?? "",
				req.query["hub.challenge"] ?? "",
				req.query["hub.verify_token"] ?? "",
				config,
				logger,
			);
			return { status: result.status, body: result.body };
		});

		// Strava events (POST)
		api.addRoute("POST", "/webhook/strava/:pathSecret", async (req) => {
			const result = handleStravaWebhook(
				req.params.pathSecret,
				req.body as unknown as StravaEvent,
				config,
				logger,
			);
			if (result.payload) {
				await api.triggerWakeEvent("strava", result.payload);
			}
			return { status: result.status };
		});

		logger.info("Webhook routes registered", {
			routes: [
				"POST /webhook/gmail",
				"POST /webhook/asana",
				"GET /webhook/strava/:secret",
				"POST /webhook/strava/:secret",
			],
		});
	},
};

/**
 * Type definition for the OpenClaw Gateway plugin API.
 *
 * This is a minimal type based on documented plugin capabilities.
 * The actual API may expose additional methods. Consult the
 * OpenClaw plugin documentation for the full API surface.
 */
interface PluginAPI {
	addRoute(
		method: string,
		path: string,
		handler: (req: RouteRequest) => Promise<RouteResponse>,
	): void;
	triggerWakeEvent(
		source: string,
		payload: Record<string, unknown>,
	): Promise<void>;
}

interface RouteRequest {
	body: Record<string, unknown>;
	rawBody: string;
	headers: Record<string, string | undefined>;
	params: Record<string, string>;
	query: Record<string, string>;
}

interface RouteResponse {
	status: number;
	headers?: Record<string, string>;
	body?: unknown;
}
