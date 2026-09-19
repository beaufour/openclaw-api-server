/**
 * DKIM verification utilities.
 *
 * Gmail already verifies DKIM on incoming mail and stores the result in the
 * Authentication-Results header. We parse that header to check:
 * 1. Whether DKIM passed
 * 2. Which domain signed the email (the d= value)
 *
 * Combined with a sender allowlist (From email + DKIM domain pairs), this
 * lets us filter which emails trigger agent actions.
 */

import type { Logger } from "../logger.js";

export interface DkimResult {
	pass: boolean;
	domain: string | undefined;
	selector: string | undefined;
	signaturePrefix: string | undefined;
}

export interface SenderAllowlistEntry {
	fromEmail: string;
	dkimDomain: string;
	/** Optional exact Reply-To identity for delegated notification senders. */
	replyToEmail?: string;
	/** Headers that the passing DKIM signature must cryptographically cover. */
	requiredSignedHeaders?: string[];
}

export interface SenderIdentityHeaders {
	replyToHeader?: string;
	dkimSignatures?: string[];
	identityHeadersUnique?: boolean;
}

/**
 * Parse DKIM result from an Authentication-Results header value.
 *
 * Example header:
 *   "mx.google.com; dkim=pass header.d=example.com header.s=selector1; spf=pass ..."
 *
 * Returns the DKIM pass/fail status and the signing domain.
 */
export function parseDkimResult(authResults: string): DkimResult {
	// Match "dkim=pass" or "dkim=fail" etc.
	const dkimMatch = authResults.match(/\bdkim=(\w+)/);
	if (!dkimMatch) {
		return {
			pass: false,
			domain: undefined,
			selector: undefined,
			signaturePrefix: undefined,
		};
	}

	const pass = dkimMatch[1] === "pass";

	// Extract the signing domain. Prefer header.d=, but Gmail/Workspace often
	// reports only the DKIM identity as header.i=@domain (no header.d=), e.g.
	// "dkim=pass header.i=@beaufour.dk" — fall back to that, taking the part
	// after the last "@" so "user@domain" and "@domain" both yield the domain.
	let domain = authResults.match(/\bheader\.d=([^\s;]+)/)?.[1];
	if (!domain) {
		const identity = authResults.match(/\bheader\.i=([^\s;]+)/)?.[1];
		if (identity) {
			domain = identity.includes("@")
				? identity.slice(identity.lastIndexOf("@") + 1)
				: identity;
		}
	}

	return {
		pass,
		domain,
		selector: authResults.match(/\bheader\.s=([^\s;]+)/)?.[1],
		signaturePrefix: authResults.match(/\bheader\.b=([^\s;]+)/)?.[1],
	};
}

/**
 * Extract the email address from a From header value.
 *
 * Handles formats like:
 *   "user@example.com"
 *   "Display Name <user@example.com>"
 *   "<user@example.com>"
 */
export function extractFromEmail(fromHeader: string): string {
	const angleMatch = fromHeader.match(/<([^>]+)>/);
	if (angleMatch) {
		return angleMatch[1].toLowerCase();
	}
	return fromHeader.trim().toLowerCase();
}

/**
 * Match a From address against an allowlist entry's fromEmail pattern.
 *
 * Supports two forms (case-insensitive):
 * - exact address: "allan@beaufour.dk"
 * - domain wildcard: "*@schools.nyc.gov" matches any address at that domain,
 *   which is needed for senders (schools, etc.) that use many From addresses.
 */
function fromMatches(pattern: string, fromEmail: string): boolean {
	const p = pattern.toLowerCase();
	const from = fromEmail.toLowerCase();
	if (p.startsWith("*@")) {
		return from.endsWith(p.slice(1)); // ".endsWith('@domain')"
	}
	return p === from;
}

function dkimTag(signature: string, tag: string): string | undefined {
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return signature
		.match(new RegExp(`(?:^|;)\\s*${escaped}=([^;]*)`, "i"))?.[1]
		.trim();
}

