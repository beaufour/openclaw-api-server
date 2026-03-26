"""Security tests for Asana webhook HMAC signature validation."""

import hashlib
import hmac
import json
from unittest.mock import patch

import pytest


ASANA_SECRET = "test-asana-secret-12345"


def _sign(body: bytes, secret: str = ASANA_SECRET) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _events_body(events: list | None = None) -> bytes:
    if events is None:
        events = [{"action": "changed", "resource": {"gid": "123", "resource_type": "task"}}]
    return json.dumps({"events": events}).encode()


class TestAsanaHandshake:
    @pytest.mark.asyncio
    async def test_handshake_echoes_secret(self, client):
        """Handshake request with X-Hook-Secret should echo it back."""
        resp = await client.post(
            "/webhook/asana",
            content=b"",
            headers={"X-Hook-Secret": "new-secret-abc"},
        )
        assert resp.status_code == 200
        assert resp.headers["X-Hook-Secret"] == "new-secret-abc"

    @pytest.mark.asyncio
    async def test_handshake_persists_secret(self, client, tmp_path):
        """Handshake should persist the secret to disk."""
        secrets_file = tmp_path / "asana_hook_secrets.json"
        with patch("openclaw_api_server.handlers.asana._SECRETS_FILE", secrets_file):
            await client.post(
                "/webhook/asana",
                content=b"",
                headers={"X-Hook-Secret": "persisted-secret"},
            )
        stored = json.loads(secrets_file.read_text())
        assert stored["default"] == "persisted-secret"


class TestAsanaSignatureValidation:
    @pytest.mark.asyncio
    async def test_rejects_missing_signature(self, client, mock_forward):
        """Requests without X-Hook-Signature are rejected."""
        body = _events_body()
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post("/webhook/asana", content=body)
        assert resp.status_code == 401
        mock_forward["asana"].assert_not_called()

    @pytest.mark.asyncio
    async def test_rejects_invalid_signature(self, client, mock_forward):
        """Requests with wrong HMAC signature are rejected."""
        body = _events_body()
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": "deadbeef" * 8},
            )
        assert resp.status_code == 401
        mock_forward["asana"].assert_not_called()

    @pytest.mark.asyncio
    async def test_rejects_signature_from_wrong_secret(self, client, mock_forward):
        """Signature computed with a different secret is rejected."""
        body = _events_body()
        wrong_sig = _sign(body, secret="wrong-secret")
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": wrong_sig},
            )
        assert resp.status_code == 401
        mock_forward["asana"].assert_not_called()

    @pytest.mark.asyncio
    async def test_accepts_valid_signature(self, client, mock_forward):
        """Correctly signed requests are accepted."""
        body = _events_body()
        sig = _sign(body)
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": sig},
            )
        assert resp.status_code == 200
        mock_forward["asana"].assert_called_once()

    @pytest.mark.asyncio
    async def test_rejects_when_no_secret_available(self, client, mock_forward):
        """When no secret is available at all, returns 500."""
        body = _events_body()
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=""):
            resp = await client.post("/webhook/asana", content=body)
        assert resp.status_code == 500
        mock_forward["asana"].assert_not_called()

    @pytest.mark.asyncio
    async def test_signature_validated_against_exact_body_bytes(self, client, mock_forward):
        """Signature must match the exact bytes received, not a re-serialized version."""
        body = b'{"events":[{"action":"changed"}]}'
        sig = _sign(body)
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body,
                headers={"X-Hook-Signature": sig},
            )
        assert resp.status_code == 200

        # Same logical JSON but different bytes should fail
        body_reformatted = b'{"events": [{"action": "changed"}]}'
        with patch("openclaw_api_server.handlers.asana._get_secret", return_value=ASANA_SECRET):
            resp = await client.post(
                "/webhook/asana",
                content=body_reformatted,
                headers={"X-Hook-Signature": sig},
            )
        assert resp.status_code == 401
