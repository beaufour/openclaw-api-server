# Unattended boot for the OpenClaw stack

Goal: after a power drop the Mac powers itself back on and the **whole OpenClaw
stack** comes back with **no human and no login session**:

```
Cloudflare edge ──(cloudflared tunnel)──▶ webhook receiver ──▶ OpenClaw Gateway ──▶ Ollama
   yugle.yigle.us                              :18790               :18789            :11434
```

All four run as the dedicated `openclaw` user via system LaunchDaemons in
`/Library/LaunchDaemons` (start at true boot, `KeepAlive` auto-restart).

## Why LaunchDaemons (not LaunchAgents)

LaunchAgents need a logged-in GUI session. OpenClaw's `gateway install`, the
Ollama.app, and a manually-run `cloudflared` do not survive an unattended
reboot. LaunchDaemons run at boot regardless of login — hence the conversions.

## Prerequisites

- `pmset -g | grep autorestart` → `autorestart 1` (powers on after AC loss).
- **FileVault OFF** (`fdesetup status` → `FileVault is Off.`). With it on a
  cold boot stalls forever at the pre-boot unlock screen; no daemon runs
  before the volume is unlocked and there is no secure automated bypass.
- Homebrew CLIs installed: `brew install ollama cloudflared`. Do NOT
  `brew services start` either (that makes per-user LaunchAgents). The native
  Ollama.app must be removed (app + its Login Item).
- A working named cloudflared tunnel (`config.yml` + credentials json in
  `~/.cloudflared`); the installer relocates it into the openclaw account.

## Privileges (important)

`openclaw` is a non-admin service account — it **cannot `sudo`**. The split:

- **`install-*-daemon.sh` + `migrate-to-openclaw.sh`** need **root** (they
  write `/Library/LaunchDaemons`, `chown root:wheel`, `launchctl bootstrap
  system`, move files across accounts). Run them from a **root shell** or via
  `sudo` from an **admin** account (e.g. `beaufour`). They internally drop to
  `openclaw` where appropriate.
- **Git / committing changes to this repo** is done **as `openclaw`**
  (`sudo -u openclaw …` from a root/admin shell) so file ownership and commit
  authorship stay correct — `openclaw` owns the relocated tree.

## Order of operations (root unless noted)

```sh
# 1. ONE-TIME relocation into the openclaw account (already done on this
#    host; shown for reproducibility / a fresh machine).
#    migrate-to-openclaw.sh MOVES the very tree it lives in, so it must run
#    from a copy OUTSIDE that tree — stage it in any scratch dir first:
cp deploy/migrate-to-openclaw.sh /tmp/ && sudo bash /tmp/migrate-to-openclaw.sh
#    -> tree relocated to /Users/openclaw/openclaw-api-server/main (openclaw-owned)

# All remaining steps run from the relocated repo:
cd /Users/openclaw/openclaw-api-server/main/deploy

# 2. Webhook receiver  (:18790)
sudo ./install-daemon.sh ./us.yigle.openclaw-webhook.plist

# 3. Gateway  (:18789) — converts OpenClaw's generated agent, disables it
sudo ./install-gateway-daemon.sh

# 4. Ollama  (:11434) — after `brew install ollama` + removing Ollama.app.
#    Auto-detects the brew binary, GENERATES its plist (no plist argument).
#    Bakes in OLLAMA_CONTEXT_LENGTH=65536 (64k), OLLAMA_FLASH_ATTENTION=1,
#    OLLAMA_KV_CACHE_TYPE=q8_0.
sudo bash ./install-ollama-daemon.sh

# 5. cloudflared tunnel — relocates ~/.cloudflared into the openclaw
#    account, then runs the named tunnel as a daemon. (no plist argument)
sudo bash ./install-cloudflared-daemon.sh
```

## Verify (now)

```sh
pmset -g | grep autorestart                    # 1
for L in ai.openclaw.ollama ai.openclaw.gateway us.yigle.openclaw-webhook ai.openclaw.cloudflared; do
  echo "== $L =="; sudo launchctl print system/$L | grep -E '^\s+(state|pid|username) ='
done
curl -s localhost:11434/api/version            # ollama  -> {"version":...}
curl -s localhost:18790/health                 # webhook -> {"status":"ok"}
curl -s https://yugle.yigle.us/health          # end-to-end public path -> {"status":"ok"}
sudo launchctl print system/ai.openclaw.ollama | grep -i OLLAMA_CONTEXT_LENGTH  # => 65536
```

## Verify (the definitive proof — after any `sudo reboot`, no login)

```sh
sleep 25
curl -s https://yugle.yigle.us/health && echo   # public path through the whole stack
curl -s localhost:11434/api/version && echo
pgrep -fl 'openclaw/dist/index.js gateway'
```
All should answer without anyone having logged in.

## Logs

All daemons run as `openclaw`, so logs are under `/Users/openclaw/...`
(`beaufour` needs `sudo` / `sudo -u openclaw` to read them).

| Daemon | stdout | stderr |
|---|---|---|
| webhook (API server) | `~openclaw/Library/Logs/openclaw-webhook.log` | `~openclaw/Library/Logs/openclaw-webhook.err.log` |
| cloudflared | `~openclaw/Library/Logs/cloudflared.log` | same file |
| ollama | `~openclaw/Library/Logs/ollama.log` | same file |
| gateway | `~openclaw/.openclaw/logs/gateway.log` | `/dev/null` (OpenClaw's design) |

The webhook server sends request logs to `…-webhook.log` and
crashes/uncaught errors to `…-webhook.err.log` — check both. The gateway
discards stderr by design; use `sudo -u openclaw openclaw logs` for it.

```sh
sudo tail -f /Users/openclaw/Library/Logs/cloudflared.log
sudo tail -f /Users/openclaw/Library/Logs/openclaw-webhook.log \
             /Users/openclaw/Library/Logs/openclaw-webhook.err.log
```

## Maintenance

- After `openclaw update` / `openclaw doctor --fix` (may regenerate the
  per-user gateway LaunchAgent): re-run `sudo ./install-gateway-daemon.sh`.
- `brew upgrade ollama|cloudflared` keeps working — installers auto-detect
  the binary; just re-run the relevant `install-*-daemon.sh`.
- Removed Ollama.app login item was booted out; stale brew ollama agent
  parked at `…/LaunchAgents/homebrew.mxcl.ollama.plist.disabled`.
- All config/state now lives under `/Users/openclaw` (repo, DATA_DIR,
  `~/.cloudflared`). Nothing OpenClaw depends on `/Users/beaufour`.
