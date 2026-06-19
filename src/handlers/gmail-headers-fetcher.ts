/**
 * EmailHeadersFetcher implementation backed by the Gmail REST API.
 *
 * A Gmail Pub/Sub notification only carries { emailAddress, historyId }, and
 * the historyId is unreliable in practice (see prompts/gmail.md). So instead of
 * resolving the history, we fetch the newest INBOX message and return its
 * From + Authentication-Results headers. The handler then runs the DKIM/allowlist
 * check on that message to decide whether to wake the agent.
 *
 * SECURITY: a sender can inject their own forged `Authentication-Results` header
 * into the raw message. Gmail prepends its OWN trusted result at receipt, stamped
 * with an authserv-id (default "mx.google.com"). We therefore select only the
 * Authentication-Results header carrying the trusted authserv-id and ignore the
 * rest. If none is found we return an empty result, which fails the DKIM check
 * (fail closed) rather than trusting an attacker-supplied header.
 *
 * Auth mirrors renew-gmail-watch.sh: refresh an access token from the stored
 * OAuth credentials, then call the Gmail API. The token is cached until shortly
 * before expiry.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import type { EmailHeaders, EmailHeadersFetcher } from "./gmail.js";

interface OAuthCredentials {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}

interface GmailMessageHeader {
	name: string;
	value: string;
}

/** Minimal subset of the Gmail API responses we depend on. */
interface MessagesListResponse {
	messages?: Array<{ id: string }>;
}
interface MessageGetResponse {
	labelIds?: string[];
	payload?: { headers?: GmailMessageHeader[] };
}
interface LabelsListResponse {
	labels?: Array<{ id: string; name: string }>;
}
interface HistoryListResponse {
	history?: Array<{
		messagesAdded?: Array<{ message?: { id: string; labelIds?: string[] } }>;
	}>;
	historyId?: string;
	nextPageToken?: string;
}

export interface GmailHeadersFetcherOptions {
	dataDir: string;
	logger: Logger;
	/** authserv-id that identifies Gmail's own (trusted) Authentication-Results. */
	trustedAuthservId?: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchFn?: typeof fetch;
	/** Injectable clock for tests; returns epoch ms. */
	now?: () => number;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Pick Gmail's trusted Authentication-Results value from the header list,
 * ignoring any forged ones the sender may have injected. Matches the header
 * whose value carries the trusted authserv-id. Returns "" if none qualifies.
 */
export function selectTrustedAuthResults(
	headers: GmailMessageHeader[],
	trustedAuthservId: string,
): string {
	const needle = trustedAuthservId.toLowerCase();
	const candidates = headers.filter(
		(h) => h.name.toLowerCase() === "authentication-results",
	);
	for (const h of candidates) {
		if (h.value.toLowerCase().includes(needle)) {
			return h.value;
		}
	}
	return "";
}

function getHeader(headers: GmailMessageHeader[], name: string): string {
	const lower = name.toLowerCase();
	const match = headers.find((h) => h.name.toLowerCase() === lower);
	return match?.value ?? "";
}

export function createGmailHeadersFetcher(
	options: GmailHeadersFetcherOptions,
): EmailHeadersFetcher {
	const {
		dataDir,
		logger,
		trustedAuthservId = process.env.GMAIL_TRUSTED_AUTHSERV ?? "mx.google.com",
		fetchFn = fetch,
		now = () => Date.now(),
	} = options;

	const credsPath = join(dataDir, "gmail_oauth_credentials.json");

	let cachedToken: string | undefined;
	let tokenExpiresAt = 0;
	// name -> labelId cache, so we resolve/create each gate label only once.
	const labelIdCache = new Map<string, string>();

	function loadCredentials(): OAuthCredentials | null {
		try {
			const creds = JSON.parse(
				readFileSync(credsPath, "utf-8"),
			) as OAuthCredentials;
			if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
				logger.error("Gmail OAuth credentials file missing required fields");
				return null;
			}
			return creds;
		} catch {
			logger.error("Could not read Gmail OAuth credentials", {
				path: credsPath,
			});
			return null;
		}
	}

