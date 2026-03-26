# CLAUDE.md

## Project Overview

FastAPI webhook receiver that sits between external API push notifications (Gmail, Asana, Strava) and a local OpenClaw Gateway. Validates webhook signatures, normalizes payloads, and forwards events to the Gateway.

## Tech Stack

- Python 3.13+, managed with `uv`
- FastAPI + uvicorn for the HTTP server
- httpx for forwarding requests to OpenClaw Gateway
- ruff for linting and formatting
- ty for type checking

## Project Structure

```
src/openclaw_api_server/
├── app.py           # FastAPI app, mounts all routers
├── config.py        # Env-based configuration (singleton)
├── gateway.py       # Forwards events to OpenClaw Gateway
└── handlers/
    ├── gmail.py     # Gmail Pub/Sub push handler
    ├── asana.py     # Asana webhook handler (handshake + HMAC + events)
    └── strava.py    # Strava webhook handler (validation + events)
```

Entrypoint: `main.py`

## Commands

```bash
uv sync                              # Install dependencies
uv run python main.py                # Run the server
uv run ruff check src/ main.py       # Lint
uv run ruff format src/ main.py      # Format
uv run ty check src/ main.py         # Type check
```

## Key Patterns

- Each service handler is a FastAPI `APIRouter` in `handlers/`
- All handlers forward normalized payloads through `gateway.forward_to_gateway(source, payload)`
- Config is loaded from environment variables at import time (`config.py`)
- Webhook endpoints always return 200 to acknowledge receipt (even on internal errors), to prevent retry storms from upstream services

## Adding a New Service

1. Create `src/openclaw_api_server/handlers/newservice.py` with a `router = APIRouter()`
2. Add webhook endpoint(s) on the router
3. Call `forward_to_gateway("newservice", payload)` to send events to OpenClaw
4. Include the router in `app.py`: `app.include_router(newservice.router)`
5. Add any config vars to `config.py` and `.env.example`
