#!/bin/bash
# Relocate the cloudflared tunnel config/creds into the openclaw account and
# run the named tunnel `openclaw` as a boot-time system LaunchDaemon
# (public ingress yugle.yigle.us -> localhost:18790 webhook).
# Run from the repo deploy/ directory:
#
#   sudo bash ./install-cloudflared-daemon.sh
set -euo pipefail
cd /

LABEL="ai.openclaw.cloudflared"
DEST="/Library/LaunchDaemons/${LABEL}.plist"
SRC_CF="/Users/beaufour/.cloudflared"
DST_CF="/Users/openclaw/.cloudflared"
CFG="$DST_CF/config.yml"

[[ $EUID -eq 0 ]] || { echo "must run as root: sudo bash $0" >&2; exit 1; }

echo "==> Locating cloudflared"
CF_BIN=""
for c in /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
	[[ -x "$c" ]] && { CF_BIN="$c"; break; }
done
[[ -n "$CF_BIN" ]] || { echo "cloudflared not found (brew install cloudflared)"; exit 1; }
echo "    using: $CF_BIN ($("$CF_BIN" --version 2>&1 | head -1))"

echo "==> Stopping the unsupervised manual tunnel (running as beaufour)"
pkill -f 'cloudflared tunnel.*run' 2>/dev/null || true
sleep 1

echo "==> Relocating ~/.cloudflared into the openclaw account"
if [[ -d "$DST_CF" ]]; then
	echo "    $DST_CF already exists — leaving it as-is"
elif [[ -d "$SRC_CF" ]]; then
	mv "$SRC_CF" "$DST_CF"
	echo "    moved $SRC_CF -> $DST_CF"
else
	echo "    ERROR: no .cloudflared found at $SRC_CF or $DST_CF" >&2
	exit 1
fi
rm -f "$DST_CF"/config.yml~ "$DST_CF"/*~ 2>/dev/null || true
chown -R openclaw:staff "$DST_CF"
chmod 700 "$DST_CF"
[[ -f "$CFG" ]] || { echo "ERROR: $CFG missing after relocate" >&2; exit 1; }
echo "    config.yml:"; sed 's/^/      /' "$CFG"

echo "==> Writing $DEST"
mkdir -p /Users/openclaw/Library/Logs
chown openclaw:staff /Users/openclaw/Library/Logs
TMP="$(mktemp -t ai.openclaw.cloudflared).plist"
cat > "$TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>UserName</key><string>openclaw</string>
	<key>GroupName</key><string>staff</string>
	<key>ProgramArguments</key>
	<array>
		<string>${CF_BIN}</string>
		<string>--no-autoupdate</string>
		<string>tunnel</string>
		<string>--config</string>
		<string>${CFG}</string>
		<string>run</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<!-- config.yml's credentials-file uses ~ -> needs HOME -->
		<key>HOME</key><string>/Users/openclaw</string>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>TUNNEL_ORIGIN_CERT</key><string>/Users/openclaw/.cloudflared/cert.pem</string>
	</dict>
	<key>WorkingDirectory</key><string>/Users/openclaw</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>/Users/openclaw/Library/Logs/cloudflared.log</string>
	<key>StandardErrorPath</key><string>/Users/openclaw/Library/Logs/cloudflared.log</string>
</dict>
</plist>
PLIST

plutil -lint "$TMP"
launchctl bootout "system/${LABEL}" 2>/dev/null || true
install -m 0644 -o root -g wheel "$TMP" "$DEST"
rm -f "$TMP"
launchctl bootstrap system "$DEST"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}" || true

echo "==> Status"
launchctl print "system/${LABEL}" | grep -E '^\s+(state|pid) =' || true
echo "==> Done. End-to-end check (give it ~10s to register):"
echo "    curl -s https://yugle.yigle.us/health"
