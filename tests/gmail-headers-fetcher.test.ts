import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createGmailHeadersFetcher,
	selectTrustedAuthResults,
} from "../src/handlers/gmail-headers-fetcher.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("test-fetcher");

let dataDir: string;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "gmail-fetcher-"));
	writeFileSync(
		join(dataDir, "gmail_oauth_credentials.json"),
		JSON.stringify({
			client_id: "cid",
			client_secret: "csecret",
			refresh_token: "rtoken",
		}),
	);
});

afterAll(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => body,
	} as unknown as Response;
}

/** Build a fetch stub that routes by URL and records calls. */
function makeFetch(
	handlers: {
		token?: () => Response;
		list?: () => Response;
		get?: () => Response;
	},
	calls: string[] = [],
): typeof fetch {
	return (async (url: string | URL | Request) => {
		const u = String(url);
		calls.push(u);
		if (u.includes("oauth2.googleapis.com/token")) {
			return (
				handlers.token ??
				(() => jsonResponse({ access_token: "at", expires_in: 3600 }))
			)();
		}
		if (u.includes("/messages?labelIds=INBOX")) {
			return (
				handlers.list ?? (() => jsonResponse({ messages: [{ id: "m1" }] }))
			)();
		}
		if (u.includes("/messages/")) {
			return (
				handlers.get ?? (() => jsonResponse({ payload: { headers: [] } }))
			)();
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;
}

describe("selectTrustedAuthResults", () => {
	const trusted =
		"mx.google.com; dkim=pass header.i=@beaufour.dk header.d=beaufour.dk; spf=pass";
	const forged = "evil-authserv; dkim=pass header.d=beaufour.dk";

	it("picks the header carrying the trusted authserv-id", () => {
		const headers = [
			{ name: "Authentication-Results", value: forged },
			{ name: "Authentication-Results", value: trusted },
		];
		expect(selectTrustedAuthResults(headers, "mx.google.com")).toBe(trusted);
	});

	it("ignores forged headers and returns empty when none are trusted", () => {
		const headers = [{ name: "Authentication-Results", value: forged }];
		expect(selectTrustedAuthResults(headers, "mx.google.com")).toBe("");
	});

	it("returns empty when there is no Authentication-Results header", () => {
		expect(
			selectTrustedAuthResults(
				[{ name: "From", value: "a@b.c" }],
				"mx.google.com",
			),
		).toBe("");
	});
});

describe("createGmailHeadersFetcher", () => {
	it("refreshes a token and returns From + trusted Authentication-Results", async () => {
		const ar = "mx.google.com; dkim=pass header.d=beaufour.dk; spf=pass";
		const fetcher = createGmailHeadersFetcher({
			dataDir,
			logger,
			fetchFn: makeFetch({
				get: () =>
					jsonResponse({
						payload: {
							headers: [
								{ name: "From", value: "Allan <allan@beaufour.dk>" },
								{
									name: "Authentication-Results",
									value: "spoof; dkim=pass header.d=evil.com",
								},
								{ name: "Authentication-Results", value: ar },
							],
						},
					}),
			}),
		});
		const headers = await fetcher.fetchHeaders("petter@beaufour.dk", "123");
		expect(headers).toEqual({
			from: "Allan <allan@beaufour.dk>",
			authenticationResults: ar,
		});
	});

	it("returns null when the inbox has no message", async () => {
		const fetcher = createGmailHeadersFetcher({
			dataDir,
			logger,
			fetchFn: makeFetch({ list: () => jsonResponse({ messages: [] }) }),
		});
		expect(await fetcher.fetchHeaders("petter@beaufour.dk", "1")).toBeNull();
	});

	it("returns null when token refresh fails", async () => {
		const fetcher = createGmailHeadersFetcher({
			dataDir,
			logger,
			fetchFn: makeFetch({ token: () => jsonResponse({}, false, 400) }),
		});
		expect(await fetcher.fetchHeaders("petter@beaufour.dk", "1")).toBeNull();
	});

	it("caches the access token across calls", async () => {
		const calls: string[] = [];
		const fetcher = createGmailHeadersFetcher({
			dataDir,
			logger,
			now: () => 1_000_000,
			fetchFn: makeFetch({}, calls),
		});
		await fetcher.fetchHeaders("petter@beaufour.dk", "1");
		await fetcher.fetchHeaders("petter@beaufour.dk", "2");
		const tokenCalls = calls.filter((u) => u.includes("/token")).length;
		expect(tokenCalls).toBe(1);
	});
});
