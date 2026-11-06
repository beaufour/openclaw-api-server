#!/usr/bin/env node
// Gmail OAuth consent via the loopback redirect (RFC 8252).
//
// Google blocked the out-of-band "urn:ietf:wg:oauth:2.0:oob" copy/paste flow,
// so setup-gmail.sh and reauth-gmail.sh use this helper instead. It requires
// an OAuth client of type "Desktop app", which accepts any
// http://127.0.0.1:<port> redirect without registering it.
//
// Input (environment): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_SCOPE,
//   optional GMAIL_LOGIN_HINT (pre-selects the account to monitor).
// Output: the token endpoint's JSON response on stdout, only on success.
//   Everything human-facing goes to stderr, so callers can capture stdout.
// Exit codes: 0 success, 1 authorization or exchange failure, 2 bad input.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const clientId = process.env.GMAIL_CLIENT_ID ?? "";
const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? "";
const scope = process.env.GMAIL_SCOPE ?? "";
const loginHint = process.env.GMAIL_LOGIN_HINT ?? "";
const TIMEOUT_MS = Number(process.env.GMAIL_OAUTH_TIMEOUT_MS ?? 300_000);

if (!clientId || !clientSecret || !scope) {
	console.error("GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_SCOPE are required.");
	process.exit(2);
}

const state = randomBytes(16).toString("base64url");

function openBrowser(url) {
	const cmd = process.platform === "darwin" ? "open" : "xdg-open";
	try {
		const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// The URL is also printed; the operator can open it manually.
	}
}

const result = await new Promise((resolve) => {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const code = url.searchParams.get("code");
		const error = url.searchParams.get("error");
		if (!code && !error) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("Done. You can close this tab and return to the terminal.");
		server.close();
		resolve({ code, error, state: url.searchParams.get("state"), redirectUri });
	});
	let redirectUri = "";
	const timer = setTimeout(() => {
		server.close();
		resolve({ error: "timed out waiting for the browser redirect" });
	}, TIMEOUT_MS);
	timer.unref();
	server.listen(0, "127.0.0.1", () => {
		redirectUri = `http://127.0.0.1:${server.address().port}`;
		const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		auth.search = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope,
			access_type: "offline",
			prompt: "consent",
			state,
			...(loginHint ? { login_hint: loginHint } : {}),
		}).toString();
		console.error("    Opening browser for Gmail authorization.");
		console.error("    Sign in with the Gmail account you want to MONITOR.");
		console.error("    If the browser doesn't open, visit:");
		console.error(`    ${auth}`);
		openBrowser(auth.toString());
	});
});

if (result.error) {
	console.error(`    Authorization failed: ${result.error}`);
	process.exit(1);
}
if (result.state !== state) {
	console.error("    OAuth state mismatch; aborting.");
	process.exit(1);
}

const response = await fetch("https://oauth2.googleapis.com/token", {
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		code: result.code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: result.redirectUri,
		grant_type: "authorization_code",
	}).toString(),
});
const json = await response.json().catch(() => ({}));
if (!response.ok || !json.access_token || !json.refresh_token) {
	// Report only the error code/description; never echo token material.
	console.error(
		`    Token exchange failed: ${json.error ?? response.status} ${json.error_description ?? ""}`,
	);
	process.exit(1);
}
process.stdout.write(`${JSON.stringify(json)}\n`);
