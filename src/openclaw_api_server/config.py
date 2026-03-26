import os


class Config:
    """Configuration loaded from environment variables."""

    # OpenClaw Gateway
    gateway_url: str = os.environ.get("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    gateway_webhook_token: str = os.environ.get("OPENCLAW_WEBHOOK_TOKEN", "")

    # Asana
    asana_webhook_secret: str = os.environ.get("ASANA_WEBHOOK_SECRET", "")

    # Strava
    strava_verify_token: str = os.environ.get("STRAVA_VERIFY_TOKEN", "")
    strava_webhook_secret: str = os.environ.get("STRAVA_WEBHOOK_SECRET", "")

    # Gmail Pub/Sub
    gmail_pubsub_audience: str = os.environ.get("GMAIL_PUBSUB_AUDIENCE", "")

    # Server
    host: str = os.environ.get("HOST", "0.0.0.0")
    port: int = int(os.environ.get("PORT", "8000"))
    data_dir: str = os.environ.get("DATA_DIR", os.path.expanduser("~/.openclaw-api-server"))


config = Config()
