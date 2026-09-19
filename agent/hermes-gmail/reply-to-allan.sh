#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: reply-to-allan.sh MESSAGE_ID" >&2
  exit 2
fi

message_id=$1
reply_body=$(cat)
if [ -z "$reply_body" ]; then
  echo "refusing to send an empty reply" >&2
  exit 2
fi

gapi=/opt/data/skills/productivity/google-workspace/scripts/google_api.py
python_bin=/opt/data/.gws-venv/bin/python

message_json=$($python_bin "$gapi" gmail get "$message_id")
sender=$(printf '%s' "$message_json" | $python_bin -c '
import json, re, sys
data = json.load(sys.stdin)
raw = str(data.get("from", ""))
match = re.search(r"<([^>]+)>", raw)
print((match.group(1) if match else raw).strip().lower())
')

if [ "$sender" != "allan@beaufour.dk" ]; then
  echo "refusing reply: authenticated sender is not allan@beaufour.dk" >&2
  exit 1
fi

exec "$python_bin" "$gapi" gmail reply "$message_id" --body "$reply_body"
