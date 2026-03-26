import uvicorn

from openclaw_api_server.app import app
from openclaw_api_server.config import config

if __name__ == "__main__":
    uvicorn.run(app, host=config.host, port=config.port)
