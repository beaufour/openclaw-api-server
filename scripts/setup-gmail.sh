#!/usr/bin/env bash
#
# Set up Gmail Pub/Sub push notifications.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - A GCP project selected (gcloud config set project <project-id>)
#   - Billing enabled on the project
#
# What this script does:
#   1. Enables the Gmail and Pub/Sub APIs
#   2. Creates a Pub/Sub topic for Gmail notifications
#   3. Grants Gmail API permission to publish to the topic
#   4. Creates a push subscription pointing to your webhook URL
#   5. Calls Gmail watch() to start receiving notifications
#
# Usage:
#   ./scripts/setup-gmail.sh <domain>
#
# Example:
#   ./scripts/setup-gmail.sh webhooks.example.com
#
set -euo pipefail

TOPIC_NAME="gmail-notifications"
SUBSCRIPTION_NAME="gmail-push"
GMAIL_PUBLISH_SA="gmail-api-push@system.gserviceaccount.com"

# --- Argument parsing ---

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 webhooks.example.com"
    exit 1
fi

DOMAIN="$1"
WEBHOOK_URL="https://${DOMAIN}/webhook/gmail"

# --- Verify prerequisites ---

echo "==> Checking prerequisites..."

if ! command -v gcloud &>/dev/null; then
    echo "Error: gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
    exit 1
fi

PROJECT=$(gcloud config get-value project 2>/dev/null)
if [[ -z "$PROJECT" ]]; then
    echo "Error: No GCP project set. Run: gcloud config set project <project-id>"
    exit 1
fi

echo "    Project: ${PROJECT}"
echo "    Webhook URL: ${WEBHOOK_URL}"
echo ""
read -rp "Continue with this project? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
fi

# --- Step 1: Enable APIs ---

echo ""
echo "==> Enabling Gmail and Pub/Sub APIs..."
gcloud services enable gmail.googleapis.com pubsub.googleapis.com --quiet

# --- Step 2: Create Pub/Sub topic ---

echo ""
echo "==> Creating Pub/Sub topic '${TOPIC_NAME}'..."
if gcloud pubsub topics describe "$TOPIC_NAME" &>/dev/null; then
    echo "    Topic already exists, skipping."
else
    gcloud pubsub topics create "$TOPIC_NAME"
    echo "    Topic created."
fi

TOPIC_FULL="projects/${PROJECT}/topics/${TOPIC_NAME}"

# --- Step 3: Grant Gmail publish permission ---

echo ""
echo "==> Granting Gmail API publish permission on topic..."
gcloud pubsub topics add-iam-policy-binding "$TOPIC_NAME" \
    --member="serviceAccount:${GMAIL_PUBLISH_SA}" \
    --role="roles/pubsub.publisher" \
    --quiet >/dev/null
echo "    Granted pubsub.publisher to ${GMAIL_PUBLISH_SA}"

# --- Step 4: Create push subscription ---

echo ""
echo "==> Creating push subscription '${SUBSCRIPTION_NAME}'..."
if gcloud pubsub subscriptions describe "$SUBSCRIPTION_NAME" &>/dev/null; then
    echo "    Subscription already exists. Updating push endpoint..."
    gcloud pubsub subscriptions update "$SUBSCRIPTION_NAME" \
        --push-endpoint="$WEBHOOK_URL" \
        --quiet
else
    gcloud pubsub subscriptions create "$SUBSCRIPTION_NAME" \
        --topic="$TOPIC_NAME" \
        --push-endpoint="$WEBHOOK_URL" \
        --ack-deadline=30 \
        --quiet
    echo "    Subscription created."
fi

# --- Step 5: Enable OIDC token on push subscription (for JWT validation) ---

echo ""
echo "==> Configuring OIDC authentication on push subscription..."

# Create a service account for Pub/Sub to use when pushing
PUSH_SA_NAME="pubsub-gmail-push"
PUSH_SA_EMAIL="${PUSH_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

if gcloud iam service-accounts describe "$PUSH_SA_EMAIL" &>/dev/null 2>&1; then
    echo "    Service account ${PUSH_SA_NAME} already exists."
else
    gcloud iam service-accounts create "$PUSH_SA_NAME" \
        --display-name="Pub/Sub Gmail Push" \
        --quiet
    echo "    Service account created: ${PUSH_SA_EMAIL}"
fi

# Grant the SA permission to create tokens
gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${PUSH_SA_EMAIL}" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --condition=None \
    --quiet >/dev/null

# Update subscription to use OIDC token (must include --push-endpoint alongside auth flags)
gcloud pubsub subscriptions update "$SUBSCRIPTION_NAME" \
    --push-endpoint="$WEBHOOK_URL" \
    --push-auth-service-account="$PUSH_SA_EMAIL" \
    --push-auth-token-audience="$WEBHOOK_URL" \
    --quiet
echo "    OIDC token configured. Set GMAIL_PUBSUB_AUDIENCE=${WEBHOOK_URL}"

# --- Step 6: Call Gmail watch() ---

echo ""
echo "==> Setting up Gmail watch()..."
echo "    This requires OAuth credentials for your Gmail account."
echo ""

# Check if user is authenticated with a user account (not just service account)
ACCOUNT=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | head -1)
echo "    Active account: ${ACCOUNT}"

# Use curl with gcloud access token to call Gmail API
ACCESS_TOKEN=$(gcloud auth print-access-token 2>/dev/null) || {
    echo ""
    echo "    Could not get access token. You may need to run:"
    echo "      gcloud auth login --scopes=https://mail.google.com/"
    echo "    Then re-run this script."
    exit 1
}

WATCH_RESPONSE=$(curl -s -X POST \
    "https://gmail.googleapis.com/gmail/v1/users/me/watch" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
        \"topicName\": \"${TOPIC_FULL}\",
        \"labelIds\": [\"INBOX\"]
    }")

if echo "$WATCH_RESPONSE" | grep -q '"historyId"'; then
    EXPIRATION=$(echo "$WATCH_RESPONSE" | grep -o '"expiration": *"[^"]*"' | head -1)
    echo "    Gmail watch() activated successfully."
    echo "    ${EXPIRATION}"
    echo ""
    echo "    IMPORTANT: watch() expires every 7 days. Set up a daily cron to renew:"
    echo "      0 3 * * * gcloud auth print-access-token | xargs -I{} curl -s -X POST \\"
    echo "        'https://gmail.googleapis.com/gmail/v1/users/me/watch' \\"
    echo "        -H 'Authorization: Bearer {}' \\"
    echo "        -H 'Content-Type: application/json' \\"
    echo "        -d '{\"topicName\": \"${TOPIC_FULL}\", \"labelIds\": [\"INBOX\"]}'"
else
    echo "    Warning: Gmail watch() may have failed. Response:"
    echo "    ${WATCH_RESPONSE}"
    echo ""
    echo "    If you see a permission error, try:"
    echo "      gcloud auth login --scopes=https://mail.google.com/"
    echo "    Then re-run this script."
fi

# --- Summary ---

echo ""
echo "=========================================="
echo "  Gmail Pub/Sub Push Setup Complete"
echo "=========================================="
echo ""
echo "  Project:       ${PROJECT}"
echo "  Topic:         ${TOPIC_FULL}"
echo "  Subscription:  ${SUBSCRIPTION_NAME}"
echo "  Webhook URL:   ${WEBHOOK_URL}"
echo ""
echo "  Environment variables to set:"
echo "    GMAIL_PUBSUB_AUDIENCE=${WEBHOOK_URL}"
echo ""
echo "  To also enable DKIM verification:"
echo "    GMAIL_REQUIRE_DKIM=true"
echo ""
