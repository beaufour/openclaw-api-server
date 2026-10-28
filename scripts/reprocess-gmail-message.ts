/** Local operator command for exact-message Gmail gate replay. */

import { readFileSync } from "node:fs";

try {
	for (const line of readFileSync(".env", "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 1) continue;
		const key = trimmed.slice(0, eqIdx);
		if (!(key in process.env)) process.env[key] = trimmed.slice(eqIdx + 1);
	}
} catch {
	// Production injects environment variables; a local .env is optional.
}

import { loadConfig } from "../src/config.js";
import {
	createAgentGatewayClient,
	type GatewayBackend,
} from "../src/gateway.js";
import { reprocessGmailMessage } from "../src/handlers/gmail.js";
import { createGmailHeadersFetcher } from "../src/handlers/gmail-headers-fetcher.js";
import { createLogger } from "../src/logger.js";

const messageId = process.argv[2];
if (!messageId || !/^[A-Za-z0-9_-]+$/.test(messageId)) {
	console.error("usage: reprocess-gmail-message <gmail-message-id>");
	process.exit(2);
}

const config = loadConfig();
if (!config.gmailRequireDkim || config.gmailDkimMode !== "enforce") {
	console.error(
		"refusing replay unless GMAIL_REQUIRE_DKIM=true and GMAIL_DKIM_MODE=enforce",
	);
	process.exit(2);
}

const logger = createLogger("gmail-reprocess");
const fetcher = createGmailHeadersFetcher({ dataDir: config.dataDir, logger });
const decision = await reprocessGmailMessage(
	messageId,
	config,
	fetcher,
	logger,
);
if (decision !== "approved") {
	console.log(JSON.stringify({ message_id: messageId, decision }));
	process.exit(decision === "rejected" ? 1 : 3);
}

const backend = (process.env.AGENT_GATEWAY_BACKEND ??
	"openclaw") as GatewayBackend;
if (backend !== "openclaw" && backend !== "hermes") {
	throw new Error(`invalid AGENT_GATEWAY_BACKEND: ${backend}`);
}
const baseUrl =
	backend === "hermes"
		? (process.env.HERMES_WEBHOOK_URL ?? "http://localhost:8644")
		: (process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789");
const secret =
	backend === "hermes"
		? (process.env.HERMES_WEBHOOK_SECRET ?? "")
		: (process.env.OPENCLAW_HOOK_TOKEN ?? "");
const gateway = createAgentGatewayClient({ backend, baseUrl, secret, logger, routeProfiles: { gmail: "default" } });
const forwarded = await gateway.forward("gmail", {
	email_address: process.env.GMAIL_ACCOUNT ?? "petter@beaufour.dk",
	history_id: "manual-reprocess",
	message_id: messageId,
});
console.log(
	JSON.stringify({ message_id: messageId, decision, forwarded, backend }),
);
if (!forwarded) process.exit(3);
