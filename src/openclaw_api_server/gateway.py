import logging

import httpx

from openclaw_api_server.config import config

logger = logging.getLogger(__name__)


async def forward_to_gateway(source: str, payload: dict) -> bool:
    """Forward a webhook event to the OpenClaw Gateway."""
    webhook_url = f"{config.gateway_url}/webhook"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if config.gateway_webhook_token:
        headers["Authorization"] = f"Bearer {config.gateway_webhook_token}"

    body = {
        "source": source,
        "payload": payload,
    }

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(webhook_url, json=body, headers=headers, timeout=10.0)
            resp.raise_for_status()
            logger.info("Forwarded %s event to gateway (status=%d)", source, resp.status_code)
            return True
    except httpx.HTTPError:
        logger.exception("Failed to forward %s event to gateway", source)
        return False
