import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renewGmailWatch } from "../src/gmail-watch-renewer.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};
const dataDirs: string[] = [];

afterEach(() => {
	for (const path of dataDirs.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function credentialsDir(): string {
	const path = `/tmp/gmail-watch-renewer-${Date.now()}-${Math.random()}`;
	dataDirs.push(path);
	mkdirSync(path, { recursive: true });
	writeFileSync(
		`${path}/gmail_oauth_credentials.json`,
		JSON.stringify({
			client_id: "client-id",
			client_secret: "client-secret",
			refresh_token: "refresh-token",
		}),
	);
	return path;
}

describe("Gmail watch renewal", () => {
	it("refreshes OAuth and renews the inbox watch", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "access-token" }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ expiration: "123" }), { status: 200 }),
			);

		expect(
			await renewGmailWatch({
				dataDir: credentialsDir(),
				topic: "projects/test/topics/gmail",
				logger,
				fetchFn,
			}),
		).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const watchCall = fetchFn.mock.calls[1];
		expect(watchCall[0]).toContain("/users/me/watch");
		expect(JSON.parse(watchCall[1].body)).toEqual({
			topicName: "projects/test/topics/gmail",
			labelIds: ["INBOX"],
		});
	});

	it("fails closed when credentials are missing", async () => {
		const fetchFn = vi.fn();
		expect(
			await renewGmailWatch({
				dataDir: "/tmp/does-not-exist-gmail-watch",
				topic: "projects/test/topics/gmail",
				logger,
				fetchFn,
			}),
		).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