/** Confirm that the exact Gmail-passed signature covers all required headers. */
export function passingSignatureCovers(
	dkim: DkimResult,
	signatures: string[],
	requiredHeaders: string[],
): boolean {
	if (!dkim.pass || !dkim.domain || !dkim.selector || !dkim.signaturePrefix) {
		return false;
	}
	const signaturePrefix = dkim.signaturePrefix;
	const required = requiredHeaders.map((header) => header.toLowerCase());
	return signatures.some((signature) => {
		const domain = dkimTag(signature, "d")?.toLowerCase();
		const selector = dkimTag(signature, "s");
		const signatureValue = dkimTag(signature, "b")?.replace(/\s+/g, "");
		const signedHeaders = (dkimTag(signature, "h") ?? "")
			.split(":")
			.map((header) => header.trim().toLowerCase())
			.filter(Boolean);
		return (
			domain === dkim.domain?.toLowerCase() &&
			selector === dkim.selector &&
			signatureValue?.startsWith(signaturePrefix) === true &&
			required.every((header) => signedHeaders.includes(header))
		);
	});
}

/**
 * Check if a sender is in the allowlist.
 *
 * Both the From email (exact or "*@domain" wildcard) and the DKIM signing
 * domain must match an entry. Matching is case-insensitive.
 */
export function isAllowlisted(
	fromEmail: string,
	dkimOrDomain: DkimResult | string | undefined,
	allowlist: SenderAllowlistEntry[],
	identityHeaders: SenderIdentityHeaders = {},
): boolean {
	if (allowlist.length === 0) {
		return true;
	}

	const dkim: DkimResult =
		typeof dkimOrDomain === "object"
			? dkimOrDomain
			: {
					pass: Boolean(dkimOrDomain),
					domain: dkimOrDomain,
					selector: undefined,
					signaturePrefix: undefined,
				};
	const normalizedDkim = dkim.domain?.toLowerCase();

	return allowlist.some((entry) => {
		if (
			!fromMatches(entry.fromEmail, fromEmail) ||
			entry.dkimDomain.toLowerCase() !== normalizedDkim
		) {
			return false;
		}
		if (
			(entry.replyToEmail || entry.requiredSignedHeaders) &&
			identityHeaders.identityHeadersUnique !== true
		) {
			return false;
		}
		if (
			entry.replyToEmail &&
			extractFromEmail(identityHeaders.replyToHeader ?? "") !==
				entry.replyToEmail.toLowerCase()
		) {
			return false;
		}
		if (
			entry.requiredSignedHeaders &&
			!passingSignatureCovers(
				dkim,
				identityHeaders.dkimSignatures ?? [],
				entry.requiredSignedHeaders,
			)
		) {
			return false;
		}
		return true;
	});
}

/**
 * Full DKIM + allowlist check.
 *
 * Returns true if:
 * - DKIM verification is disabled (requireDkim is false), OR
 * - DKIM passed AND (no allowlist configured OR sender matches an allowlist entry)
 */
export function checkSenderAuth(
	authResultsHeader: string,
	fromHeader: string,
	requireDkim: boolean,
	allowlist: SenderAllowlistEntry[],
	logger: Logger,
	identityHeaders: SenderIdentityHeaders = {},
): boolean {
	if (!requireDkim) {
		return true;
	}

	const dkim = parseDkimResult(authResultsHeader);

	if (!dkim.pass) {
		logger.warn("Email failed DKIM verification", {
			from: fromHeader,
			dkim_domain: dkim.domain,
		});
		return false;
	}

	logger.debug("DKIM verification passed", {
		dkim_domain: dkim.domain,
	});

	const fromEmail = extractFromEmail(fromHeader);

	if (allowlist.length > 0) {
		const allowed = isAllowlisted(fromEmail, dkim, allowlist, identityHeaders);
		if (!allowed) {
			logger.info("Sender not in allowlist, dropping", {
				from: fromEmail,
				dkim_domain: dkim.domain,
			});
			return false;
		}
		logger.debug("Sender matches allowlist entry", {
			from: fromEmail,
			dkim_domain: dkim.domain,
		});
	}

	return true;
}
