#!/bin/bash
# Install the OpenClaw Gateway as a STANDALONE system LaunchDaemon.
#
# Unlike the old approach, this does NOT copy-convert OpenClaw's generated
# per-user LaunchAgent. We ship our own plist (deploy/ai.openclaw.gateway.plist)
# that references only stable paths, and we make sure OpenClaw never resurrects
# a competing per-user agent:
#
#   1. install OUR plist as /Library/LaunchDaemons/ai.openclaw.gateway.plist
#   2. export OPENCLAW_SERVICE_REPAIR_POLICY=external from ~openclaw/.zshenv so
#      `openclaw update` / `openclaw doctor` skip service install/start/repair
#   3. boot out + PERSISTENTLY disable the per-user LaunchAgent, and move its
#      plist aside so even an unexpected `launchctl enable` has nothing to load
#
# After `openclaw update` you normally only need:
#   sudo launchctl kickstart -k system/ai.openclaw.gateway
# Re-run THIS script only for a first install, or if a future OpenClaw release
# changes its service label / env-wrapper layout (see RUNBOOK "Maintenance").
#
#   sudo /Users/openclaw/openclaw-api-server/main/deploy/install-gateway-daemon.sh
set -euo pipefail

LABEL="ai.openclaw.gateway"
DEST="/Library/LaunchDaemons/${LABEL}.plist"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist"

OC_HOME="/Users/openclaw"
AGENT_PLIST="${OC_HOME}/Library/LaunchAgents/${LABEL}.plist"
ZSHENV="${OC_HOME}/.zshenv"
AGENT_UID="$(id -u openclaw)"

# Stable paths the daemon depends on (contents may change in place; paths must not).
WRAPPER="${OC_HOME}/.openclaw/service-env/${LABEL}-env-wrapper.sh"
ENVFILE="${OC_HOME}/.openclaw/service-env/${LABEL}.env"
NODE="/opt/homebrew/opt/node/bin/node"
ENTRY="${OC_HOME}/.npm-global/lib/node_modules/openclaw/dist/index.js"

[[ $EUID -eq 0 ]] || { echo "must run as root: sudo $0" >&2; exit 1; }
[[ -f "$SRC" ]]   || { echo "missing plist: $SRC" >&2; exit 1; }

echo "==> Checking the stable paths our plist points at"
miss=0
for p in "$WRAPPER" "$ENVFILE" "$NODE" "$ENTRY"; do
	if [[ -e "$p" ]]; then echo "    ok   $p"; else echo "    MISS $p"; miss=1; fi
done
if [[ $miss -ne 0 ]]; then
	echo "    One or more paths are missing. If OpenClaw has never generated its" >&2
	echo "    service-env, run \`openclaw gateway install\` ONCE as openclaw to" >&2
	echo "    create them, then re-run this script. (We never run it again after.)" >&2
	exit 1
fi

echo "==> Codifying the external service-repair policy in $ZSHENV"
# zsh sources .zshenv for EVERY shell (login, interactive, scripts), so this
# covers `sudo -iu openclaw ... openclaw update`. Idempotent.
POLICY_LINE='export OPENCLAW_SERVICE_REPAIR_POLICY=external'
if [[ ! -f "$ZSHENV" ]] || ! grep -qxF "$POLICY_LINE" "$ZSHENV" 2>/dev/null; then
	{
		echo ''
		echo '# OpenClaw gateway runs as a system LaunchDaemon (see openclaw-api-server'
		echo '# deploy/). Tell OpenClaw the gateway service is supervised externally so'
		echo '# `openclaw update`/`doctor` do NOT install/start/repair a per-user'
		echo '# LaunchAgent that would fight the daemon for :18789.'
		echo "$POLICY_LINE"
	} >>"$ZSHENV"
	chown openclaw:staff "$ZSHENV"
	echo "    appended policy export"
else
	echo "    already present"
fi

echo "==> Neutralizing any per-user LaunchAgent (the 'old way')"
launchctl bootout  "gui/${AGENT_UID}/${LABEL}" 2>/dev/null || true
# Persistent disable: writes /var/db/com.apple.xpc.launchd/disabled.<uid>.plist.
# (A later `launchctl enable` would clear this, hence the move-aside below too.)
launchctl disable  "gui/${AGENT_UID}/${LABEL}" 2>/dev/null || true
if [[ -f "$AGENT_PLIST" ]]; then
	mv -f "$AGENT_PLIST" "${AGENT_PLIST}.disabled"
	echo "    moved $AGENT_PLIST -> ${AGENT_PLIST}.disabled"
	echo "    (nothing for a stray 'launchctl enable' to load on next login)"
else
	echo "    no per-user agent plist present"
fi

echo "==> Validating our plist"
plutil -lint "$SRC"

echo "==> Booting out any existing instance and waiting for teardown"
launchctl bootout "system/${LABEL}" 2>/dev/null || true
# `bootstrap` of a label whose previous job is still draining (ExitTimeOut)
# fails with "5: Input/output error". Wait until launchd no longer knows it.
for _ in $(seq 1 30); do
	launchctl print "system/${LABEL}" >/dev/null 2>&1 || break
	sleep 1
done

echo "==> Installing -> $DEST (root:wheel 0644)"
install -m 0644 -o root -g wheel "$SRC" "$DEST"

echo "==> Bootstrapping into the system domain"
# enable BEFORE bootstrap: a disabled override makes bootstrap fail with EIO.
launchctl enable "system/${LABEL}"
for attempt in 1 2 3 4 5; do
	if launchctl bootstrap system "$DEST" 2>/tmp/oc-gw-bootstrap.err; then
		break
	fi
	err="$(cat /tmp/oc-gw-bootstrap.err)"
	if grep -q 'service already loaded\|already bootstrapped' <<<"$err"; then
		echo "    already loaded — continuing"; break
	fi
	if [[ $attempt -eq 5 ]]; then
		echo "    bootstrap failed after retries: $err" >&2
		rm -f /tmp/oc-gw-bootstrap.err
		exit 1
	fi
	echo "    bootstrap attempt $attempt failed ($err) — retrying in 2s"
	sleep 2
done
rm -f /tmp/oc-gw-bootstrap.err
launchctl kickstart -k "system/${LABEL}" || true

echo "==> Status"
launchctl print "system/${LABEL}" | grep -E '^\s+(state|pid|last exit code) =' || true
echo "==> Done. After 'openclaw update': sudo launchctl kickstart -k system/${LABEL}"
