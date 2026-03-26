"""General tests for Gmail webhook handler."""

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
            "publishTime": "2026-03-26T12:00:00Z",
        },
        "subscription": "projects/test/subscriptions/gmail-push",
    }


class TestGmailWebhook:
    @pytest.mark.asyncio
    async def test_forwards_email_notification(self, client, mock_forward):
        """Valid Gmail notification is decoded and forwarded to gateway."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = ""
            resp = await client.post("/webhook/gmail", json=_gmail_body())
        assert resp.status_code == 200
        mock_forward["gmail"].assert_called_once_with(
            "gmail",
            {
                "email_address": "test@example.com",
                "history_id": "12345",
                "message_id": "msg-1",
            },
        )

    @pytest.mark.asyncio
    async def test_handles_invalid_base64_data(self, client, mock_forward):
        """Invalid base64 data returns 200 (acknowledge) but doesn't forward."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = ""
            body = {"message": {"data": "not-valid-base64!!!", "messageId": "msg-2"}}
            resp = await client.post("/webhook/gmail", json=body)
        assert resp.status_code == 200
        mock_forward["gmail"].assert_not_called()

    @pytest.mark.asyncio
    async def test_handles_non_json_base64_data(self, client, mock_forward):
        """Base64-encoded non-JSON returns 200 but doesn't forward."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = ""
            body = {
                "message": {
                    "data": base64.b64encode(b"not json").decode(),
                    "messageId": "msg-3",
                },
            }
            resp = await client.post("/webhook/gmail", json=body)
        assert resp.status_code == 200
        mock_forward["gmail"].assert_not_called()

    @pytest.mark.asyncio
    async def test_handles_missing_message_fields(self, client, mock_forward):
        """Missing emailAddress/historyId defaults to 'unknown'."""
        with patch("openclaw_api_server.handlers.gmail.config") as mock_config:
            mock_config.gmail_pubsub_audience = ""
            data = json.dumps({})
            body = {"message": {"data": base64.b64encode(data.encode()).decode(), "messageId": "msg-4"}}
            resp = await client.post("/webhook/gmail", json=body)
        assert resp.status_code == 200
        call_args = mock_forward["gmail"].call_args[0]
        assert call_args[1]["email_address"] == "unknown"
        assert call_args[1]["history_id"] == "unknown"
