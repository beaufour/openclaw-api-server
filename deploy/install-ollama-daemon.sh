#!/bin/bash
# Install the ollama boot-time LaunchDaemon (run as openclaw), auto-detecting
# wherever Homebrew put the binary. Run AFTER you've `brew install ollama`-ed
# and removed Ollama.app. Run from the repo deploy/ directory:
#
#   sudo bash ./install-ollama-daemon.sh
set -euo pipefail
cd /

LABEL="ai.openclaw.ollama"
DEST="/Library/LaunchDaemons/${LABEL}.plist"
OUID="$(id -u openclaw)"

[[ $EUID -eq 0 ]] || { echo "must run as root: sudo bash $0" >&2; exit 1; }

echo "==> Locating a real ollama binary (not the Ollama.app symlink)"
OLLAMA_BIN=""
for c in /opt/homebrew/bin/ollama /opt/homebrew/opt/ollama/bin/ollama /usr/local/bin/ollama; do
	[[ -x "$c" ]] || continue
	# Skip anything that resolves into the GUI app bundle.
	case "$(readlink "$c" 2>/dev/null || echo "$c")" in *Ollama.app*) continue;; esac
	OLLAMA_BIN="$c"; break
done
if [[ -z "$OLLAMA_BIN" ]]; then
	echo "ERROR: no Homebrew ollama found. Run 'brew install ollama' first." >&2
	exit 1
fi
echo "    using: $OLLAMA_BIN  ($("$OLLAMA_BIN" --version 2>&1 | head -1))"

echo "==> Stopping the native Ollama.app login item (if still registered)"
launchctl bootout "gui/${OUID}/com.ollama.ollama" 2>/dev/null || true
pkill -f '/Applications/Ollama.app' 2>/dev/null || true

if [[ -L /usr/local/bin/ollama ]] && readlink /usr/local/bin/ollama | grep -q 'Ollama.app'; then
	echo "    Removing dead symlink /usr/local/bin/ollama -> Ollama.app"
	rm -f /usr/local/bin/ollama
fi

echo "==> Disabling any stale per-user Homebrew ollama LaunchAgent"
launchctl bootout  "gui/${OUID}/homebrew.mxcl.ollama" 2>/dev/null || true
launchctl disable  "gui/${OUID}/homebrew.mxcl.ollama" 2>/dev/null || true
STALE="/Users/openclaw/Library/LaunchAgents/homebrew.mxcl.ollama.plist"
[[ -f "$STALE" ]] && { mv "$STALE" "${STALE}.disabled"; echo "    Parked $STALE"; }

echo "==> Writing $DEST"
mkdir -p /Users/openclaw/Library/Logs
chown openclaw:staff /Users/openclaw/Library/Logs
TMP="$(mktemp -t ai.openclaw.ollama).plist"
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
		<string>${OLLAMA_BIN}</string>
		<string>serve</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>OLLAMA_FLASH_ATTENTION</key><string>1</string>
		<key>OLLAMA_KV_CACHE_TYPE</key><string>q8_0</string>
		<key>OLLAMA_CONTEXT_LENGTH</key><string>65536</string>
		<key>HOME</key><string>/Users/openclaw</string>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>WorkingDirectory</key><string>/Users/openclaw</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>/Users/openclaw/Library/Logs/ollama.log</string>
	<key>StandardErrorPath</key><string>/Users/openclaw/Library/Logs/ollama.log</string>
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
echo "==> Done. Verify: curl -s localhost:11434/api/version"
