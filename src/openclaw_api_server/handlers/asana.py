"""Asana webhook handler.

Asana webhooks have two phases:
1. Handshake: POST with X-Hook-Secret header, must echo it back with 200
2. Events: POST with JSON body containing events array, signed with HMAC-SHA256

Auth: Asana signs every event delivery with HMAC-SHA256 using the secret from the
handshake. We persist the secret to a file so it survives restarts.
"""

import hashlib
import hmac
import json
from pathlib import Path

import structlog
from fastapi import APIRouter, Request, Response

from openclaw_api_server.config import config
from openclaw_api_server.gateway import forward_to_gateway

logger = structlog.get_logger(__name__)
router = APIRouter()

_SECRETS_FILE = Path(config.data_dir) / "asana_hook_secrets.json"


def _load_secrets() -> dict[str, str]:
    if _SECRETS_FILE.exists():
        return json.loads(_SECRETS_FILE.read_text())
    return {}


def _save_secret(key: str, secret: str) -> None:
    secrets = _load_secrets()
    secrets[key] = secret
    _SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SECRETS_FILE.write_text(json.dumps(secrets))
    logger.info("Asana hook secret persisted", path=str(_SECRETS_FILE))


def _get_secret() -> str:
    """Get the webhook secret, preferring env var over persisted file."""
    if config.asana_webhook_secret:
        return config.asana_webhook_secret
    secrets = _load_secrets()
    return secrets.get("default", "")


@router.post("/webhook/asana")
async def asana_webhook(request: Request) -> Response:
    # Phase 1: Handshake
    hook_secret = request.headers.get("X-Hook-Secret")
    if hook_secret:
        logger.info("Asana webhook handshake received")
        _save_secret("default", hook_secret)
        return Response(
            status_code=200,
            headers={"X-Hook-Secret": hook_secret},
        )

    # Phase 2: Event delivery — require signature validation
    signature = request.headers.get("X-Hook-Signature")
    body_bytes = await request.body()
    secret = _get_secret()

    if not secret:
        logger.error("No Asana webhook secret available, rejecting request")
        return Response(status_code=500)

    if not signature:
        logger.warning("Missing X-Hook-Signature header")
        return Response(status_code=401)

    expected = hmac.new(secret.encode(), body_bytes, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        logger.warning("Asana webhook signature mismatch")
        return Response(status_code=401)

    logger.debug("Asana webhook signature validated")

    body = json.loads(body_bytes)
    events = body.get("events", [])

    if not events:
        logger.debug("Asana heartbeat acknowledged")
        return Response(status_code=200)

    logger.info("Asana webhook events received", event_count=len(events))
    await forward_to_gateway("asana", {"events": events})

    return Response(status_code=200)
