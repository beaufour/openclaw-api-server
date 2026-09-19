#!/usr/bin/env python3
"""Create/apply Gmail's processed label, then archive and mark a message read."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from audit_log import append_event, has_decision


TOKEN_PATH = Path("/opt/data/google_token.json")
PROCESSED_LABEL = "processed"


def load_credentials() -> Credentials:
    credentials = Credentials.from_authorized_user_file(str(TOKEN_PATH))
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
        mode = TOKEN_PATH.stat().st_mode & 0o777
        temporary = TOKEN_PATH.with_suffix(".json.tmp")
        temporary.write_text(credentials.to_json(), encoding="utf-8")
        os.chmod(temporary, mode)
        temporary.replace(TOKEN_PATH)
    if not credentials.valid:
        raise RuntimeError("Google credentials are invalid; reauthorize Hermes")
    return credentials


def ensure_processed_label(service: object) -> str:
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for label in labels:
        if str(label.get("name", "")).casefold() == PROCESSED_LABEL:
            return str(label["id"])

    created = (
        service.users()
        .labels()
        .create(
            userId="me",
            body={
                "name": PROCESSED_LABEL,
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            },
        )
        .execute()
    )
    return str(created["id"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("message_id")
    args = parser.parse_args()

    if not has_decision(args.message_id):
        raise RuntimeError(
            "refusing to process message without a successful decision audit"
        )

    service = build("gmail", "v1", credentials=load_credentials())
    processed_id = ensure_processed_label(service)
    append_event(
        {
            "event": "checkpoint_attempt",
            "message_id": args.message_id,
            "add_labels": [PROCESSED_LABEL],
            "remove_labels": ["INBOX", "UNREAD"],
        }
    )
    result = (
        service.users()
        .messages()
        .modify(
            userId="me",
            id=args.message_id,
            body={
                "addLabelIds": [processed_id],
                "removeLabelIds": ["INBOX", "UNREAD"],
            },
        )
        .execute()
    )
    append_event(
        {
            "event": "checkpoint_completed",
            "message_id": args.message_id,
            "gmail_result_id": str(result["id"]),
            "add_labels": [PROCESSED_LABEL],
            "remove_labels": ["INBOX", "UNREAD"],
        }
    )
    print(json.dumps({"id": result["id"], "status": "processed"}))


if __name__ == "__main__":
    main()
