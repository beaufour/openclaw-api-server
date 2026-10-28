#!/usr/bin/env python
"""Send an APPROVED reply draft. ONLY the email-reply-approval plugin (button
click handler) may invoke this. Agents must never call it.

Usage: send_approved_reply.py DRAFT_JSON_PATH [--queue-dir DIR]

Deterministic safety checks, all re-verified at send time:
  - file lives in <queue-dir>/sending after the plugin's atomic claim
  - draft is not expired (older than 72h)
  - re-fetch the inbound message from the Gmail API: it still exists, and its
    In-Reply-To still points at a message in our Sent mail
  - inbound sender is still on the original chain (parent To/Cc)
  - recipient is exactly the draft's stored ``from`` — never anyone else
Then sends via Gmail (same thread, In-Reply-To/References set) and moves the
draft file to <queue-dir>/sent/.
"""

import argparse
import json
import os
import re
import sys
import time

GWS_SCRIPTS = "/opt/data/skills/productivity/google-workspace/scripts"
DEFAULT_QUEUE_DIR = "/opt/data/webhook-state/reply-approvals"
EXPIRY_SECONDS = 72 * 3600

sys.path.insert(0, GWS_SCRIPTS)
import google_api  # noqa: E402


def _addresses(header_value):
    out = set()
    for token in re.split(r"[,;]+", header_value or ""):
        m = re.search(r"<([^>]+)>", token)
        addr = (m.group(1) if m else token).strip().lower()
        if addr and "@" in addr:
            out.add(addr)
    return out


def _parent_rfc822_id(headers):
    ids = [r for r in (headers.get("references", "") or "").split() if r.startswith("<")]
    if headers.get("in-reply-to", "").strip():
        ids.append(headers["in-reply-to"].strip())
    return ids[-1] if ids else None


def _sanitize_header(value):
    """Strip CR/LF (header injection) and control chars from an inbound header
    before it is interpolated into the outgoing raw RFC822 message."""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", value or "").strip()


_CC_RULE = "allan@beaufour.dk"  # standing rule: Petter's mail always CCs Allan


def _approved_label_id(service):
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    return next((item["id"] for item in labels if item.get("name") == "approved"), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft_path")
    ap.add_argument("--queue-dir", default=DEFAULT_QUEUE_DIR)
    args = ap.parse_args()

    sending_dir = os.path.realpath(os.path.join(args.queue_dir, "sending"))
    if os.path.dirname(os.path.realpath(args.draft_path)) != sending_dir:
        print(json.dumps({"sent": False, "reason": "draft is not atomically claimed for sending"}))
        sys.exit(4)

    with open(args.draft_path, encoding="utf-8") as f:
        draft = json.load(f)

    if int(time.time()) - int(draft.get("created_at", 0)) > EXPIRY_SECONDS:
        print(json.dumps({"sent": False, "reason": "draft expired"}))
        sys.exit(5)

    body = (draft.get("draft_body") or "").strip()
    recipient = (draft.get("from") or "").strip().lower()
    inbound_id = draft.get("inbound_id", "")
    if not body or not recipient or not inbound_id:
        print(json.dumps({"sent": False, "reason": "draft missing body/recipient/inbound_id"}))
        sys.exit(4)

    service = google_api.build_service("gmail", "v1")
    msg = service.users().messages().get(
        userId="me", id=inbound_id, format="full").execute()
    approved_id = _approved_label_id(service)
    if not approved_id or approved_id not in msg.get("labelIds", []):
        print(json.dumps({"sent": False, "reason": "inbound message is no longer approved"}))
        sys.exit(4)
    headers = google_api._headers_dict(msg)
    sender = next(iter(_addresses(headers.get("from", ""))), "")
    if sender != recipient:
        print(json.dumps({"sent": False, "reason": "sender changed since draft",
                          "draft_recipient": recipient, "current_sender": sender}))
        sys.exit(4)

    parent_id = _parent_rfc822_id(headers)
    if not parent_id or not re.fullmatch(r"<[^<>\r\n\s]+>", parent_id):
        print(json.dumps({"sent": False, "reason": "no valid In-Reply-To/References on inbound"}))
        sys.exit(4)
    listed = service.users().messages().list(
        userId="me", q=f"in:sent rfc822msgid:{parent_id}", maxResults=5).execute()
    sent_ids = [m["id"] for m in listed.get("messages", [])]
    if not sent_ids:
        print(json.dumps({"sent": False, "reason": "parent no longer in Sent mail"}))
        sys.exit(4)
    parent = service.users().messages().get(
        userId="me", id=sent_ids[0], format="full").execute()
    p_headers = google_api._headers_dict(parent)
    if _sanitize_header(p_headers.get("message-id", "")) != parent_id:
        # The listed message must actually BE the parent, not a query match artifact.
        print(json.dumps({"sent": False, "reason": "parent Message-ID mismatch after fetch"}))
        sys.exit(4)
    chain = _addresses(p_headers.get("to", "")) | _addresses(p_headers.get("cc", ""))
    if sender not in chain:
        print(json.dumps({"sent": False, "reason": "sender no longer on original chain"}))
        sys.exit(4)

    subject = _sanitize_header(draft.get("subject") or headers.get("subject", ""))
    if not re.match(r"^\s*(re|fwd)\s*:", subject, re.I):
        subject = "Re: " + subject
    msg_id = _sanitize_header(headers.get("message-id", ""))
    refs = _sanitize_header(headers.get("references", ""))
    if not re.fullmatch(r"<[^<>\r\n\s]+>", msg_id):
        print(json.dumps({"sent": False, "reason": "inbound Message-ID missing/invalid"}))
        sys.exit(4)
    raw = (
        f"To: {recipient}\r\n"
        f"Cc: {_CC_RULE}\r\n"
        f"Subject: {subject}\r\n"
        f"In-Reply-To: {msg_id}\r\n"
        f"References: {refs} {msg_id}\r\n"
        'Content-Type: text/plain; charset="UTF-8"\r\n\r\n'
        f"{body}\r\n"
    ).encode("utf-8")
    import base64
    sent = service.users().messages().send(
        userId="me", body={"raw": base64.urlsafe_b64encode(raw).decode("ascii"),
                           "threadId": msg.get("threadId", "")}).execute()

    sent_dir = os.path.join(args.queue_dir, "sent")
    os.makedirs(sent_dir, exist_ok=True)
    os.replace(args.draft_path, os.path.join(sent_dir, os.path.basename(args.draft_path)))
    print(json.dumps({"sent": True, "to": recipient, "gmail_id": sent["id"],
                      "thread": msg.get("threadId", "")}))


if __name__ == "__main__":
    main()
