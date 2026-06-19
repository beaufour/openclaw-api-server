#!/bin/bash
# One-time relocation of the openclaw-api-server project + its persisted state
# from the beaufour account to the dedicated openclaw service account, so the
# whole OpenClaw stack runs as a single user.
#
#   sudo bash /tmp/migrate-to-openclaw.sh
#
# (Run from /tmp, NOT from inside the tree being moved.)
set -euo pipefail

SRC_REPO="/Users/beaufour/src/openclaw-api-server"
DST_REPO="/Users/openclaw/openclaw-api-server"
SRC_DATA="/Users/beaufour/.openclaw-api-server"
DST_DATA="/Users/openclaw/.openclaw-api-server"

[[ $EUID -eq 0 ]] || { echo "must run as root: sudo bash $0" >&2; exit 1; }
id openclaw >/dev/null 2>&1 || { echo "user 'openclaw' not found" >&2; exit 1; }

# Same APFS volume? (mv must be an atomic rename, not copy+delete)
[[ "$(stat -f %d /Users/beaufour)" == "$(stat -f %d /Users/openclaw)" ]] \
	|| { echo "ERROR: /Users/beaufour and /Users/openclaw are on different volumes" >&2; exit 1; }

echo "==> Stopping any manually-started webhook server"
pkill -f 'scripts/server.ts' 2>/dev/null || true
sleep 1

echo "==> Moving project tree"
if [[ -e "$DST_REPO" ]]; then
	echo "    $DST_REPO already exists — refusing to overwrite. Aborting." >&2
	exit 1
fi
[[ -d "$SRC_REPO" ]] || { echo "    source $SRC_REPO missing" >&2; exit 1; }
mv "$SRC_REPO" "$DST_REPO"

echo "==> Rewriting git worktree pointers (absolute paths)"
printf 'gitdir: %s\n' "$DST_REPO/.bare/worktrees/main" > "$DST_REPO/main/.git"
printf '%s\n' "$DST_REPO/main/.git" > "$DST_REPO/.bare/worktrees/main/gitdir"

echo "==> Moving persisted state (Gmail/Asana creds, DATA_DIR)"
if [[ -d "$SRC_DATA" ]]; then
	if [[ -e "$DST_DATA" ]]; then
		echo "    $DST_DATA already exists — refusing to overwrite. Aborting." >&2
		exit 1
	fi
	mv "$SRC_DATA" "$DST_DATA"
else
	echo "    (no $SRC_DATA — skipping)"
fi

echo "==> Ensuring log directory exists"
mkdir -p /Users/openclaw/Library/Logs

echo "==> chown -> openclaw:staff"
chown -R openclaw:staff "$DST_REPO"
[[ -e "$DST_DATA" ]] && chown -R openclaw:staff "$DST_DATA"
chown openclaw:staff /Users/openclaw/Library/Logs

echo "==> Verifying as openclaw"
sudo -u openclaw git -C "$DST_REPO/main" status --porcelain >/dev/null \
	&& echo "    git OK (worktree resolves, readable as openclaw)"
sudo -u openclaw test -r "$DST_REPO/main/.env" \
	&& echo "    .env readable as openclaw"
sudo -u openclaw /opt/homebrew/bin/node \
	"$DST_REPO/main/node_modules/tsx/dist/cli.mjs" --version >/dev/null 2>&1 \
	&& echo "    node + tsx runnable as openclaw" \
	|| echo "    WARN: tsx smoke check failed (inspect manually)"

echo
echo "==> Migration complete:"
echo "    repo : $DST_REPO/main"
echo "    data : $DST_DATA"
echo "    Old beaufour paths are gone. Next: install the LaunchDaemons."
