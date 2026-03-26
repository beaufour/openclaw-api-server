"""Security tests for Gmail Pub/Sub webhook authentication."""

import base64
import json
from unittest.mock import patch

import pytest


def _gmail_body(email: str = "test@example.com", history_id: str = "12345") -> dict:
    data = json.dumps({"emailAddress": email, "historyId": history_id})
    return {
        "message": {
            "data": base64.b64encode(data.encode()).decode(),
            "messageId": "msg-1",
        },
        "subscription": "projects/test/subscriptions/gmail-push",
    }


class TestGmailAuth:
    @pytest.mark.asyncio
    async def test_rejects_missing_auth_header_when_audience_set(self, client, mock_forward):
        """When GMAIL_PUBSUB_AUDIENCE is configured, requests without Authorization header are rejected."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = "https://webhooks.example.com/webhook/gmail"
            resp = await client.post("/webhook/gmail", json=_gmail_body())
        assert resp.status_code == 401
        mock_forward["gmail"].assert_not_called()

    @pytest.mark.asyncio
    async def test_rejects_non_bearer_auth_header(self, client, mock_forward):
        """Non-Bearer authorization schemes are rejected."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = "https://webhooks.example.com/webhook/gmail"
            resp = await client.post(
                "/webhook/gmail",
                json=_gmail_body(),
                headers={"Authorization": "Basic dXNlcjpwYXNz"},
            )
        assert resp.status_code == 401
        mock_forward["gmail"].assert_not_called()

    @pytest.mark.asyncio
    async def test_rejects_invalid_jwt_token(self, client, mock_forward):
        """Invalid JWT tokens are rejected."""
        with (
            patch("openclaw_api_server.handlers.gmail.config") as mock_config,
            patch("openclaw_api_server.handlers.gmail.id_token") as mock_id_token,
        ):
            mock_config.gmail_pubsub_audience = "https://webhooks.example.com/webhook/gmail"
            mock_id_token.verify_oauth2_token.side_effect = ValueError("Invalid token")
            resp = await client.post(
                "/webhook/gmail",
                json=_gmail_body(),
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert resp.status_code == 401
        mock_forward["gmail"].assert_not_called()

    @pytest.mark.asyncio
    async def test_accepts_valid_jwt_token(self, client, mock_forward):
        """Valid JWT tokens are accepted and the request is processed."""
        with (
            patch("openclaw_api_server.handlers.gmail.config") as mock_config,
            patch("openclaw_api_server.handlers.gmail.id_token") as mock_id_token,
        ):
            mock_config.gmail_pubsub_audience = "https://webhooks.example.com/webhook/gmail"
            mock_id_token.verify_oauth2_token.return_value = {"email": "pubsub@google.com"}
            resp = await client.post(
                "/webhook/gmail",
                json=_gmail_body(),
                headers={"Authorization": "Bearer valid-jwt-token"},
            )
        assert resp.status_code == 200
        mock_forward["gmail"].assert_called_once()

    @pytest.mark.asyncio
    async def test_skips_auth_when_audience_not_set(self, client, mock_forward):
        """When GMAIL_PUBSUB_AUDIENCE is empty, auth is skipped (allows testing)."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = ""
            resp = await client.post("/webhook/gmail", json=_gmail_body())
        assert resp.status_code == 200
        mock_forward["gmail"].assert_called_once()

    @pytest.mark.asyncio
    async def test_rejects_empty_bearer_token(self, client, mock_forward):
        """Empty bearer token is rejected."""
        with (
            patch("openclaw_api_server.handlers.gmail.config") as mock_config,
            patch("openclaw_api_server.handlers.gmail.id_token") as mock_id_token,
        ):
            mock_config.gmail_pubsub_audience = "https://webhooks.example.com/webhook/gmail"
            mock_id_token.verify_oauth2_token.side_effect = ValueError("Empty token")
            resp = await client.post(
                "/webhook/gmail",
                json=_gmail_body(),
                headers={"Authorization": "Bearer "},
            )
        assert resp.status_code == 401
