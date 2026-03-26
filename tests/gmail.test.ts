import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
	handleGmailWebhook,
	type JwtVerifier,
	verifyAuthHeader,
} from "../src/handlers/gmail.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("test-gmail");

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		asanaWebhookSecret: "",
		stravaVerifyToken: "",
		stravaWebhookSecret: "",
		gmailPubsubAudience: "",
		dataDir: "/tmp/test-data",
		...overrides,
	};
}

function gmailBody(
	email = "test@example.com",
	historyId = "12345",
): { message: { data: string; messageId: string }; subscription: string } {
	const data = JSON.stringify({ emailAddress: email, historyId });
	return {
		message: {
			data: Buffer.from(data).toString("base64"),
			messageId: "msg-1",
		},
		subscription: "projects/test/subscriptions/gmail-push",
	};
}

const passingVerifier: JwtVerifier = {
	verify: async () => ({ email: "pubsub@google.com" }),
};

const failingVerifier: JwtVerifier = {
	verify: async () => {
		throw new Error("Invalid token");
	},
};

describe("Gmail Auth", () => {
	it("rejects missing auth header when audience is set", async () => {
		const config = makeConfig({
			gmailPubsubAudience: "https://webhooks.example.com",
		});
		const result = await verifyAuthHeader(
			undefined,
			config,
			passingVerifier,
			logger,
		);
		expect(result).toBe(false);
	});

	it("rejects non-Bearer auth header", async () => {
		const config = makeConfig({
			gmailPubsubAudience: "https://webhooks.example.com",
		});
		const result = await verifyAuthHeader(
			"Basic dXNlcjpwYXNz",
			config,
			passingVerifier,
			logger,
		);
		expect(result).toBe(false);
	});

	it("rejects invalid JWT token", async () => {
		const config = makeConfig({
			gmailPubsubAudience: "https://webhooks.example.com",
		});
		const result = await verifyAuthHeader(
			"Bearer fake-token",
			config,
			failingVerifier,
			logger,
		);
		expect(result).toBe(false);
	});

	it("accepts valid JWT token", async () => {
		const config = makeConfig({
			gmailPubsubAudience: "https://webhooks.example.com",
		});
		const result = await verifyAuthHeader(
			"Bearer valid-token",
			config,
			passingVerifier,
			logger,
		);
		expect(result).toBe(true);
	});

	it("skips auth when audience is not set", async () => {
		const config = makeConfig({ gmailPubsubAudience: "" });
		const result = await verifyAuthHeader(
			undefined,
			config,
			failingVerifier,
			logger,
		);
		expect(result).toBe(true);
	});

	it("rejects empty bearer token", async () => {
		const config = makeConfig({
			gmailPubsubAudience: "https://webhooks.example.com",
		});
		const result = await verifyAuthHeader(
			"Bearer ",
			config,
			failingVerifier,
			logger,
		);
		expect(result).toBe(false);
	});
});

describe("Gmail Webhook", () => {
	it("forwards valid email notification", async () => {
		const config = makeConfig();
		const body = gmailBody("user@test.com", "99999");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toEqual({
			email_address: "user@test.com",
			history_id: "99999",
			message_id: "msg-1",
		});
	});

	it("returns 401 when auth fails", async () => {
		const config = makeConfig({
			gmailPubsubAudience: "https://webhooks.example.com",
		});
		const body = gmailBody();
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			failingVerifier,
			logger,
		);
		expect(result.status).toBe(401);
		expect(result.payload).toBeUndefined();
	});

	it("handles invalid base64 data gracefully", async () => {
		const config = makeConfig();
		const body = {
			message: { data: "not-valid!!!", messageId: "msg-2" },
			subscription: "projects/test/subscriptions/push",
		};
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeUndefined();
	});

	it("handles non-JSON base64 data gracefully", async () => {
		const config = makeConfig();
		const body = {
			message: {
				data: Buffer.from("not json").toString("base64"),
				messageId: "msg-3",
			},
			subscription: "projects/test/subscriptions/push",
		};
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
		);
		// "not json" is technically valid base64-decodable but not JSON
		expect(result.status).toBe(200);
	});

	it("defaults missing fields to unknown", async () => {
		const config = makeConfig();
		const data = JSON.stringify({});
		const body = {
			message: {
				data: Buffer.from(data).toString("base64"),
				messageId: "msg-4",
			},
			subscription: "projects/test/subscriptions/push",
		};
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
		);
		expect(result.status).toBe(200);
		expect(result.payload?.email_address).toBe("unknown");
		expect(result.payload?.history_id).toBe("unknown");
	});
});
