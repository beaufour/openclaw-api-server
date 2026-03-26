"""Strava webhook handler.

Strava webhooks have two phases:
1. Validation: GET with hub.verify_token, hub.challenge, hub.mode - must return hub.challenge
2. Events: POST with JSON body containing activity/athlete event data

Auth: Strava does NOT sign webhook payloads. We use a secret token in the URL path
as the only defense. The webhook callback URL should be registered as:
  https://webhooks.yourdomain.com/webhook/strava/<STRAVA_WEBHOOK_SECRET>
"""

import logging

from fastapi import APIRouter, Path, Query, Request, Response
from fastapi.responses import JSONResponse

from openclaw_api_server.config import config
from openclaw_api_server.gateway import forward_to_gateway

logger = logging.getLogger(__name__)
router = APIRouter()


def _validate_path_secret(path_secret: str) -> bool:
    if not config.strava_webhook_secret:
        logger.warning("STRAVA_WEBHOOK_SECRET not set, skipping path secret validation")
        return True
    return path_secret == config.strava_webhook_secret


@router.get("/webhook/strava/{path_secret}")
async def strava_validation(
    path_secret: str = Path(),
    hub_mode: str = Query(alias="hub.mode"),
    hub_challenge: str = Query(alias="hub.challenge"),
    hub_verify_token: str = Query(alias="hub.verify_token"),
) -> Response:
    """Handle Strava subscription validation callback."""
    if not _validate_path_secret(path_secret):
        return Response(status_code=404)

    if hub_mode != "subscribe":
        return Response(status_code=400)

    if config.strava_verify_token and hub_verify_token != config.strava_verify_token:
        logger.warning("Strava verify token mismatch")
        return Response(status_code=403)

    logger.info("Strava webhook validation successful")
    return JSONResponse({"hub.challenge": hub_challenge})


@router.post("/webhook/strava/{path_secret}")
async def strava_webhook(path_secret: str, request: Request) -> Response:
    """Handle Strava event notifications."""
    if not _validate_path_secret(path_secret):
        return Response(status_code=404)

    body = await request.json()

    object_type = body.get("object_type", "unknown")
    aspect_type = body.get("aspect_type", "unknown")
    object_id = body.get("object_id")
    owner_id = body.get("owner_id")

    logger.info("Strava event: %s %s (object=%s, owner=%s)", aspect_type, object_type, object_id, owner_id)

    await forward_to_gateway("strava", body)

    return Response(status_code=200)
