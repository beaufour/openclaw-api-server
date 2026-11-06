#!/usr/bin/env bash
# Re-consent the Gmail OAuth token WITHOUT re-running the full GCP/Pub-Sub
# setup.
#
# By default, reuses the existing OAuth client from gmail_oauth_credentials.json
# and writes back ONLY a fresh refresh_token (client id/secret unchanged). Use
# this when you only need to widen scopes — e.g. readonly -> modify.
#
# With --new-client, prompts for a replacement "Desktop app" client id/secret
# and stores all three values. Use this when the old client was deleted
# (token refresh fails with "deleted_client"). The new client must be in the
# same GCP project as the Pub/Sub topic: Gmail watch() rejects a topic from a
# different project than the calling client.
#
#   ./scripts/reauth-gmail.sh
#   ./scripts/reauth-gmail.sh --new-client
#   GMAIL_SCOPE=https://www.googleapis.com/auth/gmail.readonly ./scripts/reauth-gmail.sh
#   GMAIL_LOGIN_HINT=monitored@example.com ./scripts/reauth-gmail.sh
#
# Consent uses a loopback redirect (http://127.0.0.1:<port>) handled by
# scripts/_gmail-oauth-loopback.mjs; requires node, jq and curl.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.openclaw-api-server}"
CREDENTIALS_FILE="${DATA_DIR}/gmail_oauth_credentials.json"
# Default to modify (read + archive/label, NOT send).
GMAIL_SCOPE="${GMAIL_SCOPE:-https://www.googleapis.com/auth/gmail.modify}"

NEW_CLIENT=0
case "${1:-}" in
	"") ;;
	--new-client) NEW_CLIENT=1 ;;
	*)
		echo "usage: $0 [--new-client]" >&2
		exit 2
		;;
esac

if [[ ! -f "$CREDENTIALS_FILE" ]]; then
	echo "No credentials at $CREDENTIALS_FILE — run setup-gmail.sh first." >&2
	exit 1
fi

if [[ "$NEW_CLIENT" == "1" ]]; then
	echo "==> Re-authorizing Gmail OAuth with a NEW client"
	echo "    Create a 'Desktop app' OAuth client in the same project as the Pub/Sub topic."
	read -rp "    Enter Client ID: " CLIENT_ID
	read -rsp "    Enter Client Secret (hidden): " CLIENT_SECRET
	echo ""
else
	CLIENT_ID=$(jq -r '.client_id // empty' "$CREDENTIALS_FILE")
	CLIENT_SECRET=$(jq -r '.client_secret // empty' "$CREDENTIALS_FILE")
	echo "==> Re-consenting Gmail OAuth (reusing existing client)"
	echo "    Only the refresh token will change; client id/secret stay as-is."
	echo "    If the old client was deleted, rerun with --new-client."
fi
if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
	echo "Missing client_id/client_secret." >&2
	exit 1
fi
echo "    Scope: ${GMAIL_SCOPE}"
echo ""

TOKEN_RESPONSE=$(GMAIL_CLIENT_ID="$CLIENT_ID" GMAIL_CLIENT_SECRET="$CLIENT_SECRET" \
	GMAIL_SCOPE="$GMAIL_SCOPE" GMAIL_LOGIN_HINT="${GMAIL_LOGIN_HINT:-}" \
	node "${SCRIPT_DIR}/_gmail-oauth-loopback.mjs")

REFRESH_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.refresh_token // empty')
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')
GRANTED=$(echo "$TOKEN_RESPONSE" | jq -r '.scope // ""')
if [[ -z "$REFRESH_TOKEN" || -z "$ACCESS_TOKEN" ]]; then
	echo "    Token exchange returned no tokens; credentials unchanged." >&2
	exit 1
fi
if [[ " ${GRANTED} " != *" ${GMAIL_SCOPE} "* ]]; then
	echo "    Requested scope not granted (got: ${GRANTED}); credentials unchanged." >&2
	exit 1
fi

AUTHORIZED=$(curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
	"https://gmail.googleapis.com/gmail/v1/users/me/profile" | jq -r '.emailAddress // empty')
if [[ -z "$AUTHORIZED" ]]; then
	echo "    Gmail profile lookup failed (is the Gmail API enabled in the client's project?); credentials unchanged." >&2
	exit 1
fi
if [[ -n "${GMAIL_LOGIN_HINT:-}" && "$(echo "$AUTHORIZED" | tr '[:upper:]' '[:lower:]')" != "$(echo "$GMAIL_LOGIN_HINT" | tr '[:upper:]' '[:lower:]')" ]]; then
	echo "    Authorized as ${AUTHORIZED}, expected ${GMAIL_LOGIN_HINT}; credentials unchanged." >&2
	exit 1
fi

BACKUP="${CREDENTIALS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp -p "$CREDENTIALS_FILE" "$BACKUP"
tmp=$(mktemp "${CREDENTIALS_FILE}.XXXXXX")
jq --arg id "$CLIENT_ID" --arg secret "$CLIENT_SECRET" --arg rt "$REFRESH_TOKEN" \
	'.client_id = $id | .client_secret = $secret | .refresh_token = $rt' \
	"$CREDENTIALS_FILE" >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$CREDENTIALS_FILE"
echo "    Authorized ${AUTHORIZED}; granted scopes: ${GRANTED}"
echo "    Updated ${CREDENTIALS_FILE} (previous copy: ${BACKUP})."
echo ""
echo "    Restart the webhook server to pick up the new token, e.g.:"
echo "      docker compose restart openclaw-api-server"
