import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
	type EmailHeadersFetcher,
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
		gmailRequireDkim: false,
		// Fixture defaults to "enforce" so the DKIM drop tests below stay
		// meaningful; production loadConfig() defaults to "monitor".
		gmailDkimMode: "enforce",
		gmailSenderAllowlist: [],
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

describe("Gmail DKIM Integration", () => {
	const dkimFetcher: EmailHeadersFetcher = {
		fetchHeaders: async () => ({
			from: "boss@company.com",
			authenticationResults: "mx.google.com; dkim=pass header.d=company.com",
		}),
	};

	const dkimFailFetcher: EmailHeadersFetcher = {
		fetchHeaders: async () => ({
			from: "spammer@evil.com",
			authenticationResults: "mx.google.com; dkim=fail header.d=evil.com",
		}),
	};

	const nullFetcher: EmailHeadersFetcher = {
		fetchHeaders: async () => null,
	};

	it("forwards email when DKIM passes and sender is allowlisted", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailSenderAllowlist: [
				{ fromEmail: "boss@company.com", dkimDomain: "company.com" },
			],
		});
		const body = gmailBody("me@gmail.com", "100");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
			dkimFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeDefined();
	});

	it("drops email when DKIM fails", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailSenderAllowlist: [],
		});
		const body = gmailBody("me@gmail.com", "101");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
			dkimFailFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeUndefined();
	});

	it("drops email when sender not in allowlist", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailSenderAllowlist: [
				{ fromEmail: "other@company.com", dkimDomain: "company.com" },
			],
		});
		const body = gmailBody("me@gmail.com", "102");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
			dkimFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeUndefined();
	});

	it("drops email when headers cannot be fetched", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
		});
		const body = gmailBody("me@gmail.com", "103");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
			nullFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeUndefined();
	});

	it("allows email when DKIM passes and no allowlist configured", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailSenderAllowlist: [],
		});
		const body = gmailBody("me@gmail.com", "104");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
			dkimFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeDefined();
	});

	it("skips DKIM check when gmailRequireDkim is false", async () => {
		const config = makeConfig({
			gmailRequireDkim: false,
		});
		const body = gmailBody("me@gmail.com", "105");
		const result = await handleGmailWebhook(
			body,
			undefined,
			config,
			passingVerifier,
			logger,
			dkimFailFetcher, // would fail if checked
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeDefined();
	});
});

describe("Gmail DKIM monitor mode", () => {
	const dkimFailFetcher: EmailHeadersFetcher = {
		fetchHeaders: async () => ({
			from: "spammer@evil.com",
			authenticationResults: "mx.google.com; dkim=fail header.d=evil.com",
		}),
	};
	const nullFetcher: EmailHeadersFetcher = { fetchHeaders: async () => null };

	it("wakes the agent even when DKIM fails (monitor)", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "monitor",
			gmailSenderAllowlist: [],
		});
		const result = await handleGmailWebhook(
			gmailBody("me@gmail.com", "200"),
			undefined,
			config,
			passingVerifier,
			logger,
			dkimFailFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeDefined();
	});

	it("wakes the agent when headers cannot be fetched (monitor fails open)", async () => {
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "monitor",
		});
		const result = await handleGmailWebhook(
			gmailBody("me@gmail.com", "201"),
			undefined,
			config,
			passingVerifier,
			logger,
			nullFetcher,
		);
		expect(result.status).toBe(200);
		expect(result.payload).toBeDefined();
		expect(result.payload?.history_id).toBe("201");
	});
});

