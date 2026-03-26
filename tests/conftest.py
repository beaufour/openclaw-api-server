from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from openclaw_api_server.app import app


@pytest.fixture
def mock_forward():
    """Mock the gateway forwarding so tests don't make real HTTP calls."""
    with patch("openclaw_api_server.handlers.gmail.forward_to_gateway", new_callable=AsyncMock) as gmail_mock, patch(
        "openclaw_api_server.handlers.asana.forward_to_gateway", new_callable=AsyncMock
    ) as asana_mock, patch(
        "openclaw_api_server.handlers.strava.forward_to_gateway", new_callable=AsyncMock
    ) as strava_mock:
        gmail_mock.return_value = True
        asana_mock.return_value = True
        strava_mock.return_value = True
        yield {
            "gmail": gmail_mock,
            "asana": asana_mock,
            "strava": strava_mock,
        }


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
