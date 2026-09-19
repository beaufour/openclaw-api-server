import { createHmac } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentGatewayClient } from "../src/gateway.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

const servers: http.Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
});

async function captureRequest(): Promise<{
	baseUrl: string;
	request: Promise<{
		path: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	}>;
}> {
	let resolveRequest!: (value: {
		path: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	}) => void;
	const request = new Promise<{
		path: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	}>((resolve) => {
		resolveRequest = resolve;
	});
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			resolveRequest({
				path: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString(),
			});
			res.writeHead(202);
			res.end();
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No server address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, request };
}

describe("agent gateway forwarding", () => {
	it("sends Hermes raw JSON with replay-protected HMAC V2", async () => {
		const secret = "hermes-test-secret";
		const capture = await captureRequest();
		const client = createAgentGatewayClient({
			backend: "hermes",
			baseUrl: capture.baseUrl,
			secret,
			logger,
		});

		expect(await client.forward("gmail", { history_id: "123" })).toBe(true);
		const received = await capture.request;
		expect(received.path).toBe("/webhooks/gmail");
		expect(JSON.parse(received.body)).toEqual({
			event_type: "gmail",
			history_id: "123",
		});
		const timestamp = received.headers["x-webhook-timestamp"] as string;
		const expected = createHmac("sha256", secret)
			.update(`${timestamp}.${received.body}`)
			.digest("hex");
		expect(received.headers["x-webhook-signature-v2"]).toBe(expected);
		expect(received.headers["x-request-id"]).toMatch(/^gmail-/);
		expect(received.headers.authorization).toBeUndefined();
	});

	it("preserves the OpenClaw bearer-token envelope", async () => {
		const capture = await captureRequest();
		const client = createAgentGatewayClient({
			backend: "openclaw",
			baseUrl: capture.baseUrl,
			secret: "hook-token",
			logger,
		});

		expect(
			await client.forward("asana", { events: [{ action: "changed" }] }),
		).toBe(true);
		const received = await capture.request;
		expect(received.path).toBe("/hooks/asana");
		expect(received.headers.authorization).toBe("Bearer hook-token");
		expect(JSON.parse(received.body)).toEqual({
			text: JSON.stringify({ events: [{ action: "changed" }] }),
			mode: "now",
		});
	});
});
