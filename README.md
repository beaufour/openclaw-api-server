# OpenClaw Webhook Receiver

[OpenClaw](https://openclaw.ai/) webhook receiver for external APIs. Replaces expensive LLM-monitored polling with near-real-time webhooks.

## Architecture

```
Gmail (Pub/Sub Push) ──┐
Asana (Webhooks)    ───┼──→ Cloudflare Edge ──→ cloudflared tunnel ──→ webhook server (:18790) ──→ OpenClaw Gateway (:18789)
Strava (Webhooks)   ───┘                                                  scripts/server.ts          POST /hooks/<source>
```

It runs as a small standalone HTTP server (`scripts/server.ts`): it terminates the public webhook traffic, validates each provider's auth, parses the payload, and forwards a wake event to the OpenClaw Gateway's `/hooks/<source>` endpoint. The Gateway and the tunnel are separate processes.

> There is also an in-process Gateway plugin entry point (`src/index.ts`) using the same handlers, but the supported / actually-deployed setup is the standalone server described here.

## Supported Services

| Service | Endpoint | Method | Auth |
|---------|----------|--------|------|
| Gmail | `/webhook/gmail` | POST | OIDC JWT from Pub/Sub + optional DKIM/allowlist |
| Asana | `/webhook/asana` | POST | HMAC-SHA256 signature |
| Strava | `/webhook/strava/:secret` | GET/POST | Secret URL path segment |
| (health) | `/health` | GET | none |

## Running it

Three processes need to be up: the OpenClaw Gateway (on `:18789`), this webhook server, and the cloudflared tunnel.

```bash
npm install
npm start                      # = npx tsx scripts/server.ts — listens on :18790, forwards to the Gateway
npm run dev                    # same, with --watch and --dry-run (logs events, does not forward)

# extra flags
npx tsx scripts/server.ts --dry-run        # log events instead of forwarding
npx tsx scripts/server.ts --log-payload    # also log the full forwarded payload
```

Sanity checks once everything is up:

```bash
curl localhost:18790/health            # {"status":"ok"}
curl https://yugle.yigle.us/health     # same, through the tunnel
```

## Configuration

Config is read from a `.env` file in the repo root (or real environment variables — see `.env.example`).

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port the webhook server listens on | `18790` |
| `OPENCLAW_GATEWAY_URL` | Base URL of the OpenClaw Gateway to forward events to | `http://localhost:18789` |
| `OPENCLAW_HOOK_TOKEN` | Bearer token sent to the Gateway's `/hooks/<source>` endpoints | (empty — forwarding will fail) |
| `ASANA_WEBHOOK_SECRET` | HMAC secret for Asana signature validation | (auto-persisted from handshake) |
| `STRAVA_VERIFY_TOKEN` | Token for Strava subscription validation | (empty) |
| `STRAVA_WEBHOOK_SECRET` | Secret path segment in the Strava callback URL | (empty) |
| `GMAIL_PUBSUB_AUDIENCE` | Audience for Pub/Sub OIDC JWT validation | (empty, skips auth) |
| `GMAIL_REQUIRE_DKIM` | Set to `true` to verify DKIM and check the sender allowlist | `false` |
| `DATA_DIR` | Directory for persisted state (Asana secrets, allowlist) | `~/.openclaw-api-server` |

## Cloudflare Tunnel

Expose the webhook server to the internet without opening ports:

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
    service: http://localhost:18790
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

There's a helper for steps 1–5: `scripts/setup-gmail.sh`.

#### DKIM Verification & Sender Allowlist (optional)

Set `GMAIL_REQUIRE_DKIM=true` to verify that incoming emails pass DKIM. Gmail already verifies DKIM on receipt — this server reads the `Authentication-Results` header via the Gmail API to check the result.

To restrict which senders can trigger agent actions, create `DATA_DIR/gmail_sender_allowlist.json`:

```json
[
  { "fromEmail": "boss@company.com", "dkimDomain": "company.com" },
  { "fromEmail": "alerts@monitoring.io", "dkimDomain": "monitoring.io" }
]
```

Both the From email **and** the DKIM signing domain must match an entry. If the allowlist file is empty or missing, all DKIM-passing emails are allowed through.

### Asana

1. Create a webhook via the Asana API with callback URL `https://webhooks.yourdomain.com/webhook/asana` (see `scripts/setup-asana.sh`)
2. The server handles the handshake automatically and persists the secret to `DATA_DIR`
3. Optionally set `ASANA_WEBHOOK_SECRET` to override the persisted secret

### Strava

1. Set `STRAVA_VERIFY_TOKEN` and `STRAVA_WEBHOOK_SECRET` in `.env`
2. Register a webhook subscription via the Strava API (see `scripts/setup-strava.sh`)
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
