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
			messageId: "m1",
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

describe("archiveMessage", () => {
	it("POSTs a modify removing INBOX/UNREAD and returns true", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchFn = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			const u = String(url);
			if (u.includes("/token"))
				return jsonResponse({ access_token: "at", expires_in: 3600 });
			if (u.includes("/modify")) {
				captured = { url: u, init: init ?? {} };
				return jsonResponse({ id: "m1" });
			}
			throw new Error(`unexpected url ${u}`);
		}) as unknown as typeof fetch;
		const fetcher = createGmailHeadersFetcher({ dataDir, logger, fetchFn });
		const ok = await fetcher.archiveMessage?.("m1");
		expect(ok).toBe(true);
		expect(captured?.url).toContain("/messages/m1/modify");
		expect(captured?.init.method).toBe("POST");
		expect(JSON.parse(String(captured?.init.body))).toEqual({
			removeLabelIds: ["INBOX", "UNREAD"],
		});
	});

	it("returns false on a non-ok response (e.g. insufficient scope)", async () => {
		const fetchFn = (async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes("/token"))
				return jsonResponse({ access_token: "at", expires_in: 3600 });
			return jsonResponse({}, false, 403);
		}) as unknown as typeof fetch;
		const fetcher = createGmailHeadersFetcher({ dataDir, logger, fetchFn });
		expect(await fetcher.archiveMessage?.("m1")).toBe(false);
	});
});

describe("listUnreadInbox + labelMessage", () => {
	it("lists every unread inbox message with parsed headers", async () => {
		const fetchFn = (async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes("/token"))
				return jsonResponse({ access_token: "at", expires_in: 3600 });
			if (u.includes("/messages?labelIds=INBOX"))
				return jsonResponse({ messages: [{ id: "a" }, { id: "b" }] });
			if (u.includes("/messages/a"))
				return jsonResponse({
					payload: {
						headers: [
							{ name: "From", value: "x@y.com" },
							{
								name: "Authentication-Results",
								value: "mx.google.com; dkim=pass header.i=@y.com",
							},
						],
					},
				});
			if (u.includes("/messages/b"))
				return jsonResponse({
					payload: {
						headers: [
							{ name: "From", value: "z@w.com" },
							{
								name: "Authentication-Results",
								value: "mx.google.com; dkim=fail",
							},
						],
					},
				});
			throw new Error(`unexpected url ${u}`);
		}) as unknown as typeof fetch;
		const fetcher = createGmailHeadersFetcher({ dataDir, logger, fetchFn });
		const msgs = await fetcher.listUnreadInbox?.();
		expect(msgs?.map((m) => m.messageId)).toEqual(["a", "b"]);
		expect(msgs?.[0].from).toBe("x@y.com");
		expect(msgs?.[0].authenticationResults).toContain("dkim=pass");
	});

	it("resolves an existing label id and applies it", async () => {
		const bodies: unknown[] = [];
		const fetchFn = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			const u = String(url);
			if (u.includes("/token"))
				return jsonResponse({ access_token: "at", expires_in: 3600 });
			if (u.endsWith("/labels"))
				return jsonResponse({ labels: [{ id: "Label_7", name: "approved" }] });
			if (u.includes("/modify")) {
				bodies.push(JSON.parse(String(init?.body)));
				return jsonResponse({ id: "m1" });
			}
			throw new Error(`unexpected url ${u}`);
		}) as unknown as typeof fetch;
		const fetcher = createGmailHeadersFetcher({ dataDir, logger, fetchFn });
		const ok = await fetcher.labelMessage?.("m1", "approved", false);
		expect(ok).toBe(true);
		expect(bodies).toEqual([{ addLabelIds: ["Label_7"], removeLabelIds: [] }]);
	});

	it("creates the label if missing and archives when asked", async () => {
		let created = false;
		const bodies: unknown[] = [];
		const fetchFn = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			const u = String(url);
			if (u.includes("/token"))
				return jsonResponse({ access_token: "at", expires_in: 3600 });
			if (u.endsWith("/labels") && init?.method === "POST") {
				created = true;
				return jsonResponse({ id: "Label_new" });
			}
			if (u.endsWith("/labels")) return jsonResponse({ labels: [] });
			if (u.includes("/modify")) {
				bodies.push(JSON.parse(String(init?.body)));
				return jsonResponse({ id: "m1" });
			}
			throw new Error(`unexpected url ${u}`);
		}) as unknown as typeof fetch;
		const fetcher = createGmailHeadersFetcher({ dataDir, logger, fetchFn });
		const ok = await fetcher.labelMessage?.("m1", "rejected", true);
		expect(ok).toBe(true);
		expect(created).toBe(true);
		expect(bodies).toEqual([
			{ addLabelIds: ["Label_new"], removeLabelIds: ["INBOX", "UNREAD"] },
		]);
	});
});
