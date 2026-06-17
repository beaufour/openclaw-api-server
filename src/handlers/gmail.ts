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
 * Auth layers:
 * 1. OIDC JWT token from Pub/Sub (validates the push notification is from Google)
 * 2. DKIM verification (validates the email sender via Gmail's Authentication-Results)
 * 3. Sender allowlist (restricts which From + DKIM domain pairs trigger agent actions)
 *
 * For DKIM, we don't re-verify signatures ourselves — Gmail already did that.
 * We fetch the email headers via an EmailHeadersFetcher and check what Gmail computed.
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { checkSenderAuth } from "./dkim.js";

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

/**
 * Interface for fetching email headers from Gmail API.
 * The implementation should use the Gmail API to retrieve
 * the email's From and Authentication-Results headers.
 */
export interface EmailHeadersFetcher {
	fetchHeaders(
		emailAddress: string,
		historyId: string,
	): Promise<EmailHeaders | null>;
	/**
	 * Archive a message (remove it from the inbox) so a later agent run won't
	 * sweep it up via "in:inbox is:unread". Optional: requires gmail.modify
	 * scope. Returns true on success. Used to defuse rejected mail in enforce
	 * mode without ever waking the agent on it.
	 */
	archiveMessage?(messageId: string): Promise<boolean>;
}

export interface EmailHeaders {
	from: string;
	authenticationResults: string;
	/** Gmail message id of the inspected message, for archiving on reject. */
	messageId?: string;
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
	headersFetcher?: EmailHeadersFetcher,
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

	// DKIM verification + sender allowlist check
	if (config.gmailRequireDkim && headersFetcher) {
		const headers = await headersFetcher.fetchHeaders(emailAddress, historyId);

		if (!headers) {
			// Couldn't resolve the message (transient API error, or the agent
			// already archived it). Fail open in monitor mode so we never drop a
			// wake on an unverifiable fetch; only enforce mode treats this as a drop.
			if (config.gmailDkimMode === "enforce") {
				logger.warn(
					"Could not fetch email headers for DKIM check, dropping (enforce)",
					{ history_id: historyId },
				);
				return { status: 200 };
			}
			logger.warn(
				"Could not fetch email headers for DKIM check — waking anyway (monitor)",
				{ history_id: historyId },
			);
			return {
				status: 200,
				payload: {
					email_address: emailAddress,
					history_id: historyId,
					message_id: body.message?.messageId,
				},
			};
		}

		const senderOk = checkSenderAuth(
			headers.authenticationResults,
			headers.from,
			config.gmailRequireDkim,
			config.gmailSenderAllowlist,
			logger,
		);

		if (!senderOk) {
			if (config.gmailDkimMode === "enforce") {
				logger.info("Email rejected by DKIM/allowlist check (enforce)", {
					history_id: historyId,
					from: headers.from,
				});
				// Archive the rejected message so a later (legitimate) agent wake
				// doesn't discover it via "in:inbox is:unread" and process it. Best
				// effort — requires gmail.modify scope; logged either way.
				if (headers.messageId && headersFetcher.archiveMessage) {
					const archived = await headersFetcher.archiveMessage(
						headers.messageId,
					);
					logger.info(
						archived
							? "Archived rejected message out of inbox"
							: "Could not archive rejected message (needs gmail.modify scope?)",
						{ history_id: historyId, message_id: headers.messageId },
					);
				}
				return { status: 200 };
			}
			// monitor mode: surface the verdict but still wake the agent.
			logger.warn(
				"DKIM/allowlist check FAILED but monitor mode is on — waking anyway",
				{ history_id: historyId, from: headers.from },
			);
		} else {
			logger.info("DKIM/allowlist check passed", {
				history_id: historyId,
				from: headers.from,
			});
		}
	} else if (config.gmailRequireDkim && !headersFetcher) {
		logger.warn(
			"GMAIL_REQUIRE_DKIM is true but no EmailHeadersFetcher configured, skipping DKIM check",
		);
	}

	return {
		status: 200,
		payload: {
			email_address: emailAddress,
			history_id: historyId,
			message_id: body.message?.messageId,
		},
	};
}
