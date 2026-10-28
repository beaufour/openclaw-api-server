/** Dedicated process: credentials/state are never mounted in Hermes. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentGatewayClient } from "../src/gateway.js";
import { createLogger } from "../src/logger.js";
import {
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
const gateway = createAgentGatewayClient({
	backend: "hermes",
	baseUrl: "http://hermes:8644",
	secret: readFileSync(join(dir, "webhook-secret"), "utf8").trim(),
	logger,
	routeProfiles: { "gmail-publisher": "publisher" },
	requireDelivered: true,
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
			} catch {
				saveState(join(dir, "health.json"), { ok: false, at: Date.now() });
				// Never log raw API errors, model output, tokens, or message content.
				logger.error(
					"Mail cycle failed; pending work retained. Check credentials, provider availability, and notification routing.",
				);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 300000));
	}
}
