#!/usr/bin/env python3
"""Validate and record a structured decision for one approved Gmail message."""

from __future__ import annotations

import argparse
import json
import re
from email.utils import parseaddr
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from audit_log import append_event


TOKEN_PATH = Path("/opt/data/google_token.json")
DISPOSITIONS = {
    "actioned",
    "notified",
    "recorded",
    "skipped_duplicate",
    "skipped_irrelevant",
    "skipped_ambiguous",
    "skipped_policy",
    "needs_decision",
}
CATEGORIES = {"allan", "google_drive", "school", "asana", "grubhub", "unknown"}
OUTCOMES = {"replied", "notified", "recorded", "silent", "needs_decision"}


def load_credentials() -> Credentials:
    credentials = Credentials.from_authorized_user_file(str(TOKEN_PATH))
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
    if not credentials.valid:
        raise RuntimeError("Google credentials are invalid; reauthorize Hermes")
    return credentials


def header(headers: list[dict[str, str]], name: str) -> str:
    wanted = name.casefold()
    for value in headers:
        if str(value.get("name", "")).casefold() == wanted:
            return str(value.get("value", ""))
    return ""


def message_metadata(message_id: str) -> dict[str, str]:
    service = build("gmail", "v1", credentials=load_credentials())
    message = (
        service.users()
        .messages()
        .get(
            userId="me",
            id=message_id,
            format="metadata",
            metadataHeaders=["From", "Subject", "Message-ID"],
        )
        .execute()
    )
    headers = message.get("payload", {}).get("headers", [])
    raw_from = header(headers, "From")
    return {
        "thread_id": str(message.get("threadId", "")),
        "from": parseaddr(raw_from)[1].casefold() or raw_from,
        "subject": header(headers, "Subject"),
        "rfc_message_id": header(headers, "Message-ID"),
    }


def validate_document(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("audit document must be a JSON object")

    required = {"category", "outcome", "user_attention", "items", "actions"}
    missing = sorted(required - document.keys())
    if missing:
        raise ValueError(f"missing required fields: {', '.join(missing)}")
    if document["category"] not in CATEGORIES:
        raise ValueError(f"invalid category: {document['category']!r}")
    if document["outcome"] not in OUTCOMES:
        raise ValueError(f"invalid outcome: {document['outcome']!r}")
    if not isinstance(document["user_attention"], bool):
        raise ValueError("user_attention must be a boolean")
    if not isinstance(document["items"], list):
        raise ValueError("items must be an array")
    if not isinstance(document["actions"], list) or not all(
        isinstance(action, str) and action.strip() for action in document["actions"]
    ):
        raise ValueError("actions must be an array of non-empty strings")

    for index, item in enumerate(document["items"]):
        if not isinstance(item, dict):
            raise ValueError(f"items[{index}] must be an object")
        for field in ("item", "disposition", "reason"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError(f"items[{index}].{field} must be a non-empty string")
        if item["disposition"] not in DISPOSITIONS:
            raise ValueError(
                f"invalid items[{index}].disposition: {item['disposition']!r}"
            )

    # Keep the ledger bounded and prevent control characters in human text.
    serialized = json.dumps(document, ensure_ascii=False)
    if len(serialized.encode("utf-8")) > 32_768:
        raise ValueError("audit document exceeds 32 KiB")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", serialized):
        raise ValueError("audit document contains control characters")
    return document


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("message_id")
    parser.add_argument("--document", required=True)
    args = parser.parse_args()

    try:
        document = validate_document(json.loads(args.document))
        metadata = message_metadata(args.message_id)
        append_event(
            {
                "event": "decision",
                "message_id": args.message_id,
                **metadata,
                **document,
            }
        )
    except (ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"invalid audit decision: {exc}") from exc

    print(json.dumps({"message_id": args.message_id, "status": "audited"}))


if __name__ == "__main__":
    main()
