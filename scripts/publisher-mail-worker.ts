/** Dedicated process: credentials/state are never mounted in Hermes. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAgentGatewayClient } from "../src/gateway.js";
import {
	createHealthMonitor,
	isPermanentOAuthError,
} from "../src/health-monitor.js";
import { createLogger } from "../src/logger.js";
import {
	grantRenewalStatus,
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
// Only an OAuth app in Google's "Testing" status has expiring grants (7 days).
// Opt in by writing the lifetime in days to this host-owned file; absent or
// invalid means the app is published and no renewal warning is needed.
function grantLifetimeDays(): number | undefined {
	try {
		const days = Number(
			readFileSync(join(dir, "grant-lifetime-days"), "utf8").trim(),
		);
		return Number.isFinite(days) && days > 0 ? days : undefined;
	} catch {
		return undefined;
	}
}
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
		// Used only when grant-lifetime-days is set (OAuth app in "Testing").
		"publisher-mail-grant": {
			title: "Gmail OAuth grant",
			failingLabel: "due for renewal",
			recoveredLabel: "renewed",
			impact:
				"The OAuth app is in Testing, so the grant expires a fixed number of days after consent; after that reader mail stops being processed.",
			remedy:
				"run `python3 scripts/reauth-publisher-mail.py` in an interactive host terminal (or publish the OAuth app and delete .publisher-mail-private/grant-lifetime-days).",
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
			const lifetimeDays = grantLifetimeDays();
			if (lifetimeDays === undefined) {
				// Published app: grants don't expire on a schedule. Clearing the
				// check only announces "renewed" if a warning was actually sent.
				health.ok("publisher-mail-grant");
			} else
				try {
					const lifetimeMs = lifetimeDays * 86_400_000;
					const grant = grantRenewalStatus(
						statSync(join(dir, "google_token.json")).mtimeMs,
						Date.now(),
						lifetimeMs,
						Math.min(36 * 3_600_000, lifetimeMs / 2),
					);
					const expires = new Date(grant.expiresAt)
						.toISOString()
						.slice(0, 16)
						.replace("T", " ");
					if (grant.due)
						health.fail("publisher-mail-grant", `expires ${expires} UTC`, {
							permanent: true,
						});
					else health.ok("publisher-mail-grant");
				} catch {
					// A missing token file already fails the mail cycle check.
				}
			await health.tick();
		}
		await new Promise((resolve) => setTimeout(resolve, 300000));
	}
}
