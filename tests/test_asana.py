"""General tests for Asana webhook handler."""

import hashlib
import hmac
import json
from unittest.mock import patch

import pytest


ASANA_SECRET = "test-secret"


def _sign(body: bytes, secret: str = ASANA_SECRET) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class TestAsanaWebhook:
    @pytest.mark.asyncio
    async def test_forwards_events(self, client, mock_forward):
        """Valid signed events are forwarded to gateway."""
        events = [{"action": "changed", "resource": {"gid": "123", "resource_type": "task"}}]
        body = json.dumps({"events": events}).encode()
        sig = _sign(body)
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": sig},
            )
        assert resp.status_code == 200
        mock_forward["asana"].assert_called_once_with("asana", {"events": events})

    @pytest.mark.asyncio
    async def test_heartbeat_not_forwarded(self, client, mock_forward):
        """Heartbeat (empty events) is acknowledged but not forwarded."""
        body = json.dumps({"events": []}).encode()
        sig = _sign(body)
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": sig},
            )
        assert resp.status_code == 200
        mock_forward["asana"].assert_not_called()

    @pytest.mark.asyncio
    async def test_multiple_events_forwarded(self, client, mock_forward):
        """Multiple events in a single delivery are all forwarded."""
        events = [
            {"action": "changed", "resource": {"gid": "1"}},
            {"action": "added", "resource": {"gid": "2"}},
            {"action": "removed", "resource": {"gid": "3"}},
        ]
        body = json.dumps({"events": events}).encode()
        sig = _sign(body)
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": sig},
            )
        assert resp.status_code == 200
        call_payload = mock_forward["asana"].call_args[0][1]
        assert len(call_payload["events"]) == 3