	async function getAccessToken(): Promise<string | null> {
		// Reuse the cached token until 60s before expiry.
		if (cachedToken && now() < tokenExpiresAt - 60_000) {
			return cachedToken;
		}

		const creds = loadCredentials();
		if (!creds) return null;

		const params = new URLSearchParams({
			client_id: creds.client_id,
			client_secret: creds.client_secret,
			refresh_token: creds.refresh_token,
			grant_type: "refresh_token",
		});

		try {
			const res = await fetchFn(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString(),
			});
			if (!res.ok) {
				logger.error("Gmail token refresh failed", { status: res.status });
				return null;
			}
			const json = (await res.json()) as {
				access_token?: string;
				expires_in?: number;
			};
			if (!json.access_token) {
				logger.error("Gmail token refresh returned no access_token");
				return null;
			}
			cachedToken = json.access_token;
			tokenExpiresAt = now() + (json.expires_in ?? 3600) * 1000;
			return cachedToken;
		} catch (err) {
			logger.error("Gmail token refresh threw", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	async function apiGet<T>(path: string, token: string): Promise<T | null> {
		try {
			const res = await fetchFn(`${GMAIL_API}${path}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) {
				logger.warn("Gmail API request failed", { path, status: res.status });
				return null;
			}
			return (await res.json()) as T;
		} catch (err) {
			logger.warn("Gmail API request threw", {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	async function apiPost<T>(
		path: string,
		token: string,
		body: unknown,
	): Promise<T | null> {
		try {
			const res = await fetchFn(`${GMAIL_API}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				logger.warn("Gmail API POST failed", { path, status: res.status });
				return null;
			}
			return (await res.json()) as T;
		} catch (err) {
			logger.warn("Gmail API POST threw", {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	/**
	 * Resolve a user label name to its id, creating the label if it doesn't
	 * exist. Cached. Returns null if the API call fails (e.g. missing scope).
	 */
	async function ensureLabel(
		token: string,
		name: string,
	): Promise<string | null> {
		const cached = labelIdCache.get(name);
		if (cached) return cached;

		const list = await apiGet<LabelsListResponse>("/labels", token);
		const existing = list?.labels?.find((l) => l.name === name);
		if (existing?.id) {
			labelIdCache.set(name, existing.id);
			return existing.id;
		}

		const created = await apiPost<{ id?: string }>("/labels", token, {
			name,
			labelListVisibility: "labelShow",
			messageListVisibility: "show",
		});
		if (created?.id) {
			labelIdCache.set(name, created.id);
			return created.id;
		}
		logger.warn("Could not resolve or create Gmail label", { name });
		return null;
	}

	// --- history watermark (persisted), so we only react to genuinely new mail ---
	const historyStatePath = join(dataDir, "gmail_history_state.json");

	function readWatermark(): string | undefined {
		try {
			const v = JSON.parse(readFileSync(historyStatePath, "utf-8"));
			return typeof v?.lastHistoryId === "string" ? v.lastHistoryId : undefined;
		} catch {
			return undefined;
		}
	}

	function writeWatermark(historyId: string): void {
		try {
			writeFileSync(
				historyStatePath,
				JSON.stringify({ lastHistoryId: historyId }),
			);
		} catch (err) {
			logger.warn("Could not persist Gmail history watermark", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async function currentHistoryId(token: string): Promise<string | undefined> {
		const profile = await apiGet<{ historyId?: string }>("/profile", token);
		return profile?.historyId;
	}

	async function listUnreadInboxIds(
		token: string,
		max = 50,
	): Promise<string[]> {
		const list = await apiGet<MessagesListResponse>(
			`/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${max}`,
			token,
		);
		return list?.messages?.map((m) => m.id) ?? [];
	}

	/** From + trusted Authentication-Results + current labelIds for one message. */
	async function fetchMessageMeta(
		token: string,
		messageId: string,
	): Promise<{
		from: string;
		authenticationResults: string;
		labelIds: string[];
	} | null> {
		const message = await apiGet<MessageGetResponse>(
			`/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Authentication-Results`,
			token,
		);
		const headers = message?.payload?.headers;
		if (!headers) return null;
		return {
			from: getHeader(headers, "From"),
			authenticationResults: selectTrustedAuthResults(
				headers,
				trustedAuthservId,
			),
			labelIds: message?.labelIds ?? [],
		};
	}

	/**
	 * Message ids added to INBOX since startHistoryId (genuinely new mail —
	 * NOT the agent's own SENT/label/archive churn). Returns "expired" on 404
	 * (watermark older than Gmail's ~1wk retention) so the caller can fall back
	 * to a full sweep, or null on a transient error (caller should not advance).
	 */
	async function inboxMessagesAddedSince(
		token: string,
		startHistoryId: string,
	): Promise<{ ids: string[]; historyId?: string } | "expired" | null> {
		const ids = new Set<string>();
		let pageToken: string | undefined;
		let latest: string | undefined;
		do {
			const url =
				`${GMAIL_API}/history?startHistoryId=${startHistoryId}` +
				`&historyTypes=messageAdded&labelId=INBOX&maxResults=100` +
				(pageToken ? `&pageToken=${pageToken}` : "");
			let res: Response;
			try {
				res = await fetchFn(url, {
					headers: { Authorization: `Bearer ${token}` },
				});
			} catch (err) {
				logger.warn("Gmail history.list threw", {
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			}
			if (res.status === 404) return "expired";
			if (!res.ok) {
				logger.warn("Gmail history.list failed", { status: res.status });
				return null;
			}
			const json = (await res.json()) as HistoryListResponse;
			latest = json.historyId ?? latest;
			for (const h of json.history ?? []) {
				for (const added of h.messagesAdded ?? []) {
					const m = added.message;
					if (m?.id && (m.labelIds ?? []).includes("INBOX")) ids.add(m.id);
				}
			}
			pageToken = json.nextPageToken;
		} while (pageToken);
		return { ids: [...ids], historyId: latest };
	}

	return {
		async fetchHeaders(
			_emailAddress: string,
			_historyId: string,
		): Promise<EmailHeaders | null> {
			const token = await getAccessToken();
			if (!token) return null;

			// Newest message in the inbox — the one that triggered the push. We
			// filter by the INBOX label (canonical) rather than a search query.
			// The agent archives messages after handling, so a quiet inbox is
			// empty; at webhook time the just-arrived message is still here.
			const list = await apiGet<MessagesListResponse>(
				"/messages?labelIds=INBOX&maxResults=1",
				token,
			);
			const messageId = list?.messages?.[0]?.id;
			if (!messageId) {
				logger.info("No unread inbox message found for notification");
				return null;
			}

			const message = await apiGet<MessageGetResponse>(
				`/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Authentication-Results`,
				token,
			);
			const headers = message?.payload?.headers;
			if (!headers) {
				logger.warn("Gmail message had no headers", { messageId });
				return null;
			}

			const from = getHeader(headers, "From");
			const authenticationResults = selectTrustedAuthResults(
				headers,
				trustedAuthservId,
			);
			if (!authenticationResults) {
				logger.warn(
					"No trusted Authentication-Results header found; failing closed",
					{ messageId, trustedAuthservId },
				);
			}

			return { from, authenticationResults, messageId };
		},

		async listUnreadInbox(max = 25): Promise<EmailHeaders[]> {
			const token = await getAccessToken();
			if (!token) return [];
			const list = await apiGet<MessagesListResponse>(
				`/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${max}`,
				token,
			);
			const ids = list?.messages?.map((m) => m.id) ?? [];
			const out: EmailHeaders[] = [];
			for (const messageId of ids) {
				const message = await apiGet<MessageGetResponse>(
					`/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Authentication-Results`,
					token,
				);
				const headers = message?.payload?.headers;
				if (!headers) continue;
				out.push({
					from: getHeader(headers, "From"),
					authenticationResults: selectTrustedAuthResults(
						headers,
						trustedAuthservId,
					),
					messageId,
				});
			}
			return out;
		},

		async listNewInboxMessages(): Promise<EmailHeaders[]> {
			const token = await getAccessToken();
			if (!token) return [];

			const watermark = readWatermark();
			let ids: string[];
			let newWatermark: string | undefined;

			if (!watermark) {
				// Cold start: baseline off the current unread inbox, then track history.
				logger.info("No Gmail history watermark — baseline inbox sweep");
				ids = await listUnreadInboxIds(token);
				newWatermark = await currentHistoryId(token);
			} else {
				const hist = await inboxMessagesAddedSince(token, watermark);
				if (hist === "expired") {
					logger.warn("Gmail history watermark expired — full inbox sweep", {
						watermark,
					});
					ids = await listUnreadInboxIds(token);
					newWatermark = await currentHistoryId(token);
				} else if (hist) {
					ids = hist.ids;
					newWatermark = hist.historyId;
				} else {
					// Transient error — don't advance the watermark, don't reprocess.
					return [];
				}
			}

			if (newWatermark) writeWatermark(newWatermark);

			const out: EmailHeaders[] = [];
			for (const messageId of ids) {
				const meta = await fetchMessageMeta(token, messageId);
				if (!meta) continue;
				// Skip anything no longer in the inbox (archived since it was added).
				if (!meta.labelIds.includes("INBOX")) continue;
				out.push({
					from: meta.from,
					authenticationResults: meta.authenticationResults,
					messageId,
				});
			}
			return out;
		},

		async labelMessage(
			messageId: string,
			labelName: string,
			alsoArchive = false,
		): Promise<boolean> {
			const token = await getAccessToken();
			if (!token) return false;
			const labelId = await ensureLabel(token, labelName);
			if (!labelId) return false;
			const removeLabelIds = alsoArchive ? ["INBOX", "UNREAD"] : [];
			const res = await apiPost(`/messages/${messageId}/modify`, token, {
				addLabelIds: [labelId],
				removeLabelIds,
			});
			return res !== null;
		},

		async archiveMessage(messageId: string): Promise<boolean> {
			const token = await getAccessToken();
			if (!token) return false;
			try {
				const res = await fetchFn(`${GMAIL_API}/messages/${messageId}/modify`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					// Removing INBOX archives it; removing UNREAD also clears the
					// "is:unread" the agent searches on. Needs gmail.modify scope.
					body: JSON.stringify({ removeLabelIds: ["INBOX", "UNREAD"] }),
				});
				if (!res.ok) {
					logger.warn("Gmail archive request failed", {
						messageId,
						status: res.status,
					});
					return false;
				}
				return true;
			} catch (err) {
				logger.warn("Gmail archive request threw", {
					messageId,
					error: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		},
	};
}
