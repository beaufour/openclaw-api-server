/**
 * Forwards webhook events to the OpenClaw Gateway.
 */

import http from "node:http";
import type { Logger } from "./logger.js";

export interface GatewayClient {
	forward(source: string, payload: Record<string, unknown>): Promise<boolean>;
}

export function createGatewayClient(
	gatewayUrl: string,
	logger: Logger,
): GatewayClient {
	return {
		async forward(source, payload) {
			const url = new URL("/webhook", gatewayUrl);
			const body = JSON.stringify({ source, payload });

			return new Promise((resolve) => {
				const req = http.request(
					url,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(body),
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
							logger.info("Forwarded event to gateway", {
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
