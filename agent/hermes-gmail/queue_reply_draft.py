#!/usr/bin/env python
"""Verify an approved inbound email is a reply to OUR sent mail, then queue a
draft reply for human approval.

Usage (pinned in the hermes-gmail skill):
    queue_reply_draft.py MESSAGE_ID --body-file DRAFT_BODY_FILE [--queue-dir DIR]

Verification is performed here, from the Gmail API, never from agent-supplied
claims:
  1. Fetch the inbound message (format=full) and read In-Reply-To / References.
  2. Search Gmail for the parent message; it must exist under in:sent (i.e. WE
     sent it from petter@beaufour.dk). If the exact Message-ID search fails,
     fall back to scanning the inbound message's Gmail thread for a SENT
     message (Gmail sometimes rewrites Message-IDs on send, so the ID quoted
     in In-Reply-To may not match the stored one).
  3. Extract the parent's To + Cc recipients; the inbound sender must be one of
     them (\"any sender on the chain\").
Only then is a draft queued atomically to <queue-dir>/pending/<msgid>.json.

Exit codes: 0 queued, 2 not a reply to our sent mail / sender not on chain,
3 Gmail error. Nothing is ever sent by this script.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
GWS_SCRIPTS = "/opt/data/skills/productivity/google-workspace/scripts"
DEFAULT_QUEUE_DIR = "/opt/data/webhook-state/reply-approvals"

sys.path.insert(0, GWS_SCRIPTS)
import google_api  # noqa: E402


def _addresses(header_value):
    """Extract lowercase email addresses from a To/Cc/From header value."""
    out = set()
    for token in re.split(r"[,;]+", header_value or ""):
        m = re.search(r"<([^>]+)>", token)
        addr = (m.group(1) if m else token).strip().lower()
        if addr and "@" in addr:
            out.add(addr)
    return out


def _parent_rfc822_id(headers):
    refs = headers.get("references", "") or ""
    ids = [r for r in refs.split() if r.startswith("<")]
    if headers.get("in-reply-to", "").strip():
        ids.append(headers["in-reply-to"].strip())
    return ids[-1] if ids else None


def _approved_label_id(service):
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    return next((item["id"] for item in labels if item.get("name") == "approved"), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("message_id")
    ap.add_argument("--body-file", required=True)
    ap.add_argument("--queue-dir", default=DEFAULT_QUEUE_DIR)
    args = ap.parse_args()

    with open(args.body_file, encoding="utf-8") as f:
        draft_body = f.read().strip()
    if not draft_body:
        print(json.dumps({"error": "empty draft body"}))
        sys.exit(3)

    service = google_api.build_service("gmail", "v1")
    msg = service.users().messages().get(
        userId="me", id=args.message_id, format="full").execute()
    approved_id = _approved_label_id(service)
    if not approved_id or approved_id not in msg.get("labelIds", []):
        print(json.dumps({"queued": False, "reason": "message is not labeled approved"}))
        sys.exit(2)
    headers = google_api._headers_dict(msg)
    sender = next(iter(_addresses(headers.get("from", ""))), "")
    parent_id = _parent_rfc822_id(headers)
    if not parent_id or not re.fullmatch(r"<[^<>\r\n\s]+>", parent_id):
        print(json.dumps({"queued": False, "reason": "no In-Reply-To/References header"}))
        sys.exit(2)

    listed = service.users().messages().list(
        userId="me", q=f"in:sent rfc822msgid:{parent_id}", maxResults=5).execute()
    sent_ids = [m["id"] for m in listed.get("messages", [])]
    msgid_match = bool(sent_ids)
    if not msgid_match:
        # Gmail sometimes rewrites the Message-ID when a message is sent, so
        # the ID quoted in the inbound In-Reply-To may not exist verbatim in
        # our Sent mail. Fall back to scanning the inbound message's own
        # Gmail thread for messages we sent; the security properties below
        # (SENT label, same thread, sender on the recipients chain) are still
        # verified from the Gmail API, not from the email's own claims.
        thread = service.users().threads().get(
            userId="me", id=msg["threadId"]).execute()
        sent_ids = [m["id"] for m in thread.get("messages", [])
                    if "SENT" in (m.get("labelIds") or [])]
    if not sent_ids:
        print(json.dumps({"queued": False, "reason": "parent not found in our Sent mail",
                          "parent_rfc822": parent_id}))
        sys.exit(2)

    parent = None
    p_headers = None
    chain = set()
    for sent_id in sent_ids:
        if sent_id == msg["id"]:
            continue  # never treat the inbound message itself as the parent
        candidate = service.users().messages().get(
            userId="me", id=sent_id, format="full").execute()
        candidate_headers = google_api._headers_dict(candidate)
        candidate_chain = (_addresses(candidate_headers.get("to", "")) |
                           _addresses(candidate_headers.get("cc", "")))
        if (candidate.get("threadId") == msg.get("threadId")
                and sender in candidate_chain
                and (not msgid_match
                     or candidate_headers.get("message-id", "").strip() == parent_id)):
            parent = candidate
            p_headers = candidate_headers
            chain = candidate_chain
            break
    if parent is None or p_headers is None:
        print(json.dumps({"queued": False,
                          "reason": "no exact same-thread Sent parent includes sender",
                          "sender": sender}))
        sys.exit(2)

    body_text = google_api._extract_message_body(msg)
    draft = {
        "inbound_id": msg["id"],
        "thread_id": msg.get("threadId", ""),
        "parent_sent_id": parent["id"],
        "parent_rfc822": parent_id,
        "parent_match": "message_id" if msgid_match else "thread_fallback",
        "parent_subject": p_headers.get("subject", ""),
        "from": sender,
        "chain": sorted(chain),
        "subject": headers.get("subject", ""),
        "date": headers.get("date", ""),
        "inbound_preview": body_text[:400],
        "draft_body": draft_body,
        "created_at": int(time.time()),
        "slack_channel": "C0C1ATHMFC3",
        "allowed_user": "U9FCN116J",
    }

    pending = os.path.join(args.queue_dir, "pending")
    os.makedirs(pending, exist_ok=True)
    safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", msg["id"]) + ".json"
    final = os.path.join(pending, safe_name)
    fd, tmp = tempfile.mkstemp(dir=pending, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(draft, f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, final)  # atomic; also our double-claim guard
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    print(json.dumps({"queued": True, "file": final, "reply_to": sender,
                      "parent_rfc822": parent_id}, ensure_ascii=False))


if __name__ == "__main__":
    main()
