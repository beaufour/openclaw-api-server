/**
 * Strava webhook handler.
 *
 * Strava webhooks have two phases:
 * 1. Validation: GET with hub.verify_token, hub.challenge, hub.mode
 * 2. Events: POST with JSON body containing activity/athlete event data
 *
 * Auth: Strava does NOT sign webhook payloads. We use a secret token in the
 * URL path as the only defense. The webhook callback URL should be registered as:
 *   https://webhooks.yourdomain.com/webhook/strava/<STRAVA_WEBHOOK_SECRET>
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface StravaEvent {
	object_type: string;
	object_id: number;
	aspect_type: string;
	owner_id: number;
	subscription_id: number;
	event_time: number;
	[key: string]: unknown;
}

export interface StravaHandlerResult {
	status: number;
	body?: unknown;
	payload?: StravaEvent;
}

export function validatePathSecret(
	pathSecret: string,
	config: Config,
	logger: Logger,
): boolean {
	if (!config.stravaWebhookSecret) {
		logger.warn(
			"STRAVA_WEBHOOK_SECRET not set, skipping path secret validation",
		);
		return true;
	}
	return pathSecret === config.stravaWebhookSecret;
}

export function handleStravaValidation(
	pathSecret: string,
	hubMode: string,
	hubChallenge: string,
	hubVerifyToken: string,
	config: Config,
	logger: Logger,
): StravaHandlerResult {
	if (!validatePathSecret(pathSecret, config, logger)) {
		logger.warn("Strava path secret mismatch on validation request");
		return { status: 404 };
	}

	if (hubMode !== "subscribe") {
		logger.warn("Unexpected hub.mode", { hub_mode: hubMode });
		return { status: 400 };
	}

	if (config.stravaVerifyToken && hubVerifyToken !== config.stravaVerifyToken) {
		logger.warn("Strava verify token mismatch");
		return { status: 403 };
	}

	logger.info("Strava webhook validation successful");
	return { status: 200, body: { "hub.challenge": hubChallenge } };
}

export function handleStravaWebhook(
	pathSecret: string,
	body: StravaEvent,
	config: Config,
	logger: Logger,
): StravaHandlerResult {
	if (!validatePathSecret(pathSecret, config, logger)) {
		logger.warn("Strava path secret mismatch on event delivery");
		return { status: 404 };
	}

	logger.info("Strava event received", {
		aspect_type: body.aspect_type,
		object_type: body.object_type,
		object_id: body.object_id,
		owner_id: body.owner_id,
	});

	return { status: 200, payload: body };
}
