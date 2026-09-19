import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";

interface OAuthCredentials {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}

export interface GmailWatchRenewalOptions {
	dataDir: string;
	topic: string;
	logger: Logger;
	fetchFn?: typeof fetch;
}

export async function renewGmailWatch(
	options: GmailWatchRenewalOptions,
): Promise<boolean> {
	const { dataDir, topic, logger, fetchFn = fetch } = options;
	let credentials: OAuthCredentials;
	try {
		credentials = JSON.parse(
			readFileSync(join(dataDir, "gmail_oauth_credentials.json"), "utf-8"),
		) as OAuthCredentials;
	} catch {
		logger.error("Could not read Gmail OAuth credentials for watch renewal");
		return false;
	}

	if (
		!credentials.client_id ||
		!credentials.client_secret ||
		!credentials.refresh_token
	) {
		logger.error("Gmail OAuth credentials are incomplete for watch renewal");
		return false;
	}

	try {
		const tokenResponse = await fetchFn("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: credentials.client_id,
				client_secret: credentials.client_secret,
				refresh_token: credentials.refresh_token,
				grant_type: "refresh_token",
			}).toString(),
		});
		if (!tokenResponse.ok) {
			logger.error("Gmail watch token refresh failed", {
				status: tokenResponse.status,
			});
			return false;
		}
		const token = (await tokenResponse.json()) as { access_token?: string };
		if (!token.access_token) return false;

		const watchResponse = await fetchFn(
			"https://gmail.googleapis.com/gmail/v1/users/me/watch",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token.access_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ topicName: topic, labelIds: ["INBOX"] }),
			},
		);
		if (!watchResponse.ok) {
			logger.error("Gmail watch renewal failed", {
				status: watchResponse.status,
			});
			return false;
		}
		const result = (await watchResponse.json()) as { expiration?: string };
		logger.info("Gmail watch renewed", {
			expiration: result.expiration ?? "unknown",
		});
		return true;
	} catch (error) {
		logger.error("Gmail watch renewal threw", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

export function startGmailWatchRenewal(
	options: GmailWatchRenewalOptions,
): void {
	const intervalMs = Number(
		process.env.GMAIL_WATCH_RENEW_INTERVAL_MS ?? 86_400_000,
	);
	const initialDelayMs = Number(
		process.env.GMAIL_WATCH_RENEW_INITIAL_DELAY_MS ?? 30_000,
	);
	const run = () => void renewGmailWatch(options);
	setTimeout(() => {
		run();
		setInterval(run, intervalMs);
	}, initialDelayMs);
	options.logger.info("Scheduled Gmail watch renewal", {
		interval_ms: intervalMs,
		initial_delay_ms: initialDelayMs,
	});
}
