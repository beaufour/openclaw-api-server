/**
 * Forwards webhook events to the OpenClaw Gateway via /hooks/wake.
 *
 * The wake endpoint injects a system event into the main session.
 * The agent's heartbeat loop picks it up and decides what to do.
 */

import http from "node:http";
import type { Logger } from "./logger.js";

export interface GatewayClient {
	forward(source: string, payload: Record<string, unknown>): Promise<boolean>;
}

export function createGatewayClient(
	gatewayUrl: string,
	hookToken: string,
	logger: Logger,
): GatewayClient {
	if (!hookToken) {
		logger.error("OPENCLAW_HOOK_TOKEN not set — gateway forwarding will fail");
	}

	return {
		async forward(source, payload) {
			const url = new URL("/hooks/wake", gatewayUrl);
			const text = `[${source}] ${JSON.stringify(payload)}`;
			const body = JSON.stringify({ text, mode: "now" });

			return new Promise((resolve) => {
				const req = http.request(
					url,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(body),
							Authorization: `Bearer ${hookToken}`,
						},
						timeout: 10_000,
					},
					(res) => {
						res.resume();
						if (
							res.statusCode &&
							res.statusCode >= 200 &&
							res.statusCode < 300
						) {
							logger.info("Forwarded wake event to gateway", {
								source,
								status: res.statusCode,
							});
							resolve(true);
						} else {
							logger.error("Gateway returned error", {
								source,
								status: res.statusCode,
							});
							resolve(false);
						}
					},
				);

				req.on("error", (err) => {
					logger.error("Failed to forward event to gateway", {
						source,
						error: err.message,
					});
					resolve(false);
				});

				req.end(body);
			});
		},
	};
}

export function createDryRunClient(logger: Logger): GatewayClient {
	return {
		async forward(source, payload) {
			logger.info("DRY RUN — would forward to gateway", { source, payload });
			return true;
		},
	};
}
