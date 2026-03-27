#!/usr/bin/env bash
#
# Set up Gmail Pub/Sub push notifications.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - A GCP project selected (gcloud config set project <project-id>)
#   - Billing enabled on the project
#   - OAuth consent screen configured in the GCP project
#     (APIs & Services > OAuth consent screen — can be "External" with
#      your Gmail account added as a test user)
#
# What this script does:
#   1. Enables the Gmail and Pub/Sub APIs
#   2. Creates a Pub/Sub topic for Gmail notifications
#   3. Grants Gmail API permission to publish to the topic
#   4. Creates a push subscription pointing to your webhook URL
#   5. Creates an OAuth2 client and opens browser for Gmail consent
#   6. Calls Gmail watch() to start receiving notifications
#   7. Creates a watch renewal script for cron
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
OAUTH_CLIENT_NAME="gmail-webhook-client"
GMAIL_SCOPE="https://mail.google.com/"
REDIRECT_URI="urn:ietf:wg:oauth:2.0:oob"

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

# Determine data directory for storing credentials
DATA_DIR="${DATA_DIR:-${HOME}/.openclaw-api-server}"
CREDENTIALS_FILE="${DATA_DIR}/gmail_oauth_credentials.json"

echo "    Project:     ${PROJECT}"
echo "    Webhook URL: ${WEBHOOK_URL}"
echo "    Data dir:    ${DATA_DIR}"
echo ""
read -rp "Continue with this project? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
fi

mkdir -p "$DATA_DIR"

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

# --- Step 6: OAuth2 for Gmail account ---

echo ""
echo "==> Setting up OAuth2 for Gmail access..."
echo "    This will open a browser for the Gmail account you want to monitor."
echo "    (This can be a DIFFERENT account from your GCP project account.)"
echo ""

# Check if we already have valid credentials
if [[ -f "$CREDENTIALS_FILE" ]]; then
    echo "    Found existing credentials at ${CREDENTIALS_FILE}"
    read -rp "    Use existing credentials? [Y/n] " use_existing
    if [[ "$use_existing" != "n" && "$use_existing" != "N" ]]; then
        # Try to refresh the token
        CLIENT_ID=$(jq -r '.client_id' "$CREDENTIALS_FILE")
        CLIENT_SECRET=$(jq -r '.client_secret' "$CREDENTIALS_FILE")
        REFRESH_TOKEN=$(jq -r '.refresh_token' "$CREDENTIALS_FILE")

        TOKEN_RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
            -d "client_id=${CLIENT_ID}" \
            -d "client_secret=${CLIENT_SECRET}" \
            -d "refresh_token=${REFRESH_TOKEN}" \
            -d "grant_type=refresh_token")

        ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')
        if [[ -n "$ACCESS_TOKEN" ]]; then
            echo "    Token refreshed successfully."
        else
            echo "    Token refresh failed. Will re-authenticate."
            rm -f "$CREDENTIALS_FILE"
        fi
    else
        rm -f "$CREDENTIALS_FILE"
    fi
fi

# Create OAuth client if we need new credentials
if [[ ! -f "$CREDENTIALS_FILE" ]]; then
    # OAuth client creation can't be automated via gcloud or API reliably.
    # The user must create one manually in the GCP console.
    echo ""
    echo "    You need an OAuth2 'Desktop app' client for Gmail access."
    echo "    Create one (or reuse an existing one) at:"
    echo ""
    echo "    https://console.cloud.google.com/apis/credentials?project=${PROJECT}"
    echo ""
    echo "    Steps: '+ CREATE CREDENTIALS' > 'OAuth client ID' > 'Desktop app'"
    echo ""
    read -rp "    Enter Client ID: " CLIENT_ID
    read -rp "    Enter Client Secret: " CLIENT_SECRET

    # Build authorization URL
    AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth"
    AUTH_URL+="?client_id=${CLIENT_ID}"
    AUTH_URL+="&redirect_uri=${REDIRECT_URI}"
    AUTH_URL+="&response_type=code"
    AUTH_URL+="&scope=${GMAIL_SCOPE}"
    AUTH_URL+="&access_type=offline"
    AUTH_URL+="&prompt=consent"

    echo ""
    echo "    Opening browser for Gmail authorization..."
    echo "    Sign in with the Gmail account you want to MONITOR (not your GCP account)."
    echo ""
    echo "    If the browser doesn't open, visit this URL:"
    echo "    ${AUTH_URL}"
    echo ""

    # Try to open browser
    open "$AUTH_URL" 2>/dev/null || xdg-open "$AUTH_URL" 2>/dev/null || true

    read -rp "    Paste the authorization code here: " AUTH_CODE

    # Exchange code for tokens
    TOKEN_RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        -d "code=${AUTH_CODE}" \
        -d "client_id=${CLIENT_ID}" \
        -d "client_secret=${CLIENT_SECRET}" \
        -d "redirect_uri=${REDIRECT_URI}" \
        -d "grant_type=authorization_code")

    ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')
    REFRESH_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.refresh_token // empty')

    if [[ -z "$ACCESS_TOKEN" || -z "$REFRESH_TOKEN" ]]; then
        echo "    Error: Failed to get tokens. Response:"
        echo "    ${TOKEN_RESPONSE}"
        exit 1
    fi

    # Save credentials (never log the actual tokens)
    jq -n \
        --arg client_id "$CLIENT_ID" \
        --arg client_secret "$CLIENT_SECRET" \
        --arg refresh_token "$REFRESH_TOKEN" \
        '{client_id: $client_id, client_secret: $client_secret, refresh_token: $refresh_token}' \
        > "$CREDENTIALS_FILE"
    chmod 600 "$CREDENTIALS_FILE"
    echo "    Credentials saved to ${CREDENTIALS_FILE}"
