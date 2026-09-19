#!/usr/bin/env python3
"""Append-only, process-safe audit logging for the Hermes Gmail workflow."""

from __future__ import annotations

import fcntl
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_AUDIT_PATH = Path("/opt/data/webhook-state/gmail-audit.jsonl")


def audit_path() -> Path:
    override = os.environ.get("HERMES_GMAIL_AUDIT_PATH")
    return Path(override) if override else DEFAULT_AUDIT_PATH


def append_event(event: dict[str, Any]) -> None:
    """Append one fsynced JSON event while holding an exclusive file lock."""
    path = audit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **event,
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.chmod(path, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            fd = -1
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            stream.write(encoded + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        if fd >= 0:
            os.close(fd)


def has_decision(message_id: str) -> bool:
    """Return whether a valid decision event exists for the Gmail message."""
    path = audit_path()
    try:
        with path.open("r", encoding="utf-8") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_SH)
            try:
                for line in stream:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if (
                        event.get("event") == "decision"
                        and event.get("message_id") == message_id
                    ):
                        return True
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    except FileNotFoundError:
        return False
    return False
