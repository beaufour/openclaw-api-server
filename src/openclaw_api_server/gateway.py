import structlog
from httpx import AsyncClient, HTTPError

from openclaw_api_server.config import config

logger = structlog.get_logger(__name__)


async def forward_to_gateway(source: str, payload: dict) -> bool:
    """Forward a webhook event to the OpenClaw Gateway."""
    webhook_url = f"{config.gateway_url}/webhook"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if config.gateway_webhook_token:
        headers["Authorization"] = "Bearer [REDACTED]"
        # Use the real token for the actual request
        real_headers = {**headers, "Authorization": f"Bearer {config.gateway_webhook_token}"}
    else:
        real_headers = headers

    body = {
        "source": source,
        "payload": payload,
    }

    try:
        async with AsyncClient() as client:
            resp = await client.post(webhook_url, json=body, headers=real_headers, timeout=10.0)
            resp.raise_for_status()
            logger.info("Forwarded event to gateway", source=source, status=resp.status_code)
            return True
    except HTTPError as exc:
        logger.error("Failed to forward event to gateway", source=source, error=str(exc))
        return False
