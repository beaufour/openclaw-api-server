"""Tests for gateway forwarding."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from openclaw_api_server.gateway import forward_to_gateway


def _mock_response(status_code: int = 200) -> httpx.Response:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.raise_for_status = MagicMock()
    return resp


class TestForwardToGateway:
    @pytest.mark.asyncio
    async def test_forwards_payload(self):
        """Payload is POSTed to the gateway webhook endpoint."""
        with patch("openclaw_api_server.gateway.config") as mock_config:
            mock_config.gateway_url = "http://localhost:18789"
            mock_config.gateway_webhook_token = ""

            with patch("openclaw_api_server.gateway.AsyncClient") as mock_client_cls:
                mock_client = mock_client_cls.return_value.__aenter__.return_value
                mock_client.post = AsyncMock(return_value=_mock_response())

                result = await forward_to_gateway("gmail", {"key": "value"})

        assert result is True
        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args
        assert call_kwargs[1]["json"] == {"source": "gmail", "payload": {"key": "value"}}

    @pytest.mark.asyncio
    async def test_returns_false_on_http_error(self):
        """Returns False when gateway returns an error."""
        with patch("openclaw_api_server.gateway.config") as mock_config:
            mock_config.gateway_url = "http://localhost:18789"
            mock_config.gateway_webhook_token = ""

            with patch("openclaw_api_server.gateway.AsyncClient") as mock_client_cls:
                mock_client = mock_client_cls.return_value.__aenter__.return_value
                mock_client.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

                result = await forward_to_gateway("asana", {"events": []})

        assert result is False

    @pytest.mark.asyncio
    async def test_includes_auth_header_when_token_set(self):
        """Bearer token is included when OPENCLAW_WEBHOOK_TOKEN is set."""
        with patch("openclaw_api_server.gateway.config") as mock_config:
            mock_config.gateway_url = "http://localhost:18789"
            mock_config.gateway_webhook_token = "secret-token"

            with patch("openclaw_api_server.gateway.AsyncClient") as mock_client_cls:
                mock_client = mock_client_cls.return_value.__aenter__.return_value
                mock_client.post = AsyncMock(return_value=_mock_response())

                await forward_to_gateway("strava", {})

        call_kwargs = mock_client.post.call_args
        headers = call_kwargs[1]["headers"]
        assert headers["Authorization"] == "Bearer secret-token"

    @pytest.mark.asyncio
    async def test_no_auth_header_when_token_empty(self):
        """No Authorization header when token is not configured."""
        with patch("openclaw_api_server.gateway.config") as mock_config:
            mock_config.gateway_url = "http://localhost:18789"
            mock_config.gateway_webhook_token = ""

            with patch("openclaw_api_server.gateway.AsyncClient") as mock_client_cls:
                mock_client = mock_client_cls.return_value.__aenter__.return_value
                mock_client.post = AsyncMock(return_value=_mock_response())

                await forward_to_gateway("gmail", {})

        call_kwargs = mock_client.post.call_args
        headers = call_kwargs[1]["headers"]
        assert "Authorization" not in headers
