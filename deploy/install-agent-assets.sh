#!/usr/bin/env bash
# Install the Gmail agent assets (prompt + outbound guard) from this repo into
# the live OpenClaw workspace. These are the canonical copies; the repo is the
# source of truth, and this COPIES them out (no symlink — so switching git
# branches never changes your live prompt).
#
#   ./deploy/install-agent-assets.sh
#   OPENCLAW_WORKSPACE=/custom/path ./deploy/install-agent-assets.sh
#
# The gateway reads the prompt fresh on each run, so no restart is needed for
# the prompt. The guard scripts only take effect for agents whose PATH includes
# the gmail-guard dir (see GMAIL-HARDENING.md Step 3).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC_PROMPT="$REPO/agent/gmail.md"
SRC_GUARD="$REPO/agent/gmail-guard"

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
DEST_PROMPT="$WORKSPACE/scripts/prompts/gmail.md"
DEST_GUARD="$WORKSPACE/scripts/gmail-guard"

mkdir -p "$(dirname "$DEST_PROMPT")" "$DEST_GUARD"

# Back up an existing prompt before overwriting (timestamped).
if [[ -f "$DEST_PROMPT" ]]; then
	cp "$DEST_PROMPT" "${DEST_PROMPT}.bak.$(date +%Y%m%d%H%M%S)"
fi

cp "$SRC_PROMPT" "$DEST_PROMPT"
cp "$SRC_GUARD/gog" "$DEST_GUARD/gog"
cp "$SRC_GUARD/reply-to-allan.sh" "$DEST_GUARD/reply-to-allan.sh"
chmod +x "$DEST_GUARD/gog" "$DEST_GUARD/reply-to-allan.sh"

echo "Installed:"
echo "  prompt -> $DEST_PROMPT"
echo "  guard  -> $DEST_GUARD/{gog,reply-to-allan.sh}"
echo "The gateway reads the prompt per run — no restart needed."
