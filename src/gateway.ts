/**
 * Forwards webhook events to the OpenClaw Gateway via /hooks/<source>.
 *
 * Each source (gmail, asana, strava) gets its own mapped endpoint,
 * allowing per-service agent configuration in OpenClaw's hooks.mappings.
 */

import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { Logger } from "./logger.js";

export interface GatewayClient {
	forward(source: string, payload: Record<string, unknown>): Promise<boolean>;
}

export type GatewayBackend = "openclaw" | "hermes";

export interface GatewayClientOptions {
	backend: GatewayBackend;
	baseUrl: string;
	secret: string;
	logger: Logger;
	logPayload?: boolean;
}

function request(
	url: URL,
	body: string,
	headers: Record<string, string>,
	logger: Logger,
	path: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.request(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					...headers,
				},
				timeout: 10_000,
			},
			(res) => {
				res.resume();
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					logger.info(`Forwarded event to gateway (${path})`, {
						status: res.statusCode,
					});
					resolve(true);
				} else {
					logger.error(`Gateway returned error (${path})`, {
						status: res.statusCode,
					});
					resolve(false);
				}
			},
		);

		req.on("error", (err) => {
			logger.error(`Failed to forward event to gateway (${path})`, {
				error: err.message,
			});
			resolve(false);
		});

		req.end(body);
	});
}

/**
 * Create an outbound client for either OpenClaw or Hermes.
 *
 * Hermes receives the provider payload directly and authenticates it with its
 * replay-protected generic HMAC V2 scheme:
 *   HMAC-SHA256(secret, "<unix timestamp>.<raw body>")
 */
export function createAgentGatewayClient(
	options: GatewayClientOptions,
): GatewayClient {
	const { backend, baseUrl, secret, logger, logPayload = false } = options;
	if (!secret) {
		logger.error(
			backend === "hermes"
				? "HERMES_WEBHOOK_SECRET not set — gateway forwarding will fail"
				: "OPENCLAW_HOOK_TOKEN not set — gateway forwarding will fail",
		);
	}

	return {
		async forward(source, payload) {
			if (backend === "hermes") {
				const path = `/webhooks/${source}`;
				const url = new URL(path, baseUrl);
				const body = JSON.stringify({ event_type: source, ...payload });
				const timestamp = Math.floor(Date.now() / 1000).toString();
				const signature = createHmac("sha256", secret)
					.update(`${timestamp}.${body}`)
					.digest("hex");

				if (logPayload) logger.info(`Payload for ${path}`, { payload });
				return request(
					url,
					body,
					{
						"X-Webhook-Timestamp": timestamp,
						"X-Webhook-Signature-V2": signature,
						"X-Request-ID": `${source}-${randomUUID()}`,
					},
					logger,
					path,
				);
			}

			const path = `/hooks/${source}`;
			const url = new URL(path, baseUrl);
			const body = JSON.stringify({
				text: JSON.stringify(payload),
				mode: "now",
			});
			if (logPayload) logger.info(`Payload for ${path}`, { payload });
			return request(
				url,
				body,
				{ Authorization: `Bearer ${secret}` },
				logger,
				path,
			);
		},
	};
}

export function createGatewayClient(
	gatewayUrl: string,
	hookToken: string,
	logger: Logger,
	logPayload = false,
): GatewayClient {
	return createAgentGatewayClient({
		backend: "openclaw",
		baseUrl: gatewayUrl,
		secret: hookToken,
		logger,
		logPayload,
	});
}

export function createDryRunClient(logger: Logger): GatewayClient {
	return {
		async forward(source, payload) {
			logger.info("DRY RUN — would forward to gateway", { source, payload });
			return true;
		},
	};
}
