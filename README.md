# OpenClaw API Server

Webhook receiver that accepts push notifications from external APIs and forwards them to your local [OpenClaw](https://openclaw.ai/) Gateway. Replaces expensive LLM-monitored polling with near-real-time push notifications.

## Architecture

```
Gmail (Pub/Sub Push) ──┐
Asana (Webhooks)    ───┼──→ Cloudflare Edge ──→ cloudflared tunnel ──→ this server (:8000) ──→ OpenClaw Gateway (:18789)
Strava (Webhooks)   ───┘
```

## Supported Services

| Service | Endpoint | Method | Notes |
|---------|----------|--------|-------|
| Gmail | `/webhook/gmail` | POST | Google Cloud Pub/Sub push delivery |
| Asana | `/webhook/asana` | POST | Handles handshake + HMAC-signed events |
| Strava | `/webhook/strava` | GET/POST | GET for subscription validation, POST for events |
| Health | `/health` | GET | Returns `{"status": "ok"}` |

## Setup

### Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) for tunneling
- An OpenClaw instance running locally

### Install & Run

```bash
# Install dependencies
uv sync

# Copy and edit environment config
cp .env.example .env
# Edit .env with your tokens

# Run the server
uv run python main.py
```

The server starts on `http://0.0.0.0:8000` by default.

### Cloudflare Tunnel

Expose the server to the internet without opening ports:

```bash
brew install cloudflared
cloudflared login
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw webhooks.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: openclaw
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: webhooks.yourdomain.com
    service: http://localhost:8000
  - service: http_status:404
```

Run the tunnel:

```bash
cloudflared tunnel run openclaw
```

### Registering Webhooks

#### Gmail (Pub/Sub Push)

1. Enable Gmail API + Pub/Sub API in Google Cloud Console
2. Create a Pub/Sub topic and grant publish permission to `gmail-api-push@system.gserviceaccount.com`
3. Create a push subscription pointing to `https://webhooks.yourdomain.com/webhook/gmail`
4. Call the Gmail API `watch()` method (must be renewed every 7 days)

#### Asana

1. Create a webhook via Asana API with callback URL `https://webhooks.yourdomain.com/webhook/asana`
2. The server handles the handshake automatically (echoes `X-Hook-Secret`)
3. Optionally set `ASANA_WEBHOOK_SECRET` in `.env` for signature validation

#### Strava

1. Set `STRAVA_VERIFY_TOKEN` in `.env` to a token of your choice
2. Register a webhook subscription via Strava API using the same verify token
3. Callback URL: `https://webhooks.yourdomain.com/webhook/strava`

## Development

```bash
# Lint
uv run ruff check src/ main.py

# Format
uv run ruff format src/ main.py

# Type check
uv run ty check src/ main.py
```

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL | `http://localhost:18789` |
| `OPENCLAW_WEBHOOK_TOKEN` | Bearer token for Gateway auth | (empty) |
| `ASANA_WEBHOOK_SECRET` | HMAC secret for Asana signature validation | (empty) |
| `STRAVA_VERIFY_TOKEN` | Token for Strava subscription validation | (empty) |
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | Server port | `8000` |
