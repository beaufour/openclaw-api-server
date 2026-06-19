#!/bin/bash
# Convert OpenClaw's per-user Gateway LaunchAgent into a system LaunchDaemon so
# the Gateway starts at true boot with no login session.
#
# OpenClaw has no native system-daemon mode (gateway install only writes a
# per-user LaunchAgent), so we copy its GENERATED plist verbatim and apply the
# minimal changes that make it a daemon. Re-run this after `openclaw update`
# (or `openclaw doctor --fix`) to resync if OpenClaw regenerates the agent.
#
#   sudo /Users/openclaw/openclaw-api-server/main/deploy/install-gateway-daemon.sh
set -euo pipefail

LABEL="ai.openclaw.gateway"
SRC="/Users/openclaw/Library/LaunchAgents/${LABEL}.plist"
DEST="/Library/LaunchDaemons/${LABEL}.plist"
AGENT_UID="$(id -u openclaw)"

[[ $EUID -eq 0 ]] || { echo "must run as root: sudo $0" >&2; exit 1; }
[[ -f "$SRC" ]] || { echo "OpenClaw agent plist not found: $SRC" >&2; exit 1; }

echo "==> Disabling the per-user LaunchAgent (prevents a second gateway on :18789)"
launchctl bootout "gui/${AGENT_UID}/${LABEL}" 2>/dev/null || true
launchctl disable "gui/${AGENT_UID}/${LABEL}" 2>/dev/null || true

echo "==> Copying OpenClaw's generated plist and converting to a daemon"
TMP="$(mktemp -t ai.openclaw.gateway).plist"
cp "$SRC" "$TMP"
plutil -convert xml1 "$TMP"            # PlistBuddy needs xml, live plist may be binary

PB() { /usr/libexec/PlistBuddy -c "$1" "$TMP"; }
# Run as the openclaw service user (agents have no UserName; daemons need one).
PB "Add :UserName string openclaw"  2>/dev/null || PB "Set :UserName openclaw"
PB "Add :GroupName string staff"    2>/dev/null || PB "Set :GroupName staff"
# Interactive is an Aqua-session concept; a boot daemon must be Standard.
PB "Set :ProcessType Standard"      2>/dev/null || PB "Add :ProcessType string Standard"
# Agent-only key; meaningless for a system daemon.
PB "Delete :LimitLoadToSessionType" 2>/dev/null || true

plutil -lint "$TMP"

echo "==> Installing -> $DEST"
launchctl bootout "system/${LABEL}" 2>/dev/null || true
install -m 0644 -o root -g wheel "$TMP" "$DEST"
rm -f "$TMP"
launchctl bootstrap system "$DEST"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}" || true

echo "==> Status"
launchctl print "system/${LABEL}" | grep -E '^\s+(state|pid|last exit code) =' || true
echo "==> Gateway daemon installed. Re-run after 'openclaw update' to resync."
