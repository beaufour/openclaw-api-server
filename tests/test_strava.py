"""General tests for Strava webhook handler."""

from unittest.mock import patch

import pytest

STRAVA_SECRET = "test-strava-secret"
STRAVA_VERIFY_TOKEN = "test-verify"


def _strava_event(**overrides) -> dict:
    event = {
        "object_type": "activity",
        "object_id": 12345,
        "aspect_type": "create",
        "owner_id": 67890,
        "subscription_id": 999,
        "event_time": 1234567890,
    }
    event.update(overrides)
    return event


class TestStravaWebhook:
    @pytest.mark.asyncio
    async def test_forwards_activity_event(self, client, mock_forward):
        """Activity create event is forwarded to gateway."""
        event = _strava_event()
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            resp = await client.post(f"/webhook/strava/{STRAVA_SECRET}", json=event)
        assert resp.status_code == 200
        mock_forward["strava"].assert_called_once_with("strava", event)

    @pytest.mark.asyncio
    async def test_forwards_athlete_event(self, client, mock_forward):
        """Athlete update event is forwarded."""
        event = _strava_event(object_type="athlete", aspect_type="update")
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            resp = await client.post(f"/webhook/strava/{STRAVA_SECRET}", json=event)
        assert resp.status_code == 200
        mock_forward["strava"].assert_called_once()

    @pytest.mark.asyncio
    async def test_validation_returns_challenge(self, client):
        """Validation request returns the hub.challenge value."""
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            mock_config.strava_verify_token = STRAVA_VERIFY_TOKEN
            resp = await client.get(
                f"/webhook/strava/{STRAVA_SECRET}",
                params={
                    "hub.mode": "subscribe",
                    "hub.challenge": "abc123",
                    "hub.verify_token": STRAVA_VERIFY_TOKEN,
                },
            )
        assert resp.status_code == 200
        assert resp.json() == {"hub.challenge": "abc123"}


class TestStravaGatewayForwarding:
    @pytest.mark.asyncio
    async def test_forwards_full_payload(self, client, mock_forward):
        """The complete event payload is forwarded unchanged."""
        event = _strava_event(object_id=99999, owner_id=11111)
        with patch("openclaw_api_server.handlers.strava.config") as mock_config:
            mock_config.strava_webhook_secret = STRAVA_SECRET
            resp = await client.post(f"/webhook/strava/{STRAVA_SECRET}", json=event)
        assert resp.status_code == 200
        forwarded = mock_forward["strava"].call_args[0][1]
        assert forwarded["object_id"] == 99999
        assert forwarded["owner_id"] == 11111
