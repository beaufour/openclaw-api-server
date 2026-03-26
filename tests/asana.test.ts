import { createHmac } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
	getSecret,
	handleAsanaWebhook,
	loadSecrets,
	saveSecret,
	verifySignature,
} from "../src/handlers/asana.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("test-asana");
const ASANA_SECRET = "test-asana-secret-12345";

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		asanaWebhookSecret: "",
		stravaVerifyToken: "",
		stravaWebhookSecret: "",
		gmailPubsubAudience: "",
		dataDir: "/tmp/test-asana-data",
		...overrides,
	};
}

function sign(body: string, secret = ASANA_SECRET): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

function eventsBody(events?: Array<Record<string, unknown>>): string {
	const e = events ?? [
		{ action: "changed", resource: { gid: "123", resource_type: "task" } },
	];
	return JSON.stringify({ events: e });
}

describe("Asana Signature Verification", () => {
	it("accepts valid signature", () => {
		const body = eventsBody();
		const sig = sign(body);
		expect(verifySignature(body, sig, ASANA_SECRET)).toBe(true);
	});

	it("rejects invalid signature", () => {
		const body = eventsBody();
		expect(verifySignature(body, "deadbeef".repeat(8), ASANA_SECRET)).toBe(
			false,
		);
	});

	it("rejects signature from wrong secret", () => {
		const body = eventsBody();
		const sig = sign(body, "wrong-secret");
		expect(verifySignature(body, sig, ASANA_SECRET)).toBe(false);
	});

	it("validates against exact body bytes", () => {
		const body = '{"events":[{"action":"changed"}]}';
		const sig = sign(body);
		expect(verifySignature(body, sig, ASANA_SECRET)).toBe(true);

		// Same logical JSON but different bytes should fail
		const reformatted = '{"events": [{"action": "changed"}]}';
		expect(verifySignature(reformatted, sig, ASANA_SECRET)).toBe(false);
	});
});

describe("Asana Handshake", () => {
	it("echoes X-Hook-Secret", () => {
		const config = makeConfig();
		const result = handleAsanaWebhook(
			"",
			"new-secret-abc",
			undefined,
			config,
			logger,
		);
		expect(result.status).toBe(200);
		expect(result.headers?.["X-Hook-Secret"]).toBe("new-secret-abc");
	});

	it("persists secret to disk", () => {
		const dataDir = `/tmp/test-asana-persist-${Date.now()}`;
		const config = makeConfig({ dataDir });
		try {
			handleAsanaWebhook("", "persisted-secret", undefined, config, logger);
			const secrets = loadSecrets(config);
			expect(secrets.default).toBe("persisted-secret");
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

describe("Asana Secret Persistence", () => {
	const dataDir = `/tmp/test-asana-secrets-${Date.now()}`;
	const config = makeConfig({ dataDir });

	beforeEach(() => {
		mkdirSync(dataDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("returns empty when no secrets file exists", () => {
		const secrets = loadSecrets(config);
		expect(secrets).toEqual({});
	});

	it("saves and loads secrets", () => {
		saveSecret("default", "my-secret", config, logger);
		const secrets = loadSecrets(config);
		expect(secrets.default).toBe("my-secret");
	});

	it("prefers env var over persisted secret", () => {
		const configWithEnv = makeConfig({
			dataDir,
			asanaWebhookSecret: "env-secret",
		});
		saveSecret("default", "persisted-secret", configWithEnv, logger);
		expect(getSecret(configWithEnv)).toBe("env-secret");
	});

	it("falls back to persisted secret when env var empty", () => {
		saveSecret("default", "persisted-secret", config, logger);
		expect(getSecret(config)).toBe("persisted-secret");
	});
});

describe("Asana Webhook Events", () => {
	it("rejects missing signature", () => {
		const config = makeConfig({ asanaWebhookSecret: ASANA_SECRET });
		const body = eventsBody();
		const result = handleAsanaWebhook(
			body,
			undefined,
			undefined,
			config,
			logger,
		);
		expect(result.status).toBe(401);
	});

	it("rejects invalid signature", () => {
		const config = makeConfig({ asanaWebhookSecret: ASANA_SECRET });
		const body = eventsBody();
		const result = handleAsanaWebhook(
			body,
			undefined,
			"deadbeef".repeat(8),
			config,
			logger,
		);
		expect(result.status).toBe(401);
	});

	it("accepts valid signature and forwards events", () => {
		const config = makeConfig({ asanaWebhookSecret: ASANA_SECRET });
		const body = eventsBody();
		const sig = sign(body);
		const result = handleAsanaWebhook(body, undefined, sig, config, logger);
		expect(result.status).toBe(200);
		expect(result.payload?.events).toHaveLength(1);
	});

	it("returns 500 when no secret available", () => {
		const config = makeConfig({
			dataDir: `/tmp/test-asana-empty-${Date.now()}`,
		});
		const body = eventsBody();
		const result = handleAsanaWebhook(
			body,
			undefined,
			"some-sig",
			config,
			logger,
		);
		expect(result.status).toBe(500);
	});

	it("acknowledges heartbeat without forwarding", () => {
		const config = makeConfig({ asanaWebhookSecret: ASANA_SECRET });
		const body = JSON.stringify({ events: [] });
		const sig = sign(body);
		const result = handleAsanaWebhook(body, undefined, sig, config, logger);
		expect(result.status).toBe(200);
		expect(result.payload).toBeUndefined();
	});

	it("forwards multiple events", () => {
		const config = makeConfig({ asanaWebhookSecret: ASANA_SECRET });
		const events = [
			{ action: "changed", resource: { gid: "1" } },
			{ action: "added", resource: { gid: "2" } },
			{ action: "removed", resource: { gid: "3" } },
		];
		const body = eventsBody(events);
		const sig = sign(body);
		const result = handleAsanaWebhook(body, undefined, sig, config, logger);
		expect(result.status).toBe(200);
		expect(result.payload?.events).toHaveLength(3);
	});
});
