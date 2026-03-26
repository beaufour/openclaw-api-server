"""Security tests for Strava webhook path secret validation."""

from unittest.mock import patch

import pytest

STRAVA_SECRET = "my-strava-secret-xyz"
STRAVA_VERIFY_TOKEN = "my-verify-token"


def _strava_event() -> dict:
    return {
        "object_type": "activity",
        "object_id": 12345,
        "aspect_type": "create",
        "owner_id": 67890,
        "subscription_id": 999,
        "event_time": 1234567890,
    }


class TestStravaPathSecret:
    @pytest.mark.asyncio
    async def test_rejects_wrong_path_secret_on_event(self, client, mock_forward):
        """POST with wrong path secret returns 404."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.post("/webhook/strava/wrong-secret", json=_strava_event())
        assert resp.status_code == 404
        mock_forward["strava"].assert_not_called()

    @pytest.mark.asyncio
    async def test_accepts_correct_path_secret_on_event(self, client, mock_forward):
        """POST with correct path secret is accepted."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.post(f"/webhook/strava/{STRAVA_SECRET}", json=_strava_event())
        assert resp.status_code == 200
        mock_forward["strava"].assert_called_once()

    @pytest.mark.asyncio
    async def test_rejects_wrong_path_secret_on_validation(self, client):
        """GET validation with wrong path secret returns 404."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.get(
                "/webhook/strava/wrong-secret",
                params={
                    "hub.mode": "subscribe",
                    "hub.challenge": "test-challenge",
                    "hub.verify_token": STRAVA_VERIFY_TOKEN,
                },
            )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_404_not_401_for_wrong_secret(self, client, mock_forward):
        """Wrong path secret returns 404 (not 401/403) to avoid leaking endpoint existence."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.post("/webhook/strava/wrong", json=_strava_event())
        assert resp.status_code == 404
        # Ensure it's indistinguishable from a genuinely missing route
        assert "strava" not in resp.text.lower()

    @pytest.mark.asyncio
    async def test_skips_validation_when_secret_not_set(self, client, mock_forward):
        """When STRAVA_WEBHOOK_SECRET is empty, any path secret is accepted."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = ""
            resp = await client.post("/webhook/strava/anything-goes", json=_strava_event())
        assert resp.status_code == 200
        mock_forward["strava"].assert_called_once()


class TestStravaVerifyToken:
    @pytest.mark.asyncio
    async def test_rejects_wrong_verify_token(self, client):
        """Validation request with wrong verify token returns 403."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.get(
                f"/webhook/strava/{STRAVA_SECRET}",
                params={
                    "hub.mode": "subscribe",
                    "hub.challenge": "challenge-123",
                    "hub.verify_token": "wrong-token",
                },
            )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_accepts_correct_verify_token(self, client):
        """Validation request with correct verify token returns the challenge."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.get(
                f"/webhook/strava/{STRAVA_SECRET}",
                params={
                    "hub.mode": "subscribe",
                    "hub.challenge": "challenge-123",
                    "hub.verify_token": STRAVA_VERIFY_TOKEN,
                },
            )
        assert resp.status_code == 200
        assert resp.json() == {"hub.challenge": "challenge-123"}

    @pytest.mark.asyncio
    async def test_rejects_wrong_hub_mode(self, client):
        """Validation request with wrong hub.mode returns 400."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.get(
                f"/webhook/strava/{STRAVA_SECRET}",
                params={
                    "hub.mode": "unsubscribe",
                    "hub.challenge": "challenge-123",
                    "hub.verify_token": STRAVA_VERIFY_TOKEN,
                },
            )
        assert resp.status_code == 400
