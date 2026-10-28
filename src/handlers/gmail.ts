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
import { authenticatedSenderIdentity, checkSenderAuth } from "./dkim.js";

/** Gmail labels the gate applies. The agent processes only LABEL_APPROVED. */
export const LABEL_APPROVED = "approved";
export const LABEL_REJECTED = "rejected";

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
	verify(
		token: string,
		audience: string,
	): Promise<{ email?: string; emailVerified?: boolean }>;
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
	/** Fetch one exact Gmail message by API id, including admission metadata. */
	fetchMessageById?(messageId: string): Promise<EmailHeaders | null>;
	/**
	 * Archive a message (remove it from the inbox) so a later agent run won't
	 * sweep it up via "in:inbox is:unread". Optional: requires gmail.modify
	 * scope. Returns true on success. Used to defuse rejected mail in enforce
	 * mode without ever waking the agent on it.
	 */
	archiveMessage?(messageId: string): Promise<boolean>;
	/** List every unread INBOX message with its From + trusted Auth-Results. */
	listUnreadInbox?(max?: number): Promise<EmailHeaders[]>;
	/**
	 * List only messages genuinely ADDED to the inbox since the last call
	 * (Gmail history API + a persisted watermark), so the agent's own
	 * archive/label/reply churn doesn't re-trigger processing. Falls back to a
	 * full sweep on cold start / expired watermark. Preferred over listUnreadInbox.
	 */
	listNewInboxMessages?(): Promise<EmailHeaders[]>;
	/**
	 * Apply a label to a message (creating the label if needed), optionally
	 * archiving it too. Requires gmail.modify. This is how the gate marks mail
	 * "approved"/"rejected" so the agent processes only positively-vetted mail.
	 */
	labelMessage?(
		messageId: string,
		labelName: string,
		alsoArchive?: boolean,
		removeLabelNames?: string[],
	): Promise<boolean>;
	/** Verify that a reply references an exact Sent message and sender was To/Cc. */
	verifySentReplyChain?(
		message: EmailHeaders,
		senderEmail: string,
	): Promise<boolean>;
}

export interface EmailHeaders {
	from: string;
	authenticationResults: string;
	/** Delegated senders (such as Drive) identify the initiator in Reply-To. */
	replyTo?: string;
	/** Raw DKIM signatures used to prove identity headers were signed. */
	dkimSignatures?: string[];
	/** True only when there is exactly one From and one Reply-To header. */
	identityHeadersUnique?: boolean;
	/** True only when Gmail returned exactly one From header. */
	fromHeaderUnique?: boolean;
	/** Gmail-trusted metadata used to verify a real reply, never a forward. */
	threadId?: string;
	inReplyTo?: string;
	references?: string;
	/** Gmail message id of the inspected message, for archiving on reject. */
	messageId?: string;
}

async function isAuthenticatedSentThreadReply(
	message: EmailHeaders,
	fetcher: EmailHeadersFetcher,
	logger: Logger,
): Promise<boolean> {
	if (
		message.fromHeaderUnique !== true ||
		!message.messageId ||
		!fetcher.verifySentReplyChain
	) {
		return false;
	}
	const identity = authenticatedSenderIdentity(
		message.authenticationResults,
		message.from,
		message.dkimSignatures ?? [],
	);
	if (!identity) {
		logger.info(
			"Reply-chain admission denied: sender identity not authenticated",
			{
				from: message.from,
				message_id: message.messageId,
			},
		);
		return false;
	}
	const verified = await fetcher.verifySentReplyChain(message, identity.email);
	if (verified) {
		logger.info("Reply-chain admission verified", {
			from: identity.email,
			message_id: message.messageId,
		});
	}
	return verified;
}

export type GmailAdmissionDecision = "approved" | "rejected" | "label-error";

