import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { StravaEvent } from "../src/handlers/strava.js";
import {
	handleStravaValidation,
	handleStravaWebhook,
	validatePathSecret,
} from "../src/handlers/strava.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("test-strava");
const STRAVA_SECRET = "my-strava-secret-xyz";
const STRAVA_VERIFY_TOKEN = "my-verify-token";

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		asanaWebhookSecret: "",
		stravaVerifyToken: STRAVA_VERIFY_TOKEN,
		stravaWebhookSecret: STRAVA_SECRET,
		gmailPubsubAudience: "",
		dataDir: "/tmp/test-data",
		...overrides,
	};
}

function stravaEvent(overrides: Partial<StravaEvent> = {}): StravaEvent {
	return {
		object_type: "activity",
		object_id: 12345,
		aspect_type: "create",
		owner_id: 67890,
		subscription_id: 999,
		event_time: 1234567890,
		...overrides,
	};
}

describe("Strava Path Secret", () => {
	it("rejects wrong path secret", () => {
		const config = makeConfig();
		expect(validatePathSecret("wrong-secret", config, logger)).toBe(false);
	});

	it("accepts correct path secret", () => {
		const config = makeConfig();
		expect(validatePathSecret(STRAVA_SECRET, config, logger)).toBe(true);
	});

	it("skips validation when secret not set", () => {
		const config = makeConfig({ stravaWebhookSecret: "" });
		expect(validatePathSecret("anything-goes", config, logger)).toBe(true);
	});

	it("returns 404 for wrong secret on event (not 401)", () => {
		const config = makeConfig();
		const result = handleStravaWebhook(
			"wrong-secret",
			stravaEvent(),
			config,
			logger,
		);
		expect(result.status).toBe(404);
		expect(result.payload).toBeUndefined();
	});

	it("returns 404 for wrong secret on validation", () => {
		const config = makeConfig();
		const result = handleStravaValidation(
			"wrong-secret",
			"subscribe",
			"challenge-123",
			STRAVA_VERIFY_TOKEN,
			config,
			logger,
		);
		expect(result.status).toBe(404);
	});
});

describe("Strava Verify Token", () => {
	it("rejects wrong verify token", () => {
		const config = makeConfig();
		const result = handleStravaValidation(
			STRAVA_SECRET,
			"subscribe",
			"challenge-123",
			"wrong-token",
			config,
			logger,
		);
		expect(result.status).toBe(403);
	});

	it("accepts correct verify token and returns challenge", () => {
		const config = makeConfig();
		const result = handleStravaValidation(
			STRAVA_SECRET,
			"subscribe",
			"challenge-123",
			STRAVA_VERIFY_TOKEN,
			config,
			logger,
		);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ "hub.challenge": "challenge-123" });
	});

	it("rejects wrong hub.mode", () => {
		const config = makeConfig();
		const result = handleStravaValidation(
			STRAVA_SECRET,
			"unsubscribe",
			"challenge-123",
			STRAVA_VERIFY_TOKEN,
			config,
			logger,
		);
		expect(result.status).toBe(400);
	});
});

describe("Strava Webhook Events", () => {
	it("forwards activity event", () => {
		const config = makeConfig();
		const event = stravaEvent();
		const result = handleStravaWebhook(STRAVA_SECRET, event, config, logger);
		expect(result.status).toBe(200);
		expect(result.payload).toEqual(event);
	});

	it("forwards athlete event", () => {
		const config = makeConfig();
		const event = stravaEvent({
			object_type: "athlete",
			aspect_type: "update",
		});
		const result = handleStravaWebhook(STRAVA_SECRET, event, config, logger);
		expect(result.status).toBe(200);
		expect(result.payload?.object_type).toBe("athlete");
	});

	it("preserves full event payload", () => {
		const config = makeConfig();
		const event = stravaEvent({ object_id: 99999, owner_id: 11111 });
		const result = handleStravaWebhook(STRAVA_SECRET, event, config, logger);
		expect(result.payload?.object_id).toBe(99999);
		expect(result.payload?.owner_id).toBe(11111);
	});
});
