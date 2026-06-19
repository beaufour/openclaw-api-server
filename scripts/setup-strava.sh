#!/usr/bin/env bash
#
# Set up Strava webhook subscription.
#
# Prerequisites:
#   - A Strava API application (create at https://www.strava.com/settings/api)
#   - The webhook endpoint must be publicly reachable (Cloudflare Tunnel running)
#   - The dev server or OpenClaw Gateway must be running to handle the validation
#
# What this script does:
#   1. Generates a webhook secret and verify token (or uses provided ones)
#   2. Creates a Strava webhook subscription
#   3. Strava sends a GET validation request — the server handles it
#   4. Prints the env vars to set
#
# Usage:
#   ./scripts/setup-strava.sh [domain]   (domain optional if WEBHOOK_DOMAIN is in .env)
#
# Example:
#   ./scripts/setup-strava.sh webhooks.example.com
#
set -euo pipefail

STRAVA_API="https://www.strava.com/api/v3"

# --- Argument parsing ---

# Webhook domain: optional arg overrides WEBHOOK_DOMAIN (env or .env), so you
# don't have to pass it to every setup script. See scripts/_resolve-domain.sh.
SETUP_DOMAIN_ARG="${1:-}"
# shellcheck source=scripts/_resolve-domain.sh
source "$(dirname "$0")/_resolve-domain.sh"

# --- Get Strava credentials ---

echo "==> Strava API credentials required."
echo "    Find them at: https://www.strava.com/settings/api"
echo ""

if [[ -z "${STRAVA_CLIENT_ID:-}" ]]; then
    read -rp "    Enter Client ID: " STRAVA_CLIENT_ID
fi
if [[ -z "${STRAVA_CLIENT_SECRET:-}" ]]; then
    read -rsp "    Enter Client Secret: " STRAVA_CLIENT_SECRET
    echo ""
fi

# --- Generate secrets ---

# Use existing env vars if set, otherwise generate random ones
if [[ -z "${STRAVA_WEBHOOK_SECRET:-}" ]]; then
    STRAVA_WEBHOOK_SECRET=$(openssl rand -hex 16)
    echo ""
    echo "    Generated webhook secret: ${STRAVA_WEBHOOK_SECRET}"
fi

if [[ -z "${STRAVA_VERIFY_TOKEN:-}" ]]; then
    STRAVA_VERIFY_TOKEN=$(openssl rand -hex 16)
    echo "    Generated verify token: ${STRAVA_VERIFY_TOKEN}"
fi

CALLBACK_URL="https://${DOMAIN}/webhook/strava/${STRAVA_WEBHOOK_SECRET}"

echo ""
echo "    Callback URL: ${CALLBACK_URL}"
echo ""

# --- Check for existing subscription ---

echo "==> Checking for existing webhook subscription..."
EXISTING=$(curl -s -G "${STRAVA_API}/push_subscriptions" \
    -d "client_id=${STRAVA_CLIENT_ID}" \
    -d "client_secret=${STRAVA_CLIENT_SECRET}")

if echo "$EXISTING" | jq -e '.[0].id' &>/dev/null; then
    EXISTING_ID=$(echo "$EXISTING" | jq -r '.[0].id')
    EXISTING_URL=$(echo "$EXISTING" | jq -r '.[0].callback_url')
    echo "    Found existing subscription:"
    echo "    ID: ${EXISTING_ID}"
    echo "    Callback URL: ${EXISTING_URL}"
    echo ""
    read -rp "    Delete existing subscription and create new one? [y/N] " confirm
    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        curl -s -X DELETE "${STRAVA_API}/push_subscriptions/${EXISTING_ID}" \
            -d "client_id=${STRAVA_CLIENT_ID}" \
            -d "client_secret=${STRAVA_CLIENT_SECRET}" >/dev/null
        echo "    Deleted."
    else
        echo "    Keeping existing subscription."
        echo ""
        echo "    Environment variables to set:"
        echo "      STRAVA_WEBHOOK_SECRET=<the secret from your callback URL>"
        echo "      STRAVA_VERIFY_TOKEN=<the verify token used when creating>"
        exit 0
    fi
fi

# --- Create subscription ---

echo ""
echo "==> Creating Strava webhook subscription..."
echo "    IMPORTANT: The webhook endpoint must be reachable right now"
echo "    (Strava will send a GET validation request immediately)."
echo ""
echo "    Make sure STRAVA_WEBHOOK_SECRET=${STRAVA_WEBHOOK_SECRET}"
echo "    and STRAVA_VERIFY_TOKEN=${STRAVA_VERIFY_TOKEN}"
echo "    are set in your server's environment."
echo ""
read -rp "    Is your server running with these env vars? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo ""
    echo "    Start your server with these env vars first:"
    echo "      STRAVA_WEBHOOK_SECRET=${STRAVA_WEBHOOK_SECRET} \\"
    echo "      STRAVA_VERIFY_TOKEN=${STRAVA_VERIFY_TOKEN} \\"
    echo "      npm run dev"
    exit 0
fi

RESPONSE=$(curl -s -X POST "${STRAVA_API}/push_subscriptions" \
    -d "client_id=${STRAVA_CLIENT_ID}" \
    -d "client_secret=${STRAVA_CLIENT_SECRET}" \
    -d "callback_url=${CALLBACK_URL}" \
    -d "verify_token=${STRAVA_VERIFY_TOKEN}")

if echo "$RESPONSE" | jq -e '.id' &>/dev/null; then
    SUB_ID=$(echo "$RESPONSE" | jq -r '.id')
    echo "    Subscription created successfully!"
    echo "    Subscription ID: ${SUB_ID}"
else
    echo "    Failed to create subscription:"
    echo "    ${RESPONSE}"
    echo ""
    echo "    Common issues:"
    echo "    - Server not reachable at ${CALLBACK_URL}"
    echo "    - STRAVA_VERIFY_TOKEN mismatch between server and this script"
    echo "    - Strava only allows one subscription per application"
    exit 1
fi

# --- Summary ---

echo ""
echo "=========================================="
echo "  Strava Webhook Setup Complete"
echo "=========================================="
echo ""
echo "  Subscription ID: ${SUB_ID}"
echo "  Callback URL:    ${CALLBACK_URL}"
echo ""
echo "  Environment variables to set:"
echo "    STRAVA_WEBHOOK_SECRET=${STRAVA_WEBHOOK_SECRET}"
echo "    STRAVA_VERIFY_TOKEN=${STRAVA_VERIFY_TOKEN}"
echo ""
echo "  Notes:"
echo "  - Strava allows only ONE webhook subscription per app"
echo "  - Events include: activity create/update/delete, athlete update"
echo "  - To check subscription status:"
echo "      curl -G '${STRAVA_API}/push_subscriptions' \\"
echo "        -d 'client_id=${STRAVA_CLIENT_ID}' \\"
echo "        -d 'client_secret=<secret>'"
echo ""
