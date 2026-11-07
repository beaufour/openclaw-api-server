#!/bin/sh
set -eu

cc=""
auto_cc=1
while [ $# -gt 0 ]; do
  case "$1" in
    --cc) cc="$2"; shift 2 ;;
    --no-auto-cc) auto_cc=0; shift ;;
    *) break ;;
  esac
done

if [ "$#" -ne 1 ]; then
  echo "usage: reply-to-allan.sh [--cc ADDR[,ADDR]] [--no-auto-cc] MESSAGE_ID" >&2
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

# Auto-CC the original message's Cc recipients (email-only, no personal
# names) so forwarded-thread participants stay on the reply. Explicit --cc
# values are appended and deduplicated.
extra_cc=$(printf '%s' "$message_json" | CC="$cc" AUTO="$auto_cc" $python_bin -c '
import json, os, re, sys
data = json.load(sys.stdin)
addrs = []

def add(raw):
    raw = (raw or "").strip()
    if not raw:
        return
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.search(r"<([^>]+)>", part)
        addr = (m.group(1) if m else part).strip().lower()
        if addr and addr != "allan@beaufour.dk":
            addrs.append(addr)

if os.environ["AUTO"] == "1":
    add(str(data.get("cc", "")))
add(os.environ["CC"])

seen, out = set(), []
for a in addrs:
    if a not in seen and not a.endswith("@beaufour.dk"):
        seen.add(a)
        out.append(a)
print(",".join(out))
')

if [ -n "$extra_cc" ]; then
  exec "$python_bin" "$gapi" gmail reply "$message_id" --body "$reply_body" --cc "$extra_cc"
else
  exec "$python_bin" "$gapi" gmail reply "$message_id" --body "$reply_body"
fi
