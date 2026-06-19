#!/usr/bin/env bash
# reply-to-allan.sh — the ONLY sanctioned way for the Gmail agent to send mail.
#
# The recipient is hardcoded to allan@beaufour.dk; the agent supplies only the
# thread/message ids and subject, and the body on stdin. There is no recipient
# argument to redirect, so this path cannot be turned into an exfiltration
# channel regardless of what the agent is convinced to write.
#
# Usage:
#   echo "body text" | reply-to-allan.sh <threadId> <messageId> "<subject>"
set -euo pipefail

ACCOUNT="petter@beaufour.dk"
TO="allan@beaufour.dk"

THREAD_ID="${1:?usage: reply-to-allan.sh <threadId> <messageId> <subject> (body on stdin)}"
MSG_ID="${2:?missing messageId}"
SUBJECT="${3:?missing subject}"

# Use whatever `gog` is on PATH (the guard shim if installed, else the real one)
# — recipient is fixed here either way.
exec gog gmail send \
  --account "$ACCOUNT" \
  --to "$TO" \
  --reply-to-message-id "$MSG_ID" \
  --subject "$SUBJECT" \
  --body-file -
