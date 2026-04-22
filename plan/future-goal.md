# Freebuff2API Proxy — Future Goals

## Phase 2: Dashboard (Solid + Vite)

### Why Solid

| | Solid | preact | React |
|---|---|---|---|
| Bundle | ~7kb | ~15kb | ~45kb |
| Update model | Fine-grained (row-level) | VDOM diff (table-level) | VDOM diff |
| 1000-row log table add 1 row | Only that `<tr>` updates | Re-diff entire table | Re-diff entire table |
| DX | JSX + signals | JSX + hooks | JSX + hooks |

Fine-grained reactivity matters for a live-updating dashboard with request logs streaming in.

### Dashboard Structure

```
dashboard/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── Layout.tsx            # sidebar + main area
│   │   ├── AccountsPanel.tsx     # add/remove Freebuff auth tokens
│   │   ├── BindingsPanel.tsx     # apikey → model binding CRUD
│   │   ├── PoolsStatus.tsx       # live pool/session/run state
│   │   ├── LogsViewer.tsx        # request log table with filters
│   │   └── ProxyConfig.tsx       # (Phase 3) proxy routing rules
│   └── index.tsx
├── index.html
├── vite.config.ts
└── tsconfig.json
```

### Dashboard Pages

```
┌─────────────────────────────────────────────────┐
│  Freebuff2API                                    │
├──────────┬──────────────────────────────────────┤
│          │                                       │
│ Accounts │  ┌─────────────────────────────────┐ │
│ Bindings │  │  Token Pools                     │ │
│ Logs     │  │  ┌────────┬─────────┬────────┐ │ │
│ Pools    │  │  │ Pool   │ Session │ Runs   │ │ │
│ Proxy    │  │  ├────────┼─────────┼────────┤ │ │
│          │  │  │ tok-1  │ minimax │ 5 runs │ │ │
│          │  │  │ tok-2  │ glm     │ 3 runs │ │ │
│          │  │  └────────┴─────────┴────────┘ │ │
│          │  └─────────────────────────────────┘ │
│          │                                       │
│          │  Live feed: 12 req/min avg            │
└──────────┴──────────────────────────────────────┘
```

#### Accounts Page
- List all auth tokens (masked: `fa82...f6a7`)
- Add token (paste full token)
- Remove token
- Shows which model each token's session is pinned to
- Shows session status per token (active / queued / cooldown)

#### Bindings Page
- Table: apikey → model
- Add binding (dropdown: minimax / glm)
- Remove binding
- Bulk actions: "bind all unbound to minimax"

#### Logs Page (requires SQLite — see Phase 3)
- Table: timestamp, model, apikey, token, status, tokens_used, latency_ms
- Filter by: model, apikey, status, time range
- Auto-refresh (poll every 5s or SSE)
- Export CSV

#### Pools Page
- Live view of each token pool
- Session state (active / queued / position / estimated wait)
- Run list per pool (agent, runID, inflight, requestCount)
- Draining runs
- Manual actions: force rotate, force session rebuild

---

## Phase 3: SQLite + Request Logging

### Why SQLite

- bindings.json → SQLite (more reliable, atomic writes)
- Request logs → SQLite (query, filter, aggregate)
- Single file, zero config, no server process
- better-sqlite3: synchronous, fast, simple

### Schema

```sql
-- API key to model bindings
CREATE TABLE bindings (
  api_key  TEXT PRIMARY KEY,
  model    TEXT NOT NULL,          -- 'minimax/minimax-m2.7' or 'z-ai/glm-5.1'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Request logs
CREATE TABLE request_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,       -- ISO timestamp
  api_key     TEXT,                 -- which proxy key made request
  token_pool  TEXT,                 -- which auth token pool served it
  model       TEXT NOT NULL,        -- requested model
  agent_id    TEXT,                 -- agent that handled it
  run_id      TEXT,                 -- upstream run ID
  status_code INTEGER,             -- HTTP response status
  tokens_in   INTEGER,             -- input tokens (if available)
  tokens_out  INTEGER,             -- output tokens (if available)
  latency_ms  INTEGER,             -- total request time
  error       TEXT,                -- error message if failed
  is_stream   INTEGER DEFAULT 0    -- was it a streaming request?
);

CREATE INDEX idx_logs_created ON request_logs(created_at);
CREATE INDEX idx_logs_model ON request_logs(model);
CREATE INDEX idx_logs_api_key ON request_logs(api_key);

-- Auth tokens (instead of config-only)
CREATE TABLE auth_tokens (
  token     TEXT PRIMARY KEY,
  name      TEXT,                   -- human label like "account-1"
  session_model TEXT DEFAULT 'minimax/minimax-m2.7',
  added_at  TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);
```

### Migration Plan

```
Phase 3a: Add SQLite alongside JSON
  - binding-store.ts → reads/writes SQLite instead of bindings.json
  - Auth tokens still from config (backward compat)
  - Add request logging middleware on /v1/chat/completions

Phase 3b: Auth token management via DB
  - admin.ts: add/remove tokens at runtime (no restart)
  - Still read AUTH_TOKENS from config as seed on first run
  - New endpoint: POST /admin/tokens { "token": "...", "name": "acct-1", "model": "glm" }

Phase 3c: Log aggregation
  - Dashboard LogsViewer polls GET /admin/logs?since=...
  - Or SSE endpoint: GET /admin/logs/stream
  - Retention: auto-delete logs older than 7 days (configurable)
```