fi

# --- Step 7: Call Gmail watch() ---

echo ""
echo "==> Calling Gmail watch()..."

WATCH_RESPONSE=$(curl -s -X POST \
    "https://gmail.googleapis.com/gmail/v1/users/me/watch" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
        \"topicName\": \"${TOPIC_FULL}\",
        \"labelIds\": [\"INBOX\"]
    }")

if echo "$WATCH_RESPONSE" | jq -e '.historyId' &>/dev/null; then
    EXPIRATION=$(echo "$WATCH_RESPONSE" | jq -r '.expiration')
    EXPIRATION_DATE=$(date -r "$((EXPIRATION / 1000))" 2>/dev/null || date -d "@$((EXPIRATION / 1000))" 2>/dev/null || echo "$EXPIRATION")
    echo "    Gmail watch() activated successfully."
    echo "    Expires: ${EXPIRATION_DATE}"
else
    echo "    Warning: Gmail watch() may have failed. Response:"
    echo "    ${WATCH_RESPONSE}"
    echo ""
    echo "    Common issues:"
    echo "    - The Gmail account must have granted the OAuth consent"
    echo "    - The OAuth consent screen must list the Gmail account as a test user"
    echo "      (if the app is in 'Testing' status)"
    exit 1
fi

# --- Step 8: Create watch renewal script ---

echo ""
echo "==> Creating watch renewal script..."

RENEW_SCRIPT="${DATA_DIR}/renew-gmail-watch.sh"
cat > "$RENEW_SCRIPT" << RENEW_EOF
#!/usr/bin/env bash
# Auto-generated: renews Gmail watch() using stored OAuth credentials.
# Run daily via cron: 0 3 * * * ${RENEW_SCRIPT}
set -euo pipefail

CREDENTIALS_FILE="${CREDENTIALS_FILE}"
TOPIC_FULL="${TOPIC_FULL}"

CLIENT_ID=\$(jq -r '.client_id' "\$CREDENTIALS_FILE")
CLIENT_SECRET=\$(jq -r '.client_secret' "\$CREDENTIALS_FILE")
REFRESH_TOKEN=\$(jq -r '.refresh_token' "\$CREDENTIALS_FILE")

# Refresh access token
TOKEN_RESPONSE=\$(curl -s -X POST "https://oauth2.googleapis.com/token" \\
    -d "client_id=\${CLIENT_ID}" \\
    -d "client_secret=\${CLIENT_SECRET}" \\
    -d "refresh_token=\${REFRESH_TOKEN}" \\
    -d "grant_type=refresh_token")

ACCESS_TOKEN=\$(echo "\$TOKEN_RESPONSE" | jq -r '.access_token // empty')
if [[ -z "\$ACCESS_TOKEN" ]]; then
    echo "ERROR: Failed to refresh Gmail OAuth token" >&2
    exit 1
fi

# Call watch()
RESPONSE=\$(curl -s -X POST \\
    "https://gmail.googleapis.com/gmail/v1/users/me/watch" \\
    -H "Authorization: Bearer \${ACCESS_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\"topicName\": \"\${TOPIC_FULL}\", \"labelIds\": [\"INBOX\"]}")

if echo "\$RESPONSE" | jq -e '.historyId' &>/dev/null; then
    echo "Gmail watch() renewed successfully"
else
    echo "ERROR: Gmail watch() renewal failed: \$RESPONSE" >&2
    exit 1
fi
RENEW_EOF

chmod 700 "$RENEW_SCRIPT"
echo "    Created: ${RENEW_SCRIPT}"
echo ""
echo "    Add to cron for daily renewal:"
echo "      0 3 * * * ${RENEW_SCRIPT}"

# --- Summary ---

echo ""
echo "=========================================="
echo "  Gmail Pub/Sub Push Setup Complete"
echo "=========================================="
echo ""
echo "  Project:            ${PROJECT}"
echo "  Topic:              ${TOPIC_FULL}"
echo "  Subscription:       ${SUBSCRIPTION_NAME}"
echo "  Webhook URL:        ${WEBHOOK_URL}"
echo "  Credentials:        ${CREDENTIALS_FILE}"
echo "  Renewal script:     ${RENEW_SCRIPT}"
echo ""
echo "  Environment variables to set:"
echo "    GMAIL_PUBSUB_AUDIENCE=${WEBHOOK_URL}"
echo ""
echo "  To also enable DKIM verification:"
echo "    GMAIL_REQUIRE_DKIM=true"
echo ""
