# CLAUDE.md

## Project Overview

OpenClaw Gateway plugin that receives webhooks from Gmail, Asana, and Strava. Validates signatures, parses payloads, and triggers wake events on the Gateway. Runs in-process with the Gateway — no separate server needed.

## Tech Stack

- TypeScript (ES2023, ESM)
- Biome for linting and formatting
- Vitest for testing
- Node.js built-in crypto for HMAC validation

## Project Structure

```
src/
├── index.ts             # Plugin entry point, registers routes on Gateway
├── config.ts            # Env-based configuration
├── logger.ts            # Structured console logger
└── handlers/
    ├── gmail.ts         # Gmail Pub/Sub push handler (OIDC JWT auth + DKIM)
    ├── dkim.ts          # DKIM result parsing and sender allowlist checking
    ├── asana.ts         # Asana webhook handler (handshake + HMAC-SHA256)
    └── strava.ts        # Strava webhook handler (path secret + verify token)
tests/
├── gmail.test.ts        # Gmail auth + DKIM integration tests
├── dkim.test.ts         # DKIM parsing and allowlist unit tests
├── asana.test.ts
└── strava.test.ts
```

## Commands

```bash
npm install                          # Install dependencies
npm run build                        # Compile TypeScript
npm run check                        # Lint + type check + test (all at once)
npx biome check src/ tests/          # Lint and format check
npx tsc --noEmit                     # Type check
npx vitest run                       # Run tests
```

## Pre-commit Hook

Located at `.githooks/pre-commit`, runs biome, tsc, and vitest. Enable with:
```bash
git config core.hooksPath .githooks
```

## Key Patterns

- Handlers are pure functions: take parsed input + config, return result objects (status, headers, payload)
- No HTTP framework dependency in handlers — the plugin entry point (`index.ts`) wires handlers to Gateway routes
- Auth validation happens before payload processing in every handler
- Webhook endpoints return 200 to acknowledge receipt even on decode errors, to prevent retry storms
- Secrets are never logged; Asana handshake secrets are persisted to `DATA_DIR` for restart survival
- Gmail DKIM check uses an `EmailHeadersFetcher` interface — the implementation fetches headers via Gmail API. The handler itself only depends on the interface, keeping it testable
- Sender allowlist is loaded from `DATA_DIR/gmail_sender_allowlist.json` at startup. Both From email and DKIM signing domain must match

## Adding a New Service

1. Create `src/handlers/newservice.ts` with handler function(s) returning `{ status, payload? }`
2. Add config vars to `src/config.ts`
3. Register routes in `src/index.ts` via `api.addRoute()`
4. Add tests in `tests/newservice.test.ts`

## Plugin API

The `PluginAPI` interface in `index.ts` is a minimal type definition based on OpenClaw's documented plugin capabilities. The actual API may differ — consult OpenClaw plugin docs. Key methods used:
- `api.addRoute(method, path, handler)` — register HTTP routes
- `api.triggerWakeEvent(source, payload)` — wake the agent with event data
