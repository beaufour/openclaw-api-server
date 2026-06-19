#!/bin/bash
# Install a LaunchDaemon plist into /Library/LaunchDaemons and (re)bootstrap it
# into the system domain so it starts at true boot, with no login session.
#
# Usage:  sudo ./deploy/install-daemon.sh <plist-file>
#
# Idempotent: safe to re-run after editing the plist.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "Must run as root: sudo $0 $*" >&2
	exit 1
fi

SRC="${1:?usage: sudo $0 <plist-file>}"
SRC="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
LABEL="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$SRC")"
DEST="/Library/LaunchDaemons/${LABEL}.plist"

echo "==> Validating $SRC"
plutil -lint "$SRC"

echo "==> Booting out any existing instance of $LABEL (ignore 'not found')"
launchctl bootout "system/${LABEL}" 2>/dev/null || true

echo "==> Installing -> $DEST (root:wheel 0644)"
install -m 0644 -o root -g wheel "$SRC" "$DEST"

echo "==> Bootstrapping into system domain"
launchctl bootstrap system "$DEST"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}" || true

echo "==> Status"
launchctl print "system/${LABEL}" | grep -E '^\s+(state|pid|last exit code) =' || true
echo "==> Done: $LABEL"
