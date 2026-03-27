# OpenClaw Webhook Receiver

[OpenClaw](https://openclaw.ai/) Gateway plugin that receives push notifications from external APIs. Replaces expensive LLM-monitored polling with near-real-time webhooks.

## Architecture

```
Gmail (Pub/Sub Push) ──┐
Asana (Webhooks)    ───┼──→ Cloudflare Edge ──→ cloudflared tunnel ──→ OpenClaw Gateway (with this plugin)
Strava (Webhooks)   ───┘
```

This is an in-process Gateway plugin — no separate server to manage.

## Supported Services

| Service | Endpoint | Method | Auth |
|---------|----------|--------|------|
| Gmail | `/webhook/gmail` | POST | OIDC JWT from Pub/Sub + optional DKIM/allowlist |
| Asana | `/webhook/asana` | POST | HMAC-SHA256 signature |
| Strava | `/webhook/strava/:secret` | GET/POST | Secret URL path segment |

## Installation

```bash
# Install as an OpenClaw plugin
openclaw plugins install ./path-to-this-repo

# Or copy to extensions directory
cp -r dist/ ~/.openclaw/extensions/webhook-receiver/
```

## Configuration

Set these environment variables before starting the Gateway:

| Variable | Description | Default |
|----------|-------------|---------|
| `ASANA_WEBHOOK_SECRET` | HMAC secret for Asana signature validation | (auto-persisted from handshake) |
| `STRAVA_VERIFY_TOKEN` | Token for Strava subscription validation | (empty) |
| `STRAVA_WEBHOOK_SECRET` | Secret path segment in Strava callback URL | (empty) |
| `GMAIL_PUBSUB_AUDIENCE` | Audience for Pub/Sub OIDC JWT validation | (empty, skips auth) |
| `GMAIL_REQUIRE_DKIM` | Set to `true` to verify DKIM and check sender allowlist | `false` |
| `DATA_DIR` | Directory for persisted state (Asana secrets, allowlist) | `~/.openclaw-api-server` |

## Cloudflare Tunnel

Expose the Gateway to the internet without opening ports:

```bash
brew install cloudflared
cloudflared login
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw webhooks.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: openclaw
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: webhooks.yourdomain.com
    service: http://localhost:18789
  - service: http_status:404
```

```bash
cloudflared tunnel run openclaw
```

## Registering Webhooks

### Gmail (Pub/Sub Push)

1. Enable Gmail API + Pub/Sub API in Google Cloud Console
2. Create a Pub/Sub topic and grant publish permission to `gmail-api-push@system.gserviceaccount.com`
3. Create a push subscription pointing to `https://webhooks.yourdomain.com/webhook/gmail`
4. Set `GMAIL_PUBSUB_AUDIENCE` to the same URL for JWT validation
5. Call the Gmail API `watch()` method (must be renewed every 7 days)

#### DKIM Verification & Sender Allowlist (optional)

Set `GMAIL_REQUIRE_DKIM=true` to verify that incoming emails pass DKIM. Gmail already verifies DKIM on receipt — this plugin reads the `Authentication-Results` header via the Gmail API to check the result.

To restrict which senders can trigger agent actions, create `DATA_DIR/gmail_sender_allowlist.json`:

```json
[
  { "fromEmail": "boss@company.com", "dkimDomain": "company.com" },
  { "fromEmail": "alerts@monitoring.io", "dkimDomain": "monitoring.io" }
]
```

Both the From email **and** the DKIM signing domain must match an entry. If the allowlist file is empty or missing, all DKIM-passing emails are allowed through.

### Asana

1. Create a webhook via Asana API with callback URL `https://webhooks.yourdomain.com/webhook/asana`
2. The plugin handles the handshake automatically and persists the secret
3. Optionally set `ASANA_WEBHOOK_SECRET` to override the persisted secret

### Strava

1. Set `STRAVA_VERIFY_TOKEN` and `STRAVA_WEBHOOK_SECRET` environment variables
2. Register a webhook subscription via Strava API
3. Callback URL: `https://webhooks.yourdomain.com/webhook/strava/<STRAVA_WEBHOOK_SECRET>`

## Development

```bash
npm install
npm run check          # Lint + type check + tests

# Individual commands
npx biome check src/ tests/    # Lint
npx biome check --fix src/     # Auto-fix
npx tsc --noEmit               # Type check
npx vitest run                 # Tests
npx vitest                     # Tests in watch mode
```

Pre-commit hook (biome + tsc + vitest):
```bash
git config core.hooksPath .githooks
```
