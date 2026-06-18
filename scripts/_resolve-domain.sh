#!/usr/bin/env bash
# Resolve the webhook DOMAIN for the setup-*.sh scripts, so you set it in ONE
# place instead of passing it to each script.
#
# Sourced by setup-gmail.sh / setup-strava.sh / setup-asana.sh. Sets $DOMAIN.
# Precedence (first non-empty wins):
#   1. SETUP_DOMAIN_ARG  — the script's positional arg (per-run override)
#   2. $WEBHOOK_DOMAIN   — exported in the environment
#   3. WEBHOOK_DOMAIN=…  — in the repo .env (the usual place to set it once)

__rd_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__rd_env="${__rd_dir}/../.env"

if [[ -z "${WEBHOOK_DOMAIN:-}" && -f "${__rd_env}" ]]; then
	WEBHOOK_DOMAIN="$(grep -E '^[[:space:]]*WEBHOOK_DOMAIN=' "${__rd_env}" \
		| head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^["'\'']//; s/["'\'']$//' \
		| tr -d '[:space:]')"
fi

DOMAIN="${SETUP_DOMAIN_ARG:-${WEBHOOK_DOMAIN:-}}"

if [[ -z "${DOMAIN}" ]]; then
	echo "Error: webhook domain not set." >&2
	echo "  Pass it as an argument:   $0 webhooks.example.com" >&2
	echo "  Or set it once in .env:   WEBHOOK_DOMAIN=webhooks.example.com" >&2
	exit 1
fi
