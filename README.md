# freebuff-proxy

OpenAI-compatible API proxy for [Codebuff](https://www.codebuff.com) free models. Exposes a `/v1/chat/completions` endpoint that any AI coding tool can hit — no paid API keys needed.

The proxy manages Codebuff sessions behind the scenes: queues, rotates, and re-authenticates automatically. You just point your editor at `http://localhost:9187/v1`.

## Features

- **OpenAI-compatible** — drop-in for any tool that speaks the OpenAI API
- **Multi-model** — routes by the model you request (`minimax/minimax-m2.7`, `z-ai/glm-5.1`)
- **Session pool** — pre-warms and rotates free Codebuff sessions automatically
- **Dashboard** — real-time usage charts, request logs, account & key management
- **API key protection** — optional; togglable from the dashboard
- **SQLite logging** — every request tracked with tokens, latency, model
- **Web auth flow** — add accounts from the dashboard, no CLI needed

## Quick Start

### 1. Install

```bash
git clone <repo-url> && cd freebuff-proxy
npm install
```

### 2. Build

```bash
npm run build            # backend (tsup)
npm run build:dashboard  # frontend (vite)
```

### 3. Run

```bash
npm start
# or for dev (hot reload):
npm run dev
```

On first run with no `AUTH_TOKENS`, the CLI walks you through a browser login to Codebuff and saves the token to `config.json`.

### 4. Open the Dashboard

Navigate to `http://localhost:9187/`. Default password is `freebuff` (set via `DASHBOARD_PASSWORD` env var).

## Configuration

### config.json (in project root)

```json
{
  "LISTEN_ADDR": ":9187",               // host:port to bind
  "UPSTREAM_BASE_URL": "https://www.codebuff.com",
  "AUTH_TOKENS": ["your-token-here"],   // Codebuff auth cookies
  "TOKEN_MODELS": ["minimax/minimax-m2.7", "z-ai/glm-5.1"],
  "ROTATION_INTERVAL": "6h",            // how often to re-queue sessions
  "REQUEST_TIMEOUT": "15m",             // per-request timeout
  "API_KEYS": [],                       // proxy API keys for access control
  "HTTP_PROXY": ""                      // optional HTTP proxy for upstream
}
```

All keys can be overridden with env vars of the same name. Array values are comma-separated in env.

### Available Models

| Model ID | Type |
|---|---|
| `minimax/minimax-m2.7` | Primary (owns session) |
| `z-ai/glm-5.1` | Primary (owns session) |

Other models (gemini variants, etc.) ride on whichever primary session is active — no extra config needed.

## AI Editor Configuration

Point any OpenAI-compatible editor at the proxy. If key protection is **ON**, set `api_key` to one of your proxy keys. Available models: `minimax/minimax-m2.7`, `z-ai/glm-5.1`.

### opencode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freebuff": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "proxy",
      "options": {
        "baseURL": "http://localhost:9187/v1"
      },
      "models": {
        "minimax-m2.7": {
          "name": "minimax/minimax-m2.7",
          "reasoning": true,
          "modalities": { "input": ["text"], "output": ["text"] },
          "attachment": true,
          "limit": { "context": 195000, "output": 60000 }
        },
        "glm-5.1": {
          "name": "z-ai/glm-5.1",
          "reasoning": true,
          "modalities": { "input": ["text"], "output": ["text"] },
          "attachment": true,
          "limit": { "context": 195000, "output": 60000 }
        }
      }
    }
  }
}
```

> `effort` can be `"high"`, `"medium"`, `"low"`, or `"none"` (disables thinking). Change it from `Ctrl+T` in opencode.

### crush

Add to `~/.config/crush/crush.json`:

```json
{
  "$schema": "https://charm.land/crush.json",
  "providers": {
    "proxy": {
      "type": "openai",
      "base_url": "http://localhost:9187/v1",
      "api_key": "",
      "models": [
        {
          "id": "minimax/minimax-m2.7",
          "name": "minimax/minimax-m2.7",
          "cost_per_1m_in": 0.0,
          "cost_per_1m_out": 0.0,
          "cost_per_1m_in_cached": 0,
          "cost_per_1m_out_cached": 0,
          "context_window": 150000,
          "default_max_tokens": 32768
        },
        {
          "id": "z-ai/glm-5.1",
          "name": "z-ai/glm-5.1",
          "cost_per_1m_in": 0.0,
          "cost_per_1m_out": 0.0,
          "cost_per_1m_in_cached": 0,
          "cost_per_1m_out_cached": 0,
          "context_window": 150000,
          "default_max_tokens": 32768
        }
      ]
    }
  }
}
```

### Claude Code Router

```json
{
  "LOG": false,
  "Providers": [
    {
      "name": "freebuff",
      "api_base_url": "http://localhost:9187/v1/chat/completions/",
      "api_key": "any-string",
      "models": ["minimax/minimax-m2.7", "z-ai/glm-5.1"],
      "transformer": {
        "use": [
          ["maxtoken", { "max_tokens": 32768 }],
          "enhancetool",
          "cleancache"
        ]
      }
    }
  ],
  "Router": {
    "default": "freebuff,minimax/minimax-m2.7"
  }
}
```

### Generic (any OpenAI-compatible client)

```bash
# Set these env vars or pass in your client's settings
OPENAI_API_BASE=http://localhost:9187/v1
OPENAI_API_KEY=your-proxy-key   # only if key protection is ON
```

### curl

```bash
# No key (protection OFF)
curl http://localhost:9187/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"minimax/minimax-m2.7","messages":[{"role":"user","content":"hello"}]}'

# With key (protection ON)
curl http://localhost:9187/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer sk-your-proxy-key" \
  -d '{"model":"z-ai/glm-5.1","messages":[{"role":"user","content":"hello"}]}'

# Streaming
curl http://localhost:9187/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"minimax/minimax-m2.7","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

## API Key Protection

By default the proxy is open (no key required). From the dashboard **API Keys** page you can:

- **Generate keys** — random or custom
- **Toggle protection ON/OFF** — works even when keys exist
- **Track per-key usage** — requests, tokens in/out

When protection is **OFF**, anyone can hit `/v1/*` without a key. When **ON**, requests must include `Authorization: Bearer <your-key>` or `?key=<your-key>`.

## Adding Accounts

From the dashboard **Accounts** page:

1. Click **Add Account** → opens a Codebuff login in your browser
2. Complete login in browser
3. Dashboard auto-detects completion and creates the account
4. Session is pre-warmed immediately

Or add auth tokens manually to `config.json` under `AUTH_TOKENS`.

## Project Structure

```
src/
  cli.ts            # entry point, auth flow on first run
  config.ts         # config.json + env loading
  index.ts          # server bootstrap, session pool startup
  server.ts         # Hono routes, middleware, auth
  auth.ts           # Codebuff auth (CLI + web flow)
  auth-store.ts     # accounts + API keys (auth.json)
  db.ts             # SQLite (request_logs, usage queries)
  chat.ts           # /v1/chat/completions handler
  routes/           # API route handlers
  types.ts          # shared types & model constants
dashboard/
  src/              # SolidJS SPA
  dist/             # built assets served by backend
data/               # runtime data (gitignored)
  auth.json         # accounts + API keys
  proxy.db          # SQLite request logs
  session-state.json
```

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Build backend (tsup) |
| `npm run build:dashboard` | Build frontend (vite) |
| `npm start` | Run built backend |
| `npm run typecheck` | TypeScript check |