---

## Phase 4: HTTP/SOCKS5 Proxy Routing

### Architecture

```
┌─────────────────────────────────────────┐
│  Request comes in                       │
│  model = "minimax/minimax-m2.7"         │
│                                         │
│  proxyRouter.getProxyFor(model)         │
│     │                                   │
│     ├── Route: minimax → direct         │ ← no proxy
│     ├── Route: glm → socks5://p1:1080   │ ← SOCKS5 proxy
│     ├── Route: gemini → http://p2:8080  │ ← HTTP proxy
│     └── Default: direct                 │ ← fallback
│                                         │
│  undici dispatcher = matching agent     │
│  upstream.fetch(url, { dispatcher })    │
└─────────────────────────────────────────┘
```

### undici Dispatcher Pattern

undici uses "dispatchers" — each dispatcher handles connection routing. This is perfect:

```typescript
import { Agent, ProxyAgent } from 'undici'
import { SocksProxyAgent } from 'socksv5' // or similar

// Direct connection
const directDispatcher = new Agent()

// HTTP proxy
const httpProxy = new ProxyAgent('http://proxy1:8080')

// SOCKS5 → undici doesn't have native SOCKS5,
// but we can tunnel through a custom connect function
const socksProxy = new Agent({
  connect({ hostname, port }, callback) {
    // Use socksv5 to create SOCKS5 socket
    // then hand it to undici
  }
})

// Per-request routing
const router = new Map([
  ['minimax/minimax-m2.7', directDispatcher],
  ['z-ai/glm-5.1', httpProxy],
  ['google/gemini-2.5-flash-lite', socksProxy],
])

// In upstream.ts
function getDispatcher(model: string): Dispatcher {
  return router.get(model) ?? directDispatcher
}

// On the fetch call
upstream.fetch(url, { dispatcher: getDispatcher(model) })
```

### Config format

```json
{
  "PROXY_ROUTES": {
    "minimax/minimax-m2.7": "direct",
    "z-ai/glm-5.1": "socks5://user:pass@proxy1:1080",
    "google/gemini-2.5-flash-lite": "http://proxy2:8080",
    "_default": "direct"
  }
}
```

### New deps (Phase 4 only)

```
socksv5    → SOCKS5 client library
```

### Dashboard (Phase 4)

```
Proxy Config Page:
  ┌────────────────────────────────────┐
  │ Model              Proxy           │
  ├────────────────────┬───────────────┤
  │ minimax/minimax... │ direct        │
  │ z-ai/glm-5.1      │ socks5://p1   │
  │ google/gemini-2... │ http://p2     │
  ├────────────────────┴───────────────┤
  │ [+ Add Route]    [Test Connection] │
  └────────────────────────────────────┘

Test: proxy route → HEAD request to codebuff.com → show latency / error
```

---

## Phase 2.5: Docker (Self-Host & Forget)

For people who just want to `docker run` and walk away. Not for daily dev.

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
EXPOSE 8080
CMD ["node", "--max-old-space-size=128", "dist/cli.js"]
```

```bash
# Self-host usage
docker run -d --name freebuff-proxy \
  -p 8080:8080 \
  -e AUTH_TOKENS="token1,token2" \
  -e API_KEYS="sk-key1" \
  ghcr.io/user/freebuff-proxy:latest

# With config file
docker run -d -p 8080:8080 \
  -v ./config.json:/app/config.json \
  ghcr.io/user/freebuff-proxy:latest
```

**Note:** Only `dist/` + `node_modules/` in final image. No source, no tsx, no tsup.
Image size: ~80MB.

---

## Phase 5: Extras (nice to have)

| Feature | Notes |
|---|---|
| **Rate limiting** | Per apikey: max req/min, max concurrent streams |
| **Token rotation UI** | Dashboard button: force rotate all runs now |
| **Health alerts** | Webhook on pool cooldown / session expiry failure |
| **Metrics endpoint** | Prometheus-compatible `/metrics` |
| **Multi-upstream** | Support non-codebuff backends (direct OpenAI, etc) |
| **Auto-recovery** | If all pools cooldown → auto-unbind + reassign keys |
| **Token sharing** | Multiple apikeys share same pool (weighted round-robin) |

---

## RAM Target Recap

```
Phase 1 (proxy only):       ~50-80MB at 15 concurrent
Phase 2 (+ dashboard static): +0MB (pre-built files served by hono)
Phase 3 (+ SQLite):          +5-15MB
Phase 4 (+ proxy routing):   +<1MB (just connection pools)

Total target: <100MB at 15 concurrent streams
```

---

## Timeline View

```
Now ─── Phase 1 (Core Proxy) ─── Phase 2 (Dashboard) ─── Phase 3 (SQLite) ─── Phase 4 (Proxy Routing)
 │                                │                        │                  │
 │  2-3 weeks                     │  1-2 weeks             │  1 week          │ 1 week
 │                                │                        │                  │
 ▼                                ▼                        ▼                  ▼
 Working proxy                   Admin UI live            Request logs       SOCKS5/HTTP
 with binding API                in browser              searchable         per-model routing