/** Evaluate and atomically relabel one exact message under the gate policy. */
export async function vetAndLabelGmailMessage(
	message: EmailHeaders,
	config: Config,
	fetcher: EmailHeadersFetcher,
	logger: Logger,
): Promise<GmailAdmissionDecision> {
	if (!message.messageId || !fetcher.labelMessage) return "label-error";
	let ok = checkSenderAuth(
		message.authenticationResults,
		message.from,
		config.gmailRequireDkim,
		config.gmailSenderAllowlist,
		logger,
		{
			replyToHeader: message.replyTo,
			dkimSignatures: message.dkimSignatures,
			identityHeadersUnique: message.identityHeadersUnique,
		},
	);
	if (!ok) {
		ok = await isAuthenticatedSentThreadReply(message, fetcher, logger);
	}

	const label = ok ? LABEL_APPROVED : LABEL_REJECTED;
	const remove = ok ? [LABEL_REJECTED] : [LABEL_APPROVED];
	const archive = !ok && config.gmailDkimMode === "enforce";
	const applied = await fetcher.labelMessage(
		message.messageId,
		label,
		archive,
		remove,
	);
	if (!applied) return "label-error";
	logger.info(ok ? "Approved message for processing" : "Rejected message", {
		from: message.from,
		message_id: message.messageId,
		...(ok ? {} : { archived: archive }),
	});
	return ok ? "approved" : "rejected";
}

/** Local/operator-only exact-message replay. No public HTTP route calls this. */
export async function reprocessGmailMessage(
	messageId: string,
	config: Config,
	fetcher: EmailHeadersFetcher,
	logger: Logger,
): Promise<GmailAdmissionDecision> {
	if (!fetcher.fetchMessageById) return "label-error";
	const message = await fetcher.fetchMessageById(messageId);
	if (!message) return "label-error";
	return vetAndLabelGmailMessage(message, config, fetcher, logger);
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
			if (
				config.gmailPubsubServiceAccount &&
				(claim.emailVerified !== true ||
					claim.email?.toLowerCase() !== config.gmailPubsubServiceAccount)
			) {
				logger.warn("Pub/Sub token service account mismatch", {
					email: claim.email,
				});
				return false;
			}
			if (!config.gmailPubsubServiceAccount) {
				logger.warn(
					"GMAIL_PUBSUB_SERVICE_ACCOUNT not set; token issuer identity is not pinned",
				);
			}
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

	// Preferred model: positively vet inbox messages and label them
	// "approved"/"rejected". The agent processes only "approved" mail, so an
	// email the gate never saw (router down, missed push) is never approved and
	// never processed — fail closed. Requires a label-capable fetcher (gmail.modify).
	//
	// Prefer listNewInboxMessages (history-filtered: only mail genuinely added to
	// the inbox since last time) so the agent's own archive/label/reply churn
	// doesn't re-trigger us. Fall back to the full unread-inbox sweep otherwise.
	if (
		config.gmailRequireDkim &&
		headersFetcher?.labelMessage &&
		(headersFetcher.listNewInboxMessages || headersFetcher.listUnreadInbox)
	) {
		const messages = headersFetcher.listNewInboxMessages
			? await headersFetcher.listNewInboxMessages()
			: // biome-ignore lint/style/noNonNullAssertion: guarded by the if above
				await headersFetcher.listUnreadInbox!();
		let approved = 0;
		let rejected = 0;
		for (const m of messages) {
			if (!m.messageId) continue;
			const decision = await vetAndLabelGmailMessage(
				m,
				config,
				headersFetcher,
				logger,
			);
			if (decision === "approved") approved++;
			if (decision === "rejected") rejected++;
			if (decision === "label-error") {
				logger.warn("Could not apply Gmail admission label", {
					message_id: m.messageId,
				});
			}
		}
		logger.info("Inbox vetting sweep complete", { approved, rejected });
		// Only wake the agent when there is newly-approved work for it.
		if (approved === 0) {
			return { status: 200 };
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

	// Legacy fallback: single newest message, wake-or-drop. Used when the
	// fetcher can't label (no gmail.modify) so the agent still relies on its
	// own prompt-level verification + the "in:inbox is:unread" sweep.
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

		let senderOk = checkSenderAuth(
			headers.authenticationResults,
			headers.from,
			config.gmailRequireDkim,
			config.gmailSenderAllowlist,
			logger,
			{
				replyToHeader: headers.replyTo,
				dkimSignatures: headers.dkimSignatures,
				identityHeadersUnique: headers.identityHeadersUnique,
			},
		);
		if (!senderOk) {
			senderOk = await isAuthenticatedSentThreadReply(
				headers,
				headersFetcher,
				logger,
			);
		}

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
