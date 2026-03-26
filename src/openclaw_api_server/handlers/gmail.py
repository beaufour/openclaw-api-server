"""Gmail Pub/Sub push notification handler.

Google Cloud Pub/Sub sends POST requests with a JSON body containing:
{
  "message": {
    "data": "<base64-encoded>",  // contains {"emailAddress": "...", "historyId": "..."}
    "messageId": "...",
    "publishTime": "..."
  },
  "subscription": "projects/.../subscriptions/..."
}

Auth: Pub/Sub push subscriptions can be configured with an OIDC token. When enabled,
Pub/Sub sends a JWT bearer token in the Authorization header, signed by Google. We
validate the token's signature, issuer, and audience.
"""

import base64
import json
import logging

from fastapi import APIRouter, Request, Response
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from openclaw_api_server.config import config
from openclaw_api_server.gateway import forward_to_gateway

logger = logging.getLogger(__name__)
router = APIRouter()


def _verify_pubsub_token(request: Request) -> bool:
    """Verify the OIDC JWT bearer token from Pub/Sub."""
    if not config.gmail_pubsub_audience:
        logger.warning("GMAIL_PUBSUB_AUDIENCE not set, skipping token validation")
        return True

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        logger.warning("Gmail webhook: missing or invalid Authorization header")
        return False

    token = auth_header.removeprefix("Bearer ")
    try:
        claim = id_token.verify_oauth2_token(token, google_requests.Request(), audience=config.gmail_pubsub_audience)
        logger.debug("Gmail Pub/Sub token verified: email=%s", claim.get("email"))
        return True
    except ValueError:
        logger.warning("Gmail webhook: invalid JWT token")
        return False


@router.post("/webhook/gmail")
async def gmail_webhook(request: Request) -> Response:
    if not _verify_pubsub_token(request):
        return Response(status_code=401)

    body = await request.json()

    message = body.get("message", {})
    data_b64 = message.get("data", "")

    try:
        data = json.loads(base64.b64decode(data_b64))
    except (json.JSONDecodeError, ValueError):
        logger.warning("Failed to decode Gmail Pub/Sub message data")
        # Still return 200 to acknowledge, otherwise Pub/Sub retries
        return Response(status_code=200)

    email_address = data.get("emailAddress", "unknown")
    history_id = data.get("historyId", "unknown")
    logger.info("Gmail notification: email=%s historyId=%s", email_address, history_id)

    await forward_to_gateway(
        "gmail",
        {
            "email_address": email_address,
            "history_id": history_id,
            "message_id": message.get("messageId"),
        },
    )

    # Always return 200 to acknowledge the Pub/Sub message
    return Response(status_code=200)
