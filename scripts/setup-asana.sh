#!/usr/bin/env bash
#
# Set up Asana webhooks.
#
# Prerequisites:
#   - An Asana Personal Access Token (create at https://app.asana.com/0/my-apps)
#   - The webhook endpoint must be publicly reachable (Cloudflare Tunnel running)
#   - The dev server or OpenClaw Gateway must be running to handle the handshake
#
# What this script does:
#   1. Lists your Asana workspaces
#   2. Lists projects in the selected workspace
#   3. Creates a webhook for the selected project(s)
#   4. The server handles the handshake automatically
#
# Usage:
#   ./scripts/setup-asana.sh [domain]   (domain optional if WEBHOOK_DOMAIN is in .env)
#
# Example:
#   ./scripts/setup-asana.sh webhooks.example.com
#
set -euo pipefail

ASANA_API="https://app.asana.com/api/1.0"

# --- Argument parsing ---

# Webhook domain: optional arg overrides WEBHOOK_DOMAIN (env or .env), so you
# don't have to pass it to every setup script. See scripts/_resolve-domain.sh.
SETUP_DOMAIN_ARG="${1:-}"
# shellcheck source=scripts/_resolve-domain.sh
source "$(dirname "$0")/_resolve-domain.sh"
WEBHOOK_URL="https://${DOMAIN}/webhook/asana"

# --- Get Asana token ---

if [[ -z "${ASANA_PAT:-}" ]]; then
    echo "==> Asana Personal Access Token required."
    echo "    Create one at: https://app.asana.com/0/my-apps"
    echo ""
    read -rsp "    Enter your Asana PAT: " ASANA_PAT
    echo ""
fi

# Verify token
echo "==> Verifying Asana token..."
ME_RESPONSE=$(curl -s -H "Authorization: Bearer ${ASANA_PAT}" "${ASANA_API}/users/me")
if echo "$ME_RESPONSE" | jq -e '.errors' &>/dev/null; then
    echo "    Error: Invalid token."
    echo "    ${ME_RESPONSE}"
    exit 1
fi

USER_NAME=$(echo "$ME_RESPONSE" | jq -r '.data.name')
echo "    Authenticated as: ${USER_NAME}"
echo "    Webhook URL: ${WEBHOOK_URL}"
echo ""

# --- List workspaces ---

echo "==> Fetching workspaces..."
WORKSPACES=$(curl -s -H "Authorization: Bearer ${ASANA_PAT}" "${ASANA_API}/workspaces")
WORKSPACE_COUNT=$(echo "$WORKSPACES" | jq '.data | length')

if [[ "$WORKSPACE_COUNT" -eq 0 ]]; then
    echo "    No workspaces found."
    exit 1
fi

echo ""
echo "    Available workspaces:"
echo "$WORKSPACES" | jq -r '.data[] | "    \(.gid)  \(.name)"'
echo ""

if [[ "$WORKSPACE_COUNT" -eq 1 ]]; then
    WORKSPACE_GID=$(echo "$WORKSPACES" | jq -r '.data[0].gid')
    WORKSPACE_NAME=$(echo "$WORKSPACES" | jq -r '.data[0].name')
    echo "    Using only workspace: ${WORKSPACE_NAME}"
else
    read -rp "    Enter workspace GID: " WORKSPACE_GID
    WORKSPACE_NAME=$(echo "$WORKSPACES" | jq -r --arg gid "$WORKSPACE_GID" '.data[] | select(.gid == $gid) | .name')
fi

# --- List projects ---

echo ""
echo "==> Fetching projects in '${WORKSPACE_NAME}'..."
PROJECTS=$(curl -s -H "Authorization: Bearer ${ASANA_PAT}" \
    "${ASANA_API}/projects?workspace=${WORKSPACE_GID}&limit=100")

echo ""
echo "    Available projects:"
echo "$PROJECTS" | jq -r '.data[] | "    \(.gid)  \(.name)"'
echo ""
echo "    Enter project GID(s) to watch (comma-separated), or 'all' for all projects:"
read -rp "    > " PROJECT_INPUT

if [[ "$PROJECT_INPUT" == "all" ]]; then
    PROJECT_GIDS=$(echo "$PROJECTS" | jq -r '.data[].gid')
else
    PROJECT_GIDS=$(echo "$PROJECT_INPUT" | tr ',' '\n' | sed 's/ //g')
fi

# --- Create webhooks ---

echo ""
echo "==> Creating webhooks..."
echo "    IMPORTANT: The webhook endpoint must be reachable right now"
echo "    (Asana will send a handshake request immediately)."
echo ""
read -rp "    Is your server running and reachable at ${WEBHOOK_URL}? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "    Start your server first, then re-run this script."
    exit 0
fi

CREATED=0
FAILED=0

for GID in $PROJECT_GIDS; do
    PROJECT_NAME=$(echo "$PROJECTS" | jq -r --arg gid "$GID" '.data[] | select(.gid == $gid) | .name')
    echo ""
    echo "    Creating webhook for project '${PROJECT_NAME}' (${GID})..."

    RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer ${ASANA_PAT}" \
        -H "Content-Type: application/json" \
        "${ASANA_API}/webhooks" \
        -d "{
            \"data\": {
                \"resource\": \"${GID}\",
                \"target\": \"${WEBHOOK_URL}\",
                \"filters\": [
                    {\"resource_type\": \"task\", \"action\": \"changed\"},
                    {\"resource_type\": \"task\", \"action\": \"added\"},
                    {\"resource_type\": \"task\", \"action\": \"removed\"},
                    {\"resource_type\": \"story\", \"action\": \"added\"}
                ]
            }
        }")

    if echo "$RESPONSE" | jq -e '.data.gid' &>/dev/null; then
        WEBHOOK_GID=$(echo "$RESPONSE" | jq -r '.data.gid')
        echo "    Webhook created: ${WEBHOOK_GID}"
        CREATED=$((CREATED + 1))
    else
        echo "    Failed to create webhook:"
        echo "    $(echo "$RESPONSE" | jq -r '.errors[0].message // .error // "Unknown error"')"
        FAILED=$((FAILED + 1))
    fi
done

# --- List existing webhooks ---

echo ""
echo "==> Current webhooks for workspace '${WORKSPACE_NAME}':"
EXISTING=$(curl -s -H "Authorization: Bearer ${ASANA_PAT}" \
    "${ASANA_API}/webhooks?workspace=${WORKSPACE_GID}")
echo "$EXISTING" | jq -r '.data[] | "    \(.gid)  resource=\(.resource.gid)  active=\(.active)  target=\(.target)"'

# --- Summary ---

echo ""
echo "=========================================="
echo "  Asana Webhook Setup Complete"
echo "=========================================="
echo ""
echo "  Workspace:   ${WORKSPACE_NAME}"
echo "  Webhook URL: ${WEBHOOK_URL}"
echo "  Created:     ${CREATED} webhook(s)"
if [[ "$FAILED" -gt 0 ]]; then
echo "  Failed:      ${FAILED} webhook(s)"
fi
echo ""
echo "  Notes:"
echo "  - Asana sends heartbeats every 8 hours"
echo "  - Webhooks are deleted if unresponsive for 24 hours"
echo "  - The handshake secret is auto-persisted by the server"
echo "  - To list webhooks: ASANA_PAT=<token> curl -s \\"
echo "      -H 'Authorization: Bearer <token>' \\"
echo "      '${ASANA_API}/webhooks?workspace=${WORKSPACE_GID}' | jq"
echo ""
