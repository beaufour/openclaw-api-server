/**
 * Gmail Pub/Sub push notification handler.
 *
 * Google Cloud Pub/Sub sends POST requests with a JSON body containing:
 * {
 *   "message": {
 *     "data": "<base64-encoded>",  // contains {"emailAddress": "...", "historyId": "..."}
 *     "messageId": "...",
 *     "publishTime": "..."
 *   },
 *   "subscription": "projects/.../subscriptions/..."
 * }
 *
 * Auth: Pub/Sub push subscriptions can be configured with an OIDC token.
 * When enabled, Pub/Sub sends a JWT bearer token in the Authorization header.
 * We validate the token using Google's public keys.
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface GmailPubSubMessage {
	message: {
		data: string;
		messageId?: string;
		publishTime?: string;
	};
	subscription: string;
}

export interface GmailNotification {
	emailAddress: string;
	historyId: string;
}

export interface GmailHandlerResult {
	status: number;
	payload?: {
		email_address: string;
		history_id: string;
		message_id?: string;
	};
}

export interface JwtVerifier {
	verify(token: string, audience: string): Promise<{ email?: string }>;
}

export function verifyAuthHeader(
	authHeader: string | undefined,
	config: Config,
	verifier: JwtVerifier,
	logger: Logger,
): Promise<boolean> {
	if (!config.gmailPubsubAudience) {
		logger.warn("GMAIL_PUBSUB_AUDIENCE not set, skipping token validation");
		return Promise.resolve(true);
	}

	if (!authHeader?.startsWith("Bearer ")) {
		logger.warn("Missing or invalid Authorization header");
		return Promise.resolve(false);
	}

	const token = authHeader.slice(7);
	return verifier
		.verify(token, config.gmailPubsubAudience)
		.then((claim) => {
			logger.debug("Pub/Sub token verified", { email: claim.email });
			return true;
		})
		.catch(() => {
			logger.warn("Invalid JWT token from Pub/Sub");
			return false;
		});
}

export async function handleGmailWebhook(
	body: GmailPubSubMessage,
	authHeader: string | undefined,
	config: Config,
	verifier: JwtVerifier,
	logger: Logger,
): Promise<GmailHandlerResult> {
	logger.debug("Received Gmail webhook request");

	const authorized = await verifyAuthHeader(
		authHeader,
		config,
		verifier,
		logger,
	);
	if (!authorized) {
		logger.error("Gmail webhook auth failed");
		return { status: 401 };
	}

	const dataB64 = body.message?.data ?? "";
	let data: GmailNotification;
	try {
		const decoded = Buffer.from(dataB64, "base64").toString("utf-8");
		data = JSON.parse(decoded) as GmailNotification;
	} catch {
		logger.error("Failed to decode Gmail Pub/Sub message data");
		return { status: 200 };
	}

	const emailAddress = data.emailAddress ?? "unknown";
	const historyId = data.historyId ?? "unknown";
	logger.info("Gmail notification received", {
		email: emailAddress,
		history_id: historyId,
	});

	return {
		status: 200,
		payload: {
			email_address: emailAddress,
			history_id: historyId,
			message_id: body.message?.messageId,
		},
	};
}
