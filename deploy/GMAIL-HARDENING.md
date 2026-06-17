# Gmail inbound hardening — what changed & how to finish rollout

Goal: (1) only Allan can get free-form *commands* answered; (2) school/PTA/etc.
mail is still *processed* but those senders can't get a reply or exfiltrate
data; (3) DKIM sender verification actually runs. Framed against the "lethal
trifecta" (private data + untrusted email + external send) — the decisive fix
is cutting the *external-send* leg, enforced in code, not in the prompt.

## Layers now in the tree (branch `harden/gmail-inbound-gate`)

1. **DKIM gate (code).** `EmailHeadersFetcher` (`src/handlers/gmail-headers-fetcher.ts`)
   refreshes the read-only Gmail token and fetches the newest INBOX message's
   `From` + Gmail's *trusted* `Authentication-Results` (selected by authserv-id
   `mx.google.com`, ignoring sender-forged AR headers; fails closed). Wired into
   `scripts/server.ts`. Config: `GMAIL_REQUIRE_DKIM=true`, `GMAIL_DKIM_MODE=monitor`
   in `.env`.
2. **Outbound lock (scripts).** `~/.openclaw/workspace/scripts/gmail-guard/`:
   - `reply-to-allan.sh` — the only sanctioned send path; recipient hardcoded to
     allan@beaufour.dk (no recipient arg to redirect).
   - `gog` — a send-guard shim: when first on PATH, blocks any `gog … send` whose
     To isn't Allan, and forbids Cc/Bcc. Pass-through for everything else.
3. **Prompt hardening (live now).** `~/.openclaw/workspace/scripts/prompts/gmail.md`
   adds an untrusted-content frame, `--wrap-untrusted` on all reads, routes
   replies through `reply-to-allan.sh`, and forbids raw send / curl / credential
   reads. The gateway reads this file per run, so it is **already in effect** on
   the next Gmail agent run — no restart needed.

## Step 1 — activate the DKIM gate (needs a restart; you must run sudo)

```
sudo launchctl kickstart -k system/us.yigle.openclaw-webhook
```
Then watch a few days of real mail in MONITOR mode (drops nothing; just logs):
```
tail -f ~/Library/Logs/openclaw-webhook.log | grep -iE 'dkim|allowlist|waking|from='
```
Confirm legit senders log "DKIM/allowlist check passed", and note the real
`header.d=` domain for each sender. If you see "No trusted Authentication-Results
found" for legit mail, set `GMAIL_TRUSTED_AUTHSERV` in `.env` to the authserv-id
the logs show.

## Step 2 — switch DKIM to enforce (optional, after monitor looks clean)

1. Populate `~/.openclaw-api-server/gmail_sender_allowlist.json` from the template
   `gmail_sender_allowlist.example.json`, using the `header.d=` domains the
   monitor logs confirmed. (`fromEmail` may be exact or `*@domain`.) Leaving it
   `[]` keeps the gate at "authentic mail only" (any `dkim=pass` sender wakes).
2. Set `GMAIL_DKIM_MODE=enforce` in `.env`.
3. `sudo launchctl kickstart -k system/us.yigle.openclaw-webhook`

Now spoofed / unsigned / non-allowlisted mail is dropped before the agent wakes.

## Step 3 — make the outbound lock deterministic (pick one; defense-in-depth today)

Today the guard scripts exist and the prompt routes through them, but the agent
*could* still ignore the prompt and call the real `gog` directly. To make
"only Allan can be emailed" hold regardless of the LLM:

- **A. Per-agent PATH (recommended, no Google action).** Make the Gmail agent
  resolve `gog` to the guard shim by prepending the guard dir to its PATH in the
  transform `~/.openclaw/hooks/transforms/gmail.js` return:
  ```js
  return {
    action: "agent", name: "Gmail", message, wakeMode: "now", deliver: false,
    model: "anthropic/claude-haiku-4-5", timeoutSeconds: 180,
    env: { PATH: "/Users/openclaw/.openclaw/workspace/scripts/gmail-guard:" + process.env.PATH },
  };
  ```
  ⚠️ Verify OpenClaw merges (not replaces) the agent env before trusting this —
  test on a spare run and confirm the agent still has node/jq/etc. Editing the
  transform requires a **gateway** restart: `sudo launchctl kickstart -k system/ai.openclaw.gateway`.
  (The guard is bypassable by absolute path / raw API — that's what B/C close.)

- **B. Drop send scope from the agent's token (airtight for mail, needs your
  Google re-consent).** Re-authorize the gog `petter@beaufour.dk` token with
  `gmail.modify` (read + archive/label) **without** `gmail.send`. Then the agent
  physically cannot send — even via raw API. Trade-off: replies to Allan then
  need a *separate* send-capable credential used only by `reply-to-allan.sh`
  (e.g. a distinct gog client/profile), or replies move to a different channel.

- **C. Egress sandbox (closes curl/raw-token exfil).** Run the Gmail agent under
  a `sandbox-exec` profile that allows only Google API hosts. Strongest for the
  network leg; most effort, and you'd maintain the profile.

## Verify / rollback

- Tests: `npm run check` (83 passing).
- DKIM path was smoke-tested end-to-end against the live read-only API in
  monitor mode (empty inbox → fail-open wake, nothing dropped/forwarded).
- Rollback DKIM: set `GMAIL_REQUIRE_DKIM=false` in `.env` + kickstart the webhook
  daemon. Rollback prompt/guard: `git checkout` the prompt; remove the guard dir
  from PATH. All changes are on branch `harden/gmail-inbound-gate`.
```
