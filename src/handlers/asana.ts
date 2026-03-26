/**
 * Asana webhook handler.
 *
 * Asana webhooks have two phases:
 * 1. Handshake: POST with X-Hook-Secret header, must echo it back with 200
 * 2. Events: POST with JSON body containing events array, signed with HMAC-SHA256
 *
 * Auth: Asana signs every event delivery with HMAC-SHA256 using the secret from
 * the handshake. We persist the secret to a file so it survives restarts.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface AsanaHandlerResult {
	status: number;
	headers?: Record<string, string>;
	payload?: { events: AsanaEvent[] };
}

export interface AsanaEvent {
	action: string;
	resource?: { gid?: string; resource_type?: string };
	[key: string]: unknown;
}

function secretsFilePath(config: Config): string {
	return join(config.dataDir, "asana_hook_secrets.json");
}

export function loadSecrets(config: Config): Record<string, string> {
	const path = secretsFilePath(config);
	if (existsSync(path)) {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
	}
	return {};
}

export function saveSecret(
	key: string,
	secret: string,
	config: Config,
	logger: Logger,
): void {
	const path = secretsFilePath(config);
	const secrets = loadSecrets(config);
	secrets[key] = secret;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(secrets));
	logger.info("Asana hook secret persisted", { path });
}

export function getSecret(config: Config): string {
	if (config.asanaWebhookSecret) {
		return config.asanaWebhookSecret;
	}
	const secrets = loadSecrets(config);
	return secrets.default ?? "";
}

export function verifySignature(
	body: string,
	signature: string,
	secret: string,
): boolean {
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	try {
		return timingSafeEqual(
			Buffer.from(expected, "hex"),
			Buffer.from(signature, "hex"),
		);
	} catch {
		return false;
	}
}

export function handleAsanaWebhook(
	bodyRaw: string,
	hookSecret: string | undefined,
	hookSignature: string | undefined,
	config: Config,
	logger: Logger,
): AsanaHandlerResult {
	// Phase 1: Handshake
	if (hookSecret) {
		logger.info("Asana webhook handshake received");
		saveSecret("default", hookSecret, config, logger);
		return {
			status: 200,
			headers: { "X-Hook-Secret": hookSecret },
		};
	}

	// Phase 2: Event delivery — require signature validation
	const secret = getSecret(config);

	if (!secret) {
		logger.error("No Asana webhook secret available, rejecting request");
		return { status: 500 };
	}

	if (!hookSignature) {
		logger.warn("Missing X-Hook-Signature header");
		return { status: 401 };
	}

	if (!verifySignature(bodyRaw, hookSignature, secret)) {
		logger.warn("Asana webhook signature mismatch");
		return { status: 401 };
	}

	logger.debug("Asana webhook signature validated");

	const body = JSON.parse(bodyRaw) as { events?: AsanaEvent[] };
	const events = body.events ?? [];

	if (events.length === 0) {
		logger.debug("Asana heartbeat acknowledged");
		return { status: 200 };
	}

	logger.info("Asana webhook events received", {
		event_count: events.length,
	});
	return { status: 200, payload: { events } };
}
