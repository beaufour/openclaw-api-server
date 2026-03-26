export interface Config {
	// Asana
	asanaWebhookSecret: string;

	// Strava
	stravaVerifyToken: string;
	stravaWebhookSecret: string;

	// Gmail Pub/Sub
	gmailPubsubAudience: string;

	// Data directory for persisted state
	dataDir: string;
}

export function loadConfig(): Config {
	return {
		asanaWebhookSecret: process.env.ASANA_WEBHOOK_SECRET ?? "",
		stravaVerifyToken: process.env.STRAVA_VERIFY_TOKEN ?? "",
		stravaWebhookSecret: process.env.STRAVA_WEBHOOK_SECRET ?? "",
		gmailPubsubAudience: process.env.GMAIL_PUBSUB_AUDIENCE ?? "",
		dataDir: process.env.DATA_DIR ?? `${process.env.HOME}/.openclaw-api-server`,
	};
}
