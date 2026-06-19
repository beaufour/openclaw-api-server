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
2. **Outbound lock (scripts).** Canonical copies live in this repo at
   `agent/gmail-guard/`; installed to `~/.openclaw/workspace/scripts/gmail-guard/`:
   - `reply-to-allan.sh` — the only sanctioned send path; recipient hardcoded to
     allan@beaufour.dk (no recipient arg to redirect).
   - `gog` — a send-guard shim: when first on PATH, blocks any `gog … send` whose
     To isn't Allan, and forbids Cc/Bcc. Pass-through for everything else.
3. **Prompt hardening.** Canonical copy at `agent/gmail.md`; installed to
   `~/.openclaw/workspace/scripts/prompts/gmail.md`. Untrusted-content frame,
   `--wrap-untrusted` on all reads, `approved`-only work queue, marks mail
   `processed`+read+archived when done, routes replies through `reply-to-allan.sh`,
   forbids raw send / curl / credential reads. The gateway reads this file per
   run, so it takes effect on the next Gmail agent run — no restart needed.

## Installing the agent assets (prompt + guard)

The prompt and guard scripts are versioned here under `agent/` (source of
truth) and **copied** into the live workspace — never symlinked, so switching
git branches can't change your running prompt. After editing them, run:
```
./deploy/install-agent-assets.sh        # copies agent/* -> ~/.openclaw/workspace/scripts/...
```
It backs up the existing prompt (timestamped) before overwriting. Override the
target with `OPENCLAW_WORKSPACE=/path`. No daemon restart needed for the prompt;
the guard only binds for agents whose PATH includes the gmail-guard dir (Step 3).

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

## Step 2b — archive rejected mail (close the inbox-landmine gap)

Dropping a message only stops it from *waking* the agent — it stays unread in
the inbox, so the next legitimate wake (whose STEP 1 is `gog gmail search
"in:inbox is:unread"`) would sweep it up and process it via the prompt. To
prevent that, the server archives every message it rejects in enforce mode
(removes INBOX + UNREAD via `messages.modify`), so it never reaches the agent.

This requires the api-server's Gmail token to have **`gmail.modify`** (read +
archive/label; still NOT send). It's read-only by default, so until you
re-consent, rejects are logged as "Could not archive … (needs gmail.modify
scope?)" and stay in the inbox — no regression, just no auto-archive.

To enable:
1. Re-run `scripts/setup-gmail.sh` (now requests `gmail.modify`); when it asks
   "Use existing credentials?" answer **n** to force re-consent in the browser.
   This rewrites `~/.openclaw-api-server/gmail_oauth_credentials.json`.
2. `sudo launchctl kickstart -k system/us.yigle.openclaw-webhook`
3. Confirm `gog`-free: the startup log's token still can't send (modify ⊄ send).

Caveat: a *false positive* (a legit sender you forgot to allowlist) gets
archived + marked read, so it won't sit in the inbox for you to notice. The
allowlist is verified, so risk is low, but consider periodically checking All
Mail, or ask to switch archive→"apply a Review label" instead of plain archive.
Any message already stuck in the inbox from before this was enabled must be
archived once by hand (or ask and I'll do it via the modify-scoped token).

## Step 2c — approved-tag processing (close the inbox-discovery loophole)

Dropping/archiving rejected mail isn't enough: the gate only sees the messages
its push fired for. An email that arrives while the router is down (or whose
push is missed) is never vetted, sits unread, and the agent's old STEP 1
(`in:inbox is:unread`) would process it on the next wake. Fail-open.

Fixed by flipping to a positive allowlist of *messages*:
- The server, on each push, sweeps **every** unread inbox message, vets each,
  and labels it `approved` (pass) or `rejected` (fail; archived in enforce).
  It wakes the agent only when something was approved.
- The agent processes ONLY `label:approved -label:processed`, and labels each
  `processed` when done. A message the gate never saw is never `approved`, so
  the agent never touches it — fail closed.

Requires `gmail.modify` (same re-consent as Step 2b — labeling is `messages.modify`).

Deploy order matters (the agent prompt is read live, so a wrong order causes a
fail-closed *outage* where nothing is processed):
1. Re-consent the token to `gmail.modify` (Step 2b) if not done.
2. `sudo launchctl kickstart -k system/us.yigle.openclaw-webhook` — server now
   labels `approved`/`rejected`. Send a test mail; confirm in the log:
   `Approved message for processing …` / `Inbox vetting sweep complete approved=… rejected=…`.
3. ONLY after you see the server labeling, swap in the new agent prompt:
   `cp scripts/prompts/gmail.md.staged` over the live
   `~/.openclaw/workspace/scripts/prompts/gmail.md` (the staged copy is in the
   prompts dir as `gmail.md.staged`). It takes effect on the next agent run.

Rollback: restore the previous `gmail.md` (keep a backup before swapping). The
server-side labeling is harmless on its own; only the prompt swap changes what
the agent processes.

Note: a message that arrives during downtime now stays unprocessed until some
later push triggers a sweep that vets it (then it's approved + processed). If
no push ever comes, it waits — that's the safe failure. The daily
renew-gmail-watch run does not currently sweep; ask if you want it to.

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
