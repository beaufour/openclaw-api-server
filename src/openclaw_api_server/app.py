import logging

from fastapi import FastAPI

from openclaw_api_server.handlers import asana, gmail, strava

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="OpenClaw Webhook Receiver", version="0.1.0")

app.include_router(gmail.router)
app.include_router(asana.router)
app.include_router(strava.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