describe("Gmail DKIM archive-on-reject", () => {
	function spyFetcher(): {
		fetcher: EmailHeadersFetcher;
		archived: string[];
	} {
		const archived: string[] = [];
		const fetcher: EmailHeadersFetcher = {
			fetchHeaders: async () => ({
				from: "spammer@evil.com",
				authenticationResults: "mx.google.com; dkim=fail header.d=evil.com",
				messageId: "MSG123",
			}),
			archiveMessage: async (id: string) => {
				archived.push(id);
				return true;
			},
		};
		return { fetcher, archived };
	}

	it("archives the rejected message in enforce mode", async () => {
		const { fetcher, archived } = spyFetcher();
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "enforce",
			gmailSenderAllowlist: [],
		});
		const result = await handleGmailWebhook(
			gmailBody("me@gmail.com", "300"),
			undefined,
			config,
			passingVerifier,
			logger,
			fetcher,
		);
		expect(result.payload).toBeUndefined(); // not woken
		expect(archived).toEqual(["MSG123"]); // but archived out of inbox
	});

	it("does NOT archive in monitor mode (wakes the agent instead)", async () => {
		const { fetcher, archived } = spyFetcher();
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "monitor",
			gmailSenderAllowlist: [],
		});
		const result = await handleGmailWebhook(
			gmailBody("me@gmail.com", "301"),
			undefined,
			config,
			passingVerifier,
			logger,
			fetcher,
		);
		expect(result.payload).toBeDefined();
		expect(archived).toEqual([]);
	});
});

describe("Gmail approved-gate sweep", () => {
	const APPROVED = {
		from: "Allan <allan@beaufour.dk>",
		authenticationResults: "mx.google.com; dkim=pass header.i=@beaufour.dk",
		messageId: "OK1",
	};
	const REJECTED = {
		from: "evil@phisher.com",
		authenticationResults: "mx.google.com; dkim=fail header.d=phisher.com",
		messageId: "BAD1",
	};
	const allowlist = [
		{ fromEmail: "allan@beaufour.dk", dkimDomain: "beaufour.dk" },
	];

	function sweepFetcher(messages: (typeof APPROVED)[]): {
		fetcher: EmailHeadersFetcher;
		labels: Array<{ id: string; label: string; archive: boolean }>;
	} {
		const labels: Array<{ id: string; label: string; archive: boolean }> = [];
		const fetcher: EmailHeadersFetcher = {
			fetchHeaders: async () => null,
			listUnreadInbox: async () => messages,
			labelMessage: async (id, label, archive = false) => {
				labels.push({ id, label, archive });
				return true;
			},
		};
		return { fetcher, labels };
	}

	it("approves vetted mail, rejects+archives the rest, wakes once (enforce)", async () => {
		const { fetcher, labels } = sweepFetcher([APPROVED, REJECTED]);
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "enforce",
			gmailSenderAllowlist: allowlist,
		});
		const result = await handleGmailWebhook(
			gmailBody("me@gmail.com", "400"),
			undefined,
			config,
			passingVerifier,
			logger,
			fetcher,
		);
		expect(labels).toEqual([
			{ id: "OK1", label: "approved", archive: false },
			{ id: "BAD1", label: "rejected", archive: true },
		]);
		expect(result.payload).toBeDefined(); // woke because something was approved
	});

	it("does NOT wake when nothing is approved", async () => {
		const { fetcher, labels } = sweepFetcher([REJECTED]);
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "enforce",
			gmailSenderAllowlist: allowlist,
		});
		const result = await handleGmailWebhook(
			gmailBody("me@gmail.com", "401"),
			undefined,
			config,
			passingVerifier,
			logger,
			fetcher,
		);
		expect(result.payload).toBeUndefined();
		expect(labels).toEqual([{ id: "BAD1", label: "rejected", archive: true }]);
	});

	it("labels rejected without archiving in monitor mode", async () => {
		const { fetcher, labels } = sweepFetcher([REJECTED]);
		const config = makeConfig({
			gmailRequireDkim: true,
			gmailDkimMode: "monitor",
			gmailSenderAllowlist: allowlist,
		});
		await handleGmailWebhook(
			gmailBody("me@gmail.com", "402"),
			undefined,
			config,
			passingVerifier,
			logger,
			fetcher,
		);
		expect(labels).toEqual([{ id: "BAD1", label: "rejected", archive: false }]);
	});
});
