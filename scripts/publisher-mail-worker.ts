/** Dedicated process: credentials/state are never mounted in Hermes. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentGatewayClient } from "../src/gateway.js";
import {
	createHealthMonitor,
	isPermanentOAuthError,
} from "../src/health-monitor.js";
import { createLogger } from "../src/logger.js";
import {
	OAuthRefreshError,
	PublisherMailClient,
	runCycle,
	type State,
	saveState,
} from "../src/publisher-mail.js";

process.umask(0o077);
const dir = "/private-mail";
const statePath = join(dir, "state.json");
const logger = createLogger("publisher-mail");
if (process.argv.includes("--health")) {
	if (!existsSync(join(dir, "enabled"))) process.exit(0);
	try {
		const status = JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));
		process.exit(status.ok === true && Date.now() - status.at < 900000 ? 0 : 1);
	} catch {
		process.exit(1);
	}
}
const client = new PublisherMailClient(dir, "petterrobortson@gmail.com");
const webhookSecret = readFileSync(join(dir, "webhook-secret"), "utf8").trim();
const gateway = createAgentGatewayClient({
	backend: "hermes",
	baseUrl: "http://hermes:8644",
	secret: webhookSecret,
	logger,
	routeProfiles: {
		"gmail-publisher": "publisher",
		"publisher-mail-alert": "default",
	},
	requireDelivered: true,
});
// Operational alerts use this worker's own HMAC secret on a dedicated
// deliver-only route, so the worker never holds the personal gateway secret.
const health = createHealthMonitor({
	statePath: join(dir, "health_alerts.json"),
	checks: {
		"publisher-mail": {
			title: "reader-mail cycle",
			impact:
				"Reader email to the publisher inbox is not being classified or reported to Slack.",
			remedy:
				"an OAuth error needs `python3 scripts/reauth-publisher-mail.py` on the host (OAuth app must be In production, not Testing, or tokens expire after 7 days); otherwise check `docker compose logs publisher-mail`.",
			maxSilenceMs: 3_600_000,
		},
	},
	failureThreshold: 3,
	send: (alert) =>
		gateway.forward(
			"publisher-mail-alert",
			{ check: alert.check, kind: alert.kind, text: alert.text },
			`publisher-mail-alert-${alert.kind}-${Date.now()}`,
		),
	logger,
	source: "Publisher mail",
});
if (process.argv.includes("--check")) {
	await client.authenticate();
	console.log(
		"Publisher mailbox identity verified; read-only API check passed.",
	);
} else {
	for (;;) {
		if (existsSync(join(dir, "enabled"))) {
			try {
				const state: State = existsSync(statePath)
					? JSON.parse(readFileSync(statePath, "utf8"))
					: { records: {} };
				await runCycle(
					client,
					state,
					() => saveState(statePath, state),
					gateway,
				);
				saveState(join(dir, "health.json"), { ok: true, at: Date.now() });
				logger.info("Read-only mail cycle completed");
				health.ok("publisher-mail");
			} catch (error) {
				saveState(join(dir, "health.json"), { ok: false, at: Date.now() });
				// Never log raw API errors, model output, tokens, or message content;
				// only the sanitized OAuth error code is safe to surface.
				const code = error instanceof OAuthRefreshError ? error.code : "";
				logger.error(
					"Mail cycle failed; pending work retained. Check credentials, provider availability, and notification routing.",
					code ? { oauth_error: code } : undefined,
				);
				health.fail(
					"publisher-mail",
					code ? `token refresh: ${code}` : "mail cycle error",
					{ permanent: isPermanentOAuthError(code) },
				);
			}
			await health.tick();
		}
		await new Promise((resolve) => setTimeout(resolve, 300000));
	}
}
