import { describe, expect, it } from "vitest";
import {
	checkSenderAuth,
	extractFromEmail,
	isAllowlisted,
	parseDkimResult,
} from "../src/handlers/dkim.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("test-dkim");

describe("parseDkimResult", () => {
	it("parses a passing DKIM result with domain", () => {
		const header =
			"mx.google.com; dkim=pass header.i=@example.com header.s=sel1 header.d=example.com; spf=pass";
		const result = parseDkimResult(header);
		expect(result.pass).toBe(true);
		expect(result.domain).toBe("example.com");
	});

	it("parses a failing DKIM result", () => {
		const header =
			"mx.google.com; dkim=fail (bad signature) header.d=spoofed.com; spf=pass";
		const result = parseDkimResult(header);
		expect(result.pass).toBe(false);
		expect(result.domain).toBe("spoofed.com");
	});

	it("returns no pass when DKIM is missing", () => {
		const header = "mx.google.com; spf=pass smtp.mailfrom=example.com";
		const result = parseDkimResult(header);
		expect(result.pass).toBe(false);
		expect(result.domain).toBeUndefined();
	});

	it("handles dkim=none", () => {
		const header = "mx.google.com; dkim=none; spf=pass";
		const result = parseDkimResult(header);
		expect(result.pass).toBe(false);
		expect(result.domain).toBeUndefined();
	});

	it("handles dkim=temperror", () => {
		const header = "mx.google.com; dkim=temperror header.d=example.com";
		const result = parseDkimResult(header);
		expect(result.pass).toBe(false);
		expect(result.domain).toBe("example.com");
	});

	it("handles empty string", () => {
		const result = parseDkimResult("");
		expect(result.pass).toBe(false);
		expect(result.domain).toBeUndefined();
	});

	it("handles multiple DKIM results (takes first)", () => {
		const header =
			"mx.google.com; dkim=pass header.d=primary.com; dkim=fail header.d=secondary.com";
		const result = parseDkimResult(header);
		expect(result.pass).toBe(true);
		expect(result.domain).toBe("primary.com");
	});
});

describe("extractFromEmail", () => {
	it("extracts plain email", () => {
		expect(extractFromEmail("user@example.com")).toBe("user@example.com");
	});

	it("extracts email from angle brackets", () => {
		expect(extractFromEmail("Display Name <user@example.com>")).toBe(
			"user@example.com",
		);
	});

	it("extracts email from bare angle brackets", () => {
		expect(extractFromEmail("<user@example.com>")).toBe("user@example.com");
	});

	it("lowercases the email", () => {
		expect(extractFromEmail("User@Example.COM")).toBe("user@example.com");
	});

	it("trims whitespace", () => {
		expect(extractFromEmail("  user@example.com  ")).toBe("user@example.com");
	});
});

describe("isAllowlisted", () => {
	const allowlist = [
		{ fromEmail: "boss@company.com", dkimDomain: "company.com" },
		{ fromEmail: "alerts@service.io", dkimDomain: "service.io" },
	];

	it("allows matching entry", () => {
		expect(isAllowlisted("boss@company.com", "company.com", allowlist)).toBe(
			true,
		);
	});

	it("rejects non-matching from email", () => {
		expect(
			isAllowlisted("stranger@company.com", "company.com", allowlist),
		).toBe(false);
	});

	it("rejects non-matching DKIM domain", () => {
		expect(isAllowlisted("boss@company.com", "evil.com", allowlist)).toBe(
			false,
		);
	});

	it("rejects when DKIM domain is undefined", () => {
		expect(isAllowlisted("boss@company.com", undefined, allowlist)).toBe(false);
	});

	it("allows everything when allowlist is empty", () => {
		expect(isAllowlisted("anyone@anywhere.com", "anywhere.com", [])).toBe(true);
	});

	it("matches case-insensitively", () => {
		expect(isAllowlisted("Boss@Company.COM", "COMPANY.COM", allowlist)).toBe(
			true,
		);
	});
});

describe("checkSenderAuth", () => {
	const allowlist = [
		{ fromEmail: "boss@company.com", dkimDomain: "company.com" },
	];

	it("skips check when requireDkim is false", () => {
		const result = checkSenderAuth(
			"",
			"anyone@evil.com",
			false,
			allowlist,
			logger,
		);
		expect(result).toBe(true);
	});

	it("rejects when DKIM fails", () => {
		const result = checkSenderAuth(
			"mx.google.com; dkim=fail header.d=company.com",
			"boss@company.com",
			true,
			allowlist,
			logger,
		);
		expect(result).toBe(false);
	});

	it("allows when DKIM passes and sender is allowlisted", () => {
		const result = checkSenderAuth(
			"mx.google.com; dkim=pass header.d=company.com",
			"boss@company.com",
			true,
			allowlist,
			logger,
		);
		expect(result).toBe(true);
	});

	it("rejects when DKIM passes but sender not allowlisted", () => {
		const result = checkSenderAuth(
			"mx.google.com; dkim=pass header.d=company.com",
			"stranger@company.com",
			true,
			allowlist,
			logger,
		);
		expect(result).toBe(false);
	});

	it("allows when DKIM passes and allowlist is empty", () => {
		const result = checkSenderAuth(
			"mx.google.com; dkim=pass header.d=random.com",
			"user@random.com",
			true,
			[],
			logger,
		);
		expect(result).toBe(true);
	});

	it("rejects DKIM pass with spoofed From (domain mismatch in allowlist)", () => {
		const result = checkSenderAuth(
			"mx.google.com; dkim=pass header.d=evil.com",
			"boss@company.com",
			true,
			allowlist,
			logger,
		);
		expect(result).toBe(false);
	});

	it("handles From header with display name", () => {
		const result = checkSenderAuth(
			"mx.google.com; dkim=pass header.d=company.com",
			"The Boss <boss@company.com>",
			true,
			allowlist,
			logger,
		);
		expect(result).toBe(true);
	});
});
