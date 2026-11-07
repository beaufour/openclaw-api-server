#!/bin/sh
set -eu

cc=""
auto_cc=1
while [ $# -gt 0 ]; do
  case "$1" in
    --cc)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "--cc requires an address list" >&2
        exit 2
      fi
      cc="$2"; shift 2 ;;
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

# Auto-CC the original message's Cc recipients so forwarded-thread
# participants stay on the reply. Explicit --cc addresses are allowed only if
# they already appear in the original's From, To, or Cc headers; any other
# address refuses the whole send (fail closed), so email content cannot steer
# a reply to an outsider. beaufour.dk addresses are never CC'd.
extra_cc=$(printf '%s' "$message_json" | CC="$cc" AUTO="$auto_cc" $python_bin -c '
import json, os, re, sys
from email.utils import getaddresses

data = json.load(sys.stdin)
ADDR = re.compile(r"[^@\s<>(),;:\"]+@[^@\s<>(),;:\"]+\.[^@\s<>(),;:\"]+")

def parse(*raw):
    out = []
    for _, addr in getaddresses([str(r or "") for r in raw]):
        addr = addr.strip().lower()
        if ADDR.fullmatch(addr) and not addr.endswith("@beaufour.dk"):
            out.append(addr)
    return out

allowed = set(parse(data.get("from"), data.get("to"), data.get("cc")))
explicit = [a.strip() for a in os.environ["CC"].split(",") if a.strip()]
rejected = []
requested = []
for raw in explicit:
    found = parse(raw)
    if not found:
        if not raw.lower().rstrip(">").endswith("@beaufour.dk"):
            rejected.append(raw)
        continue
    for addr in found:
        (requested if addr in allowed else rejected).append(addr)
if rejected:
    print("refusing reply: --cc address not on the original message: " + ", ".join(rejected), file=sys.stderr)
    sys.exit(1)

cc = parse(data.get("cc")) if os.environ["AUTO"] == "1" else []
seen, out = set(), []
for addr in cc + requested:
    if addr not in seen:
        seen.add(addr)
        out.append(addr)
print(",".join(out))
')

if [ -n "$extra_cc" ]; then
  exec "$python_bin" "$gapi" gmail reply "$message_id" --body "$reply_body" --cc "$extra_cc"
else
  exec "$python_bin" "$gapi" gmail reply "$message_id" --body "$reply_body"
fi
