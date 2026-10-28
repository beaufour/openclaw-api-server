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
	forward(
		source: string,
		payload: Record<string, unknown>,
		deliveryId?: string,
	): Promise<boolean>;
}

export type GatewayBackend = "openclaw" | "hermes";

export interface GatewayClientOptions {
	backend: GatewayBackend;
	baseUrl: string;
	secret: string;
	logger: Logger;
	logPayload?: boolean;
	/** Trusted configuration, never derived from the notification payload. */
	routeProfiles?: Record<string, string>;
	/** Require a confirmed deliver-only response, not merely HTTP acceptance. */
	requireDelivered?: boolean;
}

function request(
	url: URL,
	body: string,
	headers: Record<string, string>,
	logger: Logger,
	path: string,
	requireDelivered = false,
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
				if (requireDelivered) {
					let body = "";
					res.on("data", (chunk: Buffer) => {
						if (body.length < 4096) body += chunk.toString();
					});
					res.on("error", () => resolve(false));
					res.on("end", () => {
						try {
							const result = JSON.parse(body);
							resolve(
								res.statusCode === 200 &&
									result.status === "delivered" &&
									result.target === "slack",
							);
						} catch {
							resolve(false);
						}
					});
					return;
				}
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

		req.on("timeout", () =>
			req.destroy(new Error("Gateway request timed out")),
		);
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
	const {
		backend,
		baseUrl,
		secret,
		logger,
		logPayload = false,
		routeProfiles = {},
	} = options;
	for (const profile of Object.values(routeProfiles)) {
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(profile))
			throw new Error("Invalid configured route profile");
	}
	if (!secret) {
		logger.error(
			backend === "hermes"
				? "HERMES_WEBHOOK_SECRET not set — gateway forwarding will fail"
				: "OPENCLAW_HOOK_TOKEN not set — gateway forwarding will fail",
		);
	}

	return {
		async forward(source, payload, deliveryId) {
			if (
				deliveryId !== undefined &&
				!/^[a-zA-Z0-9_-]{1,120}$/.test(deliveryId)
			)
				throw new Error("Invalid delivery ID");
			if (!/^[a-z0-9][a-z0-9_-]*$/.test(source))
				throw new Error("Invalid route name");
			if (backend === "hermes") {
				const profile = Object.hasOwn(routeProfiles, source)
					? routeProfiles[source]
					: undefined;
				const path = `${profile ? `/p/${profile}` : ""}/webhooks/${source}`;
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
						"X-Request-ID": deliveryId ?? `${source}-${randomUUID()}`,
					},
					logger,
					path,
					options.requireDelivered,
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
