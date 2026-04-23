# freebuff-proxy

OpenAI-compatible API proxy for [Codebuff](https://www.codebuff.com) free models. Exposes a `/v1/chat/completions` endpoint that any AI coding tool can hit — no paid API keys needed.

The proxy manages Codebuff sessions behind the scenes: queues, rotates, and re-authenticates automatically. You just point your editor at `http://localhost:9187/v1`.

## Features

- **Zero config** — just start the server, manage everything from the dashboard
- **OpenAI-compatible** — drop-in for any tool that speaks the OpenAI API
- **Multi-model** — routes by the model you request (`minimax/minimax-m2.7`, `z-ai/glm-5.1`)
- **Session pool** — pre-warms and rotates free Codebuff sessions automatically
- **Dashboard** — real-time usage charts, request logs, account & key management
- **API key protection** — optional; togglable from the dashboard
- **SQLite logging** — every request tracked with tokens, latency, model
- **Web auth flow** — add accounts from the dashboard, no CLI needed

## Quick Start

```bash
git clone <repo-url> && cd freebuff-proxy
npm install
npm run build            # backend (tsup)
npm run build:dashboard  # frontend (vite)
npm start
```

That's it. On first run, the CLI walks you through a browser login to Codebuff and saves the token. Then open the dashboard at `http://localhost:9187/`. Dashboard is open by default — set `DASHBOARD_PASSWORD` env var to enable login protection.

From the dashboard you can do **everything** — no config file editing needed:

- **Add/remove accounts** — browser-based Codebuff login, sessions pre-warm automatically
- **Switch model providers** — assign models to accounts per-pool
- **Generate API keys** — random or custom, toggle protection ON/OFF
- **View usage** — token charts, request logs, per-key stats

### Dev mode (hot reload)

```bash
npm run dev
```

### Advanced: env vars

All config keys can be overridden via env vars (arrays are comma-separated): `LISTEN_ADDR`, `ROTATION_INTERVAL`, `REQUEST_TIMEOUT`, `HTTP_PROXY`, `AUTH_TOKENS`, `TOKEN_MODELS`, `API_KEYS`. Defaults work out of the box — no config file needed.

### Available Models

Both short and full IDs are accepted:

| Short ID | Full ID | Type |
|---|---|---|
| `minimax-m2.7` | `minimax/minimax-m2.7` | Primary |
| `glm-5.1` | `z-ai/glm-5.1` | Primary |

Other models (gemini variants, etc.) ride on whichever primary session is active — no extra config needed.

## AI Editor Configuration

Point any OpenAI-compatible editor at the proxy. If key protection is **ON**, set `api_key` to one of your proxy keys. Both short and full model IDs work (`minimax-m2.7` or `minimax/minimax-m2.7`).

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
