import os

from fastapi import FastAPI

from openclaw_api_server.handlers import asana, gmail, strava
from openclaw_api_server.logging import setup_logging

setup_logging(debug=os.environ.get("DEBUG", "").lower() in ("1", "true"))

app = FastAPI(title="OpenClaw Webhook Receiver", version="0.1.0")

app.include_router(gmail.router)
app.include_router(asana.router)
app.include_router(strava.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
