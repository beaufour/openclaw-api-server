import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renewGmailWatch } from "../src/gmail-watch-renewer.js";
import { createGmailHeadersFetcher } from "../src/handlers/gmail-headers-fetcher.js";
import {
	createHealthMonitor,
	type HealthAlert,
	isPermanentOAuthError,
	sanitizeDetail,
} from "../src/health-monitor.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const dirs: string[] = [];

afterEach(() => {
	for (const path of dirs.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
	const path = `/tmp/health-monitor-${Date.now()}-${Math.random()}`;
	dirs.push(path);
	mkdirSync(path, { recursive: true });
	return path;
}

const checks = {
	"gmail-oauth": {
		title: "Gmail OAuth token refresh",
		impact: "Mail is not processed.",
		remedy: "reauthorize.",
	},
	"gmail-watch": {
		title: "Gmail watch renewal",
		impact: "Pushes stop.",
		remedy: "renew.",
		maxSilenceMs: 1000,
	},
};

function setup(sendResult: boolean | (() => boolean) = true) {
	const dir = tempDir();
	let clock = Date.UTC(2026, 10, 3, 14, 28);
	const sent: HealthAlert[] = [];
	const send = vi.fn(async (alert: HealthAlert) => {
		sent.push(alert);
		return typeof sendResult === "function" ? sendResult() : sendResult;
	});
	const make = () =>
		createHealthMonitor({
			statePath: `${dir}/health.json`,
			checks,
			send,
			logger,
			source: "Gmail receiver",
			reminderMs: 10_000,
			now: () => clock,
		});
	return {
		make,
		sent,
		send,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("health monitor", () => {
	it("alerts once after the failure threshold and once on recovery", async () => {
		const { make, sent } = setup();
		const health = make();
		health.fail("gmail-oauth", "HTTP 503");
		await health.flush();
		expect(sent).toHaveLength(0);
		health.fail("gmail-oauth", "HTTP 503");
		await health.flush();
		health.fail("gmail-oauth", "HTTP 503");
		await health.flush();
		expect(sent.map((a) => a.kind)).toEqual(["failing"]);
		expect(sent[0].text).toContain("Gmail OAuth token refresh failing since");
		expect(sent[0].text).toContain("2026-11-03 14:28 UTC");
		expect(sent[0].text).toContain("Fix: reauthorize.");
		health.ok("gmail-oauth");
		await health.flush();
		health.ok("gmail-oauth");
		await health.flush();
		expect(sent.map((a) => a.kind)).toEqual(["failing", "recovered"]);
		expect(sent[1].text).toContain("recovered");
	});

	it("alerts immediately for a permanent failure", async () => {
		const { make, sent } = setup();
		const health = make();
		health.fail("gmail-oauth", "deleted_client", { permanent: true });
		await health.flush();
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toContain("(deleted_client)");
	});

	it("sends reminders while failing, not on every failure", async () => {
		const { make, sent, advance } = setup();
		const health = make();
		health.fail("gmail-oauth", "deleted_client", { permanent: true });
		await health.flush();
		advance(5_000);
		health.fail("gmail-oauth", "deleted_client", { permanent: true });
		await health.flush();
		expect(sent).toHaveLength(1);
		advance(6_000);
		health.fail("gmail-oauth", "deleted_client", { permanent: true });
		await health.flush();
		expect(sent.map((a) => a.kind)).toEqual(["failing", "reminder"]);
		expect(sent[1].text).toMatch(
			/^🚨 Still: Gmail receiver: Gmail OAuth token refresh failing since/,
		);
	});

	it("keeps undelivered alerts queued across restarts and retries them", async () => {
		let up = false;
		const { make, sent } = setup(() => up);
		const first = make();
		first.fail("gmail-oauth", "deleted_client", { permanent: true });
		await first.flush();
		expect(sent).toHaveLength(1);
		const second = make();
		up = true;
		await second.tick();
		expect(sent.map((a) => a.kind)).toEqual(["failing", "failing"]);
		await second.tick();
		expect(sent).toHaveLength(2);
	});

	it("skips the recovery notice when the failure was never announced", async () => {
		let up = false;
		const { make, sent } = setup(() => up);
		const health = make();
		health.fail("gmail-oauth", "deleted_client", { permanent: true });
		await health.flush();
		health.ok("gmail-oauth");
		up = true;
		await health.tick();
		expect(sent.map((a) => a.kind)).toEqual(["failing"]);
	});

	it("fails a check that has been silent past its limit", async () => {
		const { make, sent, advance } = setup();
		const health = make();
		await health.tick();
		expect(sent).toHaveLength(0);
		advance(1_500);
		await health.tick();
		expect(sent).toHaveLength(1);
		expect(sent[0].check).toBe("gmail-watch");
		expect(sent[0].text).toContain("no success in 0h");
		health.ok("gmail-watch");
		await health.flush();
		expect(sent.map((a) => a.kind)).toEqual(["failing", "recovered"]);
	});

	it("uses per-check wording for warnings and recovery", async () => {
		const dir = tempDir();
		const sent: HealthAlert[] = [];
		const health = createHealthMonitor({
			statePath: `${dir}/health.json`,
			checks: {
				grant: {
					title: "Gmail OAuth grant",
					failingLabel: "due for renewal",
					recoveredLabel: "renewed",
					impact: "Mail stops after expiry.",
					remedy: "reauthorize.",
				},
			},
			send: async (a) => {
				sent.push(a);
				return true;
			},
			logger,
			source: "Publisher mail",
			now: () => Date.UTC(2026, 10, 12, 11, 47),
		});
		health.fail("grant", "expires 2026-11-13 23:47 UTC", { permanent: true });
		await health.flush();
		health.ok("grant");
		await health.flush();
		expect(sent.map((a) => a.text)).toEqual([
			"🚨 Publisher mail: Gmail OAuth grant due for renewal since 2026-11-12 11:47 UTC (expires 2026-11-13 23:47 UTC). Mail stops after expiry. Fix: reauthorize.",
			"✅ Publisher mail: Gmail OAuth grant renewed (was due for renewal since 2026-11-12 11:47 UTC).",
		]);
	});

	it("rejects unknown checks and sanitizes detail", () => {
		const { make } = setup();
		expect(() => make().fail("nope", "x")).toThrow();
		expect(sanitizeDetail("bad\n<script>`x`")).toBe("badscriptx");
		expect(isPermanentOAuthError("deleted_client")).toBe(true);
		expect(isPermanentOAuthError("temporarily_unavailable")).toBe(false);
	});
});

function credsDir(): string {
	const dir = tempDir();
	writeFileSync(
		`${dir}/gmail_oauth_credentials.json`,
		JSON.stringify({
			client_id: "id",
			client_secret: "secret",
			refresh_token: "refresh",
		}),
	);
	return dir;
}

const deletedClient = () =>
	new Response(
		JSON.stringify({
			error: "deleted_client",
			error_description: "The OAuth client was deleted.",
		}),
		{ status: 401 },
	);

describe("health reporting hooks", () => {
	it("reports token refresh failures from the headers fetcher", async () => {
		const results: unknown[] = [];
		const fetcher = createGmailHeadersFetcher({
			dataDir: credsDir(),
			logger,
			fetchFn: vi.fn().mockResolvedValue(deletedClient()),
			onTokenRefresh: (r) => results.push(r),
		});
		expect(await fetcher.fetchMessageById("abc")).toBeNull();
		expect(results).toEqual([
			{ ok: false, detail: "deleted_client", permanent: true },
		]);
	});

	it("reports token refresh success from the headers fetcher", async () => {
		const results: unknown[] = [];
		const fetcher = createGmailHeadersFetcher({
			dataDir: credsDir(),
			logger,
			fetchFn: vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ access_token: "t" }), { status: 200 }),
				)
				.mockResolvedValue(new Response("{}", { status: 404 })),
			onTokenRefresh: (r) => results.push(r),
		});
		await fetcher.fetchMessageById("abc");
		expect(results).toEqual([{ ok: true }]);
	});

	it("reports watch renewal outcomes", async () => {
		const reports: unknown[][] = [];
		await renewGmailWatch({
			dataDir: credsDir(),
			topic: "projects/p/topics/t",
			logger,
			fetchFn: vi.fn().mockResolvedValue(deletedClient()),
			report: (...args) => reports.push(args),
		});
		await renewGmailWatch({
			dataDir: credsDir(),
			topic: "projects/p/topics/t",
			logger,
			fetchFn: vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ access_token: "t" }), { status: 200 }),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ expiration: "1" }), { status: 200 }),
				),
			report: (...args) => reports.push(args),
		});
		expect(reports).toEqual([
			[false, "token refresh: deleted_client", true],
			[true],
		]);
	});
});
