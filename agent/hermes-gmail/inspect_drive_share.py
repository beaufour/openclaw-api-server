#!/usr/bin/env python3
"""Safely inspect bounded text content from an approved Google Drive share email."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import re
from email.utils import parseaddr
from pathlib import Path
from typing import Any, Iterable

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload

from audit_log import append_event


TOKEN_PATH = Path("/opt/data/google_token.json")
EXPECTED_FROM = "drive-shares-dm-noreply@google.com"
EXPECTED_REPLY_TO = "allan@beaufour.dk"
APPROVED_LABEL = "approved"
MAX_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_CHARS = 40_000
DRIVE_ID_PATTERNS = (
    re.compile(
        r"https://drive\.google\.com/file/d/([A-Za-z0-9_-]+)(?:[/#?]|$)",
        re.IGNORECASE,
    ),
    re.compile(
        r"https://docs\.google\.com/(?:document|spreadsheets|presentation)/d/"
        r"([A-Za-z0-9_-]+)(?:[/#?]|$)",
        re.IGNORECASE,
    ),
    re.compile(
        r"https://drive\.google\.com/(?:open|uc)\?[^\s]*\bid=([A-Za-z0-9_-]+)",
        re.IGNORECASE,
    ),
)
NATIVE_EXPORTS = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
}
TEXT_MIME_TYPES = {
    "application/csv",
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
}


def load_credentials() -> Credentials:
    credentials = Credentials.from_authorized_user_file(str(TOKEN_PATH))
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
    if not credentials.valid:
        raise RuntimeError("Google credentials are invalid; reauthorize Hermes")
    return credentials


def decode_body(data: str) -> str:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding).decode("utf-8", errors="replace")


def walk_parts(part: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield part
    for child in part.get("parts", []) or []:
        yield from walk_parts(child)


def get_header(headers: list[dict[str, str]], name: str) -> str:
    values = [
        str(item.get("value", ""))
        for item in headers
        if str(item.get("name", "")).casefold() == name.casefold()
    ]
    if len(values) != 1:
        raise RuntimeError(f"expected exactly one {name} header, found {len(values)}")
    return values[0]


def plain_text(payload: dict[str, Any]) -> str:
    chunks: list[str] = []
    for part in walk_parts(payload):
        if str(part.get("mimeType", "")).casefold() != "text/plain":
            continue
        data = str(part.get("body", {}).get("data", ""))
        if data:
            chunks.append(decode_body(data))
    return "\n".join(chunks)


def extract_drive_file_id(text: str) -> str:
    ids: set[str] = set()
    for pattern in DRIVE_ID_PATTERNS:
        ids.update(pattern.findall(text))
    if len(ids) != 1:
        raise RuntimeError(f"expected exactly one canonical Drive file id, found {len(ids)}")
    return next(iter(ids))


def label_name_map(gmail: Any) -> dict[str, str]:
    labels = gmail.users().labels().list(userId="me").execute().get("labels", [])
    return {str(label["id"]): str(label["name"]) for label in labels}


def approved_drive_message(gmail: Any, message_id: str) -> tuple[str, str]:
    message = (
        gmail.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )
    headers = message.get("payload", {}).get("headers", [])
    sender = parseaddr(get_header(headers, "From"))[1].casefold()
    reply_to = parseaddr(get_header(headers, "Reply-To"))[1].casefold()
    if sender != EXPECTED_FROM or reply_to != EXPECTED_REPLY_TO:
        raise RuntimeError("message does not have the approved Drive sender identity")

    names = label_name_map(gmail)
    message_labels = {names.get(str(label_id), str(label_id)) for label_id in message.get("labelIds", [])}
    if APPROVED_LABEL not in message_labels:
        raise RuntimeError("message is not labeled approved")

    body = plain_text(message.get("payload", {}))
    if not body:
        raise RuntimeError("Drive notification has no text/plain body")
    return extract_drive_file_id(body), str(message.get("threadId", ""))


def download_bounded(request: Any) -> bytes:
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request, chunksize=256 * 1024)
    done = False
    while not done:
        _, done = downloader.next_chunk()
        if buffer.tell() > MAX_BYTES:
            raise RuntimeError(f"content exceeds {MAX_BYTES} byte inspection limit")
    return buffer.getvalue()


def csv_sample(text: str) -> dict[str, Any] | None:
    try:
        rows = list(csv.reader(io.StringIO(text[:MAX_PREVIEW_CHARS])))[:21]
    except csv.Error:
        return None
    if not rows:
        return None
    return {
        "columns": rows[0],
        "sampleRows": rows[1:21],
        "sampleRowCount": max(0, len(rows) - 1),
    }


def inspect_content(drive: Any, metadata: dict[str, Any]) -> dict[str, Any]:
    mime_type = str(metadata.get("mimeType", ""))
    size = int(metadata.get("size", 0) or 0)
    if size > MAX_BYTES:
        return {
            "status": "metadata_only",
            "reason": "file_too_large",
            "limitBytes": MAX_BYTES,
        }
    if metadata.get("capabilities", {}).get("canDownload") is False:
        return {"status": "metadata_only", "reason": "download_not_allowed"}

    export_mime = NATIVE_EXPORTS.get(mime_type)
    if export_mime:
        request = drive.files().export_media(fileId=metadata["id"], mimeType=export_mime)
        content_mime = export_mime
    elif mime_type.startswith("text/") or mime_type in TEXT_MIME_TYPES:
        request = drive.files().get_media(fileId=metadata["id"])
        content_mime = mime_type
    else:
        return {
            "status": "metadata_only",
            "reason": "unsupported_mime_type",
        }

    try:
        content = download_bounded(request)
    except RuntimeError as exc:
        return {"status": "metadata_only", "reason": str(exc)}
    except HttpError as exc:
        status = getattr(exc.resp, "status", "unknown")
        return {
            "status": "metadata_only",
            "reason": f"drive_content_api_error_{status}",
        }
    text = content.decode("utf-8", errors="replace")
    result: dict[str, Any] = {
        "status": "content_preview",
        "contentMimeType": content_mime,
        "byteCount": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "truncated": len(text) > MAX_PREVIEW_CHARS,
        "textPreview": text[:MAX_PREVIEW_CHARS],
    }
    if content_mime in {"text/csv", "application/csv"}:
        sample = csv_sample(text)
        if sample:
            result["csv"] = sample
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("message_id")
    args = parser.parse_args()

    credentials = load_credentials()
    gmail = build("gmail", "v1", credentials=credentials)
    drive = build("drive", "v3", credentials=credentials)
    file_id, thread_id = approved_drive_message(gmail, args.message_id)
    fields = (
        "id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),"
        "sharingUser(displayName,emailAddress),capabilities(canDownload),"
        "md5Checksum,sha256Checksum"
    )
    metadata = drive.files().get(fileId=file_id, fields=fields).execute()
    inspection = inspect_content(drive, metadata)
    result = {
        "messageId": args.message_id,
        "threadId": thread_id,
        "file": metadata,
        "inspection": inspection,
        "security": {
            "contentIsUntrustedData": True,
            "linksFollowed": False,
            "executed": False,
            "archivesUnpacked": False,
        },
    }
    append_event(
        {
            "event": "drive_inspection",
            "message_id": args.message_id,
            "thread_id": thread_id,
            "file_id": file_id,
            "name": metadata.get("name", ""),
            "mime_type": metadata.get("mimeType", ""),
            "owners": metadata.get("owners", []),
            "sharing_user": metadata.get("sharingUser"),
            "inspection_status": inspection.get("status"),
            "inspection_reason": inspection.get("reason"),
            "byte_count": inspection.get("byteCount"),
            "sha256": inspection.get("sha256"),
        }
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
