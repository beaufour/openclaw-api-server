import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SenderAllowlistEntry } from "./handlers/dkim.js";

export interface Config {
	// Asana
	asanaWebhookSecret: string;

	// Strava
	stravaVerifyToken: string;
	stravaWebhookSecret: string;

	// Gmail Pub/Sub
	gmailPubsubAudience: string;
	gmailPubsubServiceAccount: string;

	// Gmail DKIM verification
	gmailRequireDkim: boolean;
	// "monitor" logs the DKIM/allowlist verdict but still wakes the agent;
	// "enforce" drops messages that fail. Defaults to "monitor" so enabling
	// DKIM never silently swallows legitimate (e.g. unsigned) mail until the
	// logs confirm real senders pass.
	gmailDkimMode: "monitor" | "enforce";
	gmailSenderAllowlist: SenderAllowlistEntry[];

	// Data directory for persisted state
	dataDir: string;
}

function loadAllowlist(dataDir: string): SenderAllowlistEntry[] {
	const path = join(dataDir, "gmail_sender_allowlist.json");
	if (!existsSync(path)) {
		return [];
	}
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		if (!Array.isArray(data)) {
			return [];
		}
		return data.filter(
			(entry: unknown): entry is SenderAllowlistEntry =>
				typeof entry === "object" &&
				entry !== null &&
				"fromEmail" in entry &&
				"dkimDomain" in entry &&
				typeof (entry as SenderAllowlistEntry).fromEmail === "string" &&
				typeof (entry as SenderAllowlistEntry).dkimDomain === "string" &&
				(!("replyToEmail" in entry) ||
					typeof (entry as SenderAllowlistEntry).replyToEmail === "string") &&
				(!("requiredSignedHeaders" in entry) ||
					(Array.isArray(
						(entry as SenderAllowlistEntry).requiredSignedHeaders,
					) &&
						(entry as SenderAllowlistEntry).requiredSignedHeaders?.every(
							(header) => typeof header === "string" && header.length > 0,
						) === true)),
		);
	} catch {
		return [];
	}
}

export function loadConfig(): Config {
	const dataDir =
		process.env.DATA_DIR ?? `${process.env.HOME}/.openclaw-api-server`;
	const gmailPubsubProject = process.env.GMAIL_PUBSUB_TOPIC?.match(
		/^projects\/([a-z0-9][a-z0-9-]{4,28}[a-z0-9])\/topics\//,
	)?.[1];
	return {
		asanaWebhookSecret: process.env.ASANA_WEBHOOK_SECRET ?? "",
		stravaVerifyToken: process.env.STRAVA_VERIFY_TOKEN ?? "",
		stravaWebhookSecret: process.env.STRAVA_WEBHOOK_SECRET ?? "",
		gmailPubsubAudience: process.env.GMAIL_PUBSUB_AUDIENCE ?? "",
		gmailPubsubServiceAccount:
			process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT?.toLowerCase() ??
			(gmailPubsubProject
				? `pubsub-gmail-push@${gmailPubsubProject}.iam.gserviceaccount.com`
				: ""),
		gmailRequireDkim: process.env.GMAIL_REQUIRE_DKIM === "true",
		gmailDkimMode:
			process.env.GMAIL_DKIM_MODE === "enforce" ? "enforce" : "monitor",
		gmailSenderAllowlist: loadAllowlist(dataDir),
		dataDir,
	};
}
