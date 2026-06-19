#!/usr/bin/env bash
# Re-consent the Gmail OAuth token for new scopes WITHOUT re-running the full
# GCP/Pub-Sub setup or re-entering the client id/secret.
#
# Reuses the existing OAuth client from gmail_oauth_credentials.json and writes
# back ONLY a fresh refresh_token (client id/secret unchanged). Use this when
# you only need to widen scopes — e.g. readonly -> modify for label/archive.
#
#   ./scripts/reauth-gmail.sh
#   GMAIL_SCOPE=https://www.googleapis.com/auth/gmail.readonly ./scripts/reauth-gmail.sh
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/.openclaw-api-server}"
CREDENTIALS_FILE="${DATA_DIR}/gmail_oauth_credentials.json"
# Default to modify (read + archive/label, NOT send).
GMAIL_SCOPE="${GMAIL_SCOPE:-https://www.googleapis.com/auth/gmail.modify}"
REDIRECT_URI="urn:ietf:wg:oauth:2.0:oob"

if [[ ! -f "$CREDENTIALS_FILE" ]]; then
	echo "No credentials at $CREDENTIALS_FILE — run setup-gmail.sh first." >&2
	exit 1
fi

CLIENT_ID=$(jq -r '.client_id // empty' "$CREDENTIALS_FILE")
CLIENT_SECRET=$(jq -r '.client_secret // empty' "$CREDENTIALS_FILE")
if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
	echo "Credentials file is missing client_id/client_secret." >&2
	exit 1
fi

echo "==> Re-consenting Gmail OAuth (reusing existing client)"
echo "    Scope: ${GMAIL_SCOPE}"
echo "    Only the refresh token will change; client id/secret stay as-is."
echo ""

AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth"
AUTH_URL+="?client_id=${CLIENT_ID}"
AUTH_URL+="&redirect_uri=${REDIRECT_URI}"
AUTH_URL+="&response_type=code"
AUTH_URL+="&scope=${GMAIL_SCOPE}"
AUTH_URL+="&access_type=offline"
AUTH_URL+="&prompt=consent"

echo "    Visit this URL and sign in as the MONITORED Gmail account:"
echo "    ${AUTH_URL}"
echo ""
open "$AUTH_URL" 2>/dev/null || xdg-open "$AUTH_URL" 2>/dev/null || true

read -rp "    Paste the authorization code: " AUTH_CODE

TOKEN_RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
	-d "code=${AUTH_CODE}" \
	-d "client_id=${CLIENT_ID}" \
	-d "client_secret=${CLIENT_SECRET}" \
	-d "redirect_uri=${REDIRECT_URI}" \
	-d "grant_type=authorization_code")

REFRESH_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.refresh_token // empty')
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')
if [[ -z "$REFRESH_TOKEN" || -z "$ACCESS_TOKEN" ]]; then
	echo "    Token exchange failed: ${TOKEN_RESPONSE}" >&2
	exit 1
fi

# Update only refresh_token in place (preserve client id/secret).
tmp=$(mktemp)
jq --arg rt "$REFRESH_TOKEN" '.refresh_token = $rt' "$CREDENTIALS_FILE" >"$tmp" && mv "$tmp" "$CREDENTIALS_FILE"
chmod 600 "$CREDENTIALS_FILE"
echo "    Updated refresh token in ${CREDENTIALS_FILE}."

GRANTED=$(curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=${ACCESS_TOKEN}" | jq -r '.scope // ""')
echo "    Granted scopes: ${GRANTED}"
echo ""
echo "    Restart the webhook server to pick up the new token:"
echo "      sudo launchctl kickstart -k system/us.yigle.openclaw-webhook"
