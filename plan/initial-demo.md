# Freebuff2API Proxy — Initial Demo Plan

## Overview

Rewrite the Go proxy as a Node.js (TypeScript) server using **hono + undici**.
OpenAI-compatible API proxy for Freebuff's free models with multi-token pool management,
pinned session model binding, and streaming SSE passthrough.

---

## Stack

| What | Choice | Why |
|---|---|---|
| Runtime | Node 22 + tsx | Run TS directly, no build step |
| Framework | hono | Tiny (~14kb), great middleware, native streaming |
| HTTP Client | undici | Node core team, per-request dispatcher (future proxy routing) |
| Types | TypeScript | State machines + pool mgmt = type safety saves bugs |

**Runtime deps: 3** (hono, undici, tsx). That's it.

---

## Package & Distribution

### npm package — dual use: CLI + programmatic

```json
{
  "name": "freebuff-proxy",
  "bin": { "freebuff-proxy": "./dist/cli.js" },
  "exports": {
    ".": "./dist/index.js"
  }
}
```

**Two ways to use:**

```
1. CLI:  npx freebuff-proxy --config ./config.json
   or:   npm i -g freebuff-proxy && freebuff-proxy

2. Programmatic:
   import { createServer } from 'freebuff-proxy'
   const server = await createServer({ authTokens: [...] })
   server.listen(8080)
```

### Scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",              // dev server with hot reload
    "build": "tsup src/index.ts src/cli.ts",       // compile to dist/
    "start": "node dist/index.js",                 // production run
    "typecheck": "tsc --noEmit"                     // type check only
  }
}
```

```
dev mode:   npm run dev       → tsx watch = hot reload on file change
build:      npm run build     → tsup bundles to dist/ (CJS + ESM)
prod run:   npm run start     → node dist/index.js (compiled, fast cold start)
```

### Why tsup (not tsc --build)

```
tsc --build  → outputs TS files as JS, one-by-one, preserves folder structure
tsup         → bundles everything into clean dist/ (CJS + ESM + d.ts)
               tree-shakes unused code
               generates CLI entry point
               1 file vs 15 files = cleaner npm package
```

### New dep: tsup (devDependency only)

```
Runtime:     hono, undici                    (2 deps)
Dev:         typescript, tsx, tsup           (3 devDeps)

npm install -g freebuff-proxy → only hono + undici downloaded
```

---

## Project Structure

```
freebuff-proxy/
├── src/
│   ├── index.ts              # exports createServer() for programmatic use
│   ├── cli.ts                # CLI entry: parse args, load config, call createServer()
│   ├── config.ts             # JSON + env loader, validation
│   ├── types.ts              # shared interfaces/types
│   ├── server.ts             # hono app, middleware, route wiring
│   ├── routes/
│   │   ├── healthz.ts        # GET /healthz
│   │   ├── models.ts         # GET /v1/models
│   │   ├── chat.ts           # POST /v1/chat/completions
│   │   └── admin.ts          # /admin/bind, /admin/unbind, /admin/status
│   ├── upstream.ts           # undici calls to codebuff.com backend
│   ├── model-registry.ts     # fetch + parse free-agents.ts → model↔agent map
│   ├── run-manager.ts        # token pools, run start/finish/rotate/drain
│   ├── session-manager.ts    # free session lifecycle (simplified — no auto-switch)
│   ├── binding-store.ts      # apikey → primary model mapping (in-mem + JSON persist)
│   ├── schema-normalize.ts   # $ref resolve, nullable simplify, type normalize
│   └── utils.ts              # error formatting, ID generation, helpers
├── dist/                     # built output (gitignored)
├── data/                     # runtime data (gitignored)
│   └── bindings.json         # persisted key→model bindings
├── package.json
├── tsconfig.json
├── tsup.config.ts            # build config
└── config.example.json
```

---

## Key Design Decisions

### 1. No Auto Session Switching (the big change from Go)

Go version: request for `glm` → detects session is `minimax` → ends session → creates glm session → queue wait → finally serves

**Our version: sessions are pinned.** Each token pool gets a fixed `sessionModel`. Never switches.

```
token-1 → session pinned to minimax/minimax-m2.7
token-2 → session pinned to z-ai/glm-5.1

Request comes in with apikey bound to glm → routes to token-2 → done
No model_locked. No session teardown. No queue thrashing.
```

### 2. API Key → Model Binding

New concept not in Go version. Each client API key binds to one primary model.

```
POST /admin/bind    { "api_key": "sk-abc1", "model": "z-ai/glm-5.1" }
POST /admin/unbind  { "api_key": "sk-abc1" }
GET  /admin/status  → all bindings + pool states
```

Flow on `/v1/chat/completions`:
```
1. Auth check (Bearer token = api_key)
2. Lookup api_key in binding-store → get primary model
3. No binding? → default to minimax/minimax-m2.7
4. Find token pool that has a session for that primary model
5. Proxy request through that pool
```

### 3. Simplified Session Lifecycle

```
States:
  none → creating → queued → active → expired → creating (loop)

No more:
  ✗ model_locked handling
  ✗ primaryModelFor() logic
  ✗ session switching on model mismatch
  ✗ end-session-then-recreate-on-model-change

Just:
  ✓ Pool created with fixed sessionModel
  ✓ Session starts for that model
  ✓ Stays on that model forever
  ✓ Expires → rebuild with same model
```

### 4. Primary Models (same as Go)

```
Primary (own a session via x-freebuff-model header):
  - minimax/minimax-m2.7
  - z-ai/glm-5.1

Sub models (ride on any active session):
  - google/gemini-2.5-flash-lite
  - google/gemini-3.1-flash-lite-preview
  - etc

Sub models → use whichever session is active on the pool they land on.
No special handling needed.
```

---

## Modules — What Each Does

### `config.ts`
- Load `config.json` from CWD (or `--config` flag)
- Env vars override JSON values (same keys as Go)
- Validate required fields
- Parse duration strings ("6h", "15m") to ms

```typescript
interface Config {
  listenAddr: string        // default ":8080"
  upstreamBaseURL: string   // default "https://codebuff.com"
  authTokens: string[]      // Freebuff auth tokens
  rotationInterval: number   // ms, default 6h
  requestTimeout: number    // ms, default 15min
  apiKeys: string[]         // proxy auth keys
  httpProxy: string         // (future, ignored for now)
}
```

### `upstream.ts`
- undici client with configurable base URL + timeout
- Methods: `startRun(token, agentID)`, `finishRun(token, runID, steps)`, `chatCompletions(token, body)`
- Session methods: `createSession(token, model)`, `getSession(token, instanceID)`, `endSession(token)`
- All methods return typed responses
- Uses `undici.fetch` or `undici.Pool` for connection reuse

### `model-registry.ts`
- Fetch `free-agents.ts` from GitHub on startup
- Parse with regex: `'agentId': new Set(['model1', 'model2'])`
- Build agent→models and model→agent maps
- Refresh every 6h in background
- Hardcoded fallback if fetch fails
- Thread-safe via simple JS (single-threaded, no mutex needed)

### `session-manager.ts`
- One `SessionManager` per token pool
- Fixed `sessionModel` set at construction — **never changes**
- `ensureSession()`: returns instanceID for requests
  - Active + not expired → return instanceID
  - Queued → poll until active (with smart delay based on estWaitMs)
  - Expired/none → create new session for the pinned model
- Background polling for queued sessions
- `watchExpiry()`: auto-rebuild when session expires
- `invalidateSession()`: force rebuild (on upstream error)

### `run-manager.ts`
- Manages N `TokenPool` instances (one per auth token)
- Each pool has:
  - `runs`: Map<agentID, ManagedRun>
  - `session`: the pinned SessionManager
  - `draining`: runs being finished off
  - `cooldownUntil`: if upstream rejects token
- `acquire(agentID, model)` → round-robin pools → pick one with matching session model → return lease
- `release(lease)` → decrement inflight → finish run if no inflight + rotated out
- `invalidate(lease, reason)` → kill run, remove from maps
- `cooldown(lease, duration)` → mark pool as cooling down
- Background: rotate runs that exceed `rotationInterval`, finish drained runs

### `binding-store.ts`
- In-memory `Map<string, string>` → apikey → primaryModel
- Persist to `data/bindings.json` on every mutation
- Load from file on startup
- `bind(apiKey, model)`, `unbind(apiKey)`, `get(apiKey)`, `list()`
- Default model when no binding: `minimax/minimax-m2.7`

### `schema-normalize.ts`
- Port of Go's schema normalization logic
- Resolve `$ref` references against `definitions` / `$defs`
- Simplify `anyOf`/`oneOf` nullable combinators (remove null option, merge)
- Normalize `type` field (array → first non-null)
- Clean `enum` (remove nulls, dedupe)
- Remove `nullable` field
- Recursion depth limit (12, same as Go)

### `routes/chat.ts` — Main proxy flow
```
1. Validate: POST only, JSON body, model field present
2. Lookup model in registry → get agentID
3. Lookup api_key in binding-store → get primary model
4. Find pool with session matching that primary model
5. Acquire lease from pool (starts run if needed, ensures session)
6. Inject upstream metadata (run_id, cost_mode, freebuff_instance_id, client_id)
7. Normalize tool schemas if present
8. POST to upstream /api/v1/chat/completions
9. Success (2xx) → pipe response body to client (SSE streaming)
10. Session invalid → invalidate + retry once
11. Run invalid → invalidate + retry once
12. 401 → cooldown pool + invalidate session
13. Other error → passthrough
```

### `routes/admin.ts`
```
POST /admin/bind     → bind apikey to model, persist
POST /admin/unbind   → remove binding
GET  /admin/status   → return: bindings[], pools[], sessions[]
```

---

## Request Flow Diagram

```
Client
  │
  │ POST /v1/chat/completions
  │ Authorization: Bearer sk-abc1
  │ { "model": "google/gemini-2.5-flash-lite", "messages": [...] }
  │
  ▼
┌───────────────────────────────────────┐
│  Auth Middleware                       │
│  sk-abc1 in config.apiKeys? → yes     │
└───────────┬───────────────────────────┘
            │
            ▼
┌───────────────────────────────────────┐
│  Binding Store                        │
│  sk-abc1 → "z-ai/glm-5.1"            │
│  (primary model for this key)         │
└───────────┬───────────────────────────┘
            │
            ▼
┌───────────────────────────────────────┐
│  Model Registry                       │
│  "google/gemini-2.5-flash-lite"       │
│    → agentID: "file-picker"           │
└───────────┬───────────────────────────┘
            │
            ▼
┌───────────────────────────────────────┐
│  Run Manager                          │
│  Find pool with session=glm           │
│  → token-2 (pinned to glm)            │
│  Acquire lease:                       │
│    - ensure session (glm, active ✓)   │
│    - ensure run (file-picker)          │
│    - inject metadata                  │
└───────────┬───────────────────────────┘
            │
            ▼
┌───────────────────────────────────────┐
│  Upstream Client                      │
│  POST /api/v1/chat/completions        │
│  Authorization: Bearer <auth-token-2> │
│  x-freebuff-instance-id: <inst-xyz>   │
│  Body: { ... + codebuff_metadata }    │
└───────────┬───────────────────────────┘
            │
            ▼
  codebuff.com upstream
            │
            ▼ (stream SSE back)
  Client receives response
```

---

## Config

Same format as Go version for easy migration:

```json
{
  "LISTEN_ADDR": ":8080",
  "UPSTREAM_BASE_URL": "https://codebuff.com",
  "AUTH_TOKENS": ["token1", "token2"],
  "ROTATION_INTERVAL": "6h",
  "REQUEST_TIMEOUT": "15m",
  "API_KEYS": ["sk-proxy-key-1"],
  "HTTP_PROXY": ""
}
```

Env vars override JSON (same keys). Example: `AUTH_TOKENS=token1,token2`

---

## Local Dev & Build

```
# Dev (hot reload)
npm run dev
# → tsx watch src/index.ts
# → edits to any .ts file → auto restart
# → reads config.json from CWD

# Build (compile)
npm run build
# → tsup bundles src/index.ts + src/cli.ts → dist/
# → outputs CJS + ESM + .d.ts types

# Prod run (compiled, fast)
node dist/index.js
# or via CLI:
node dist/cli.js --config ./config.json

# Global install after build
npm link
# → now `freebuff-proxy` command available system-wide
```

Memory: target **<100MB** at 15 concurrent streams.

---

## Build Tool: tsup (esbuild under the hood)

```
tsup = esbuild + sane defaults

What it does:
  - Bundles TS → JS using esbuild (same engine, ~10-50x faster than tsc)
  - Outputs CJS + ESM dual format from one build
  - Generates .d.ts type declarations
  - CLI entry point: separate bundle for bin field
  - Tree-shakes unused code
  - Zero config needed (just entry points)

Why not raw esbuild:
  - esbuild = lower level, you config everything yourself
  - tsup = esbuild + "I know what npm packages need"
  - One tsup.config.ts vs 40-line esbuild config for same result
```

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['cjs', 'esm'],
  dts: true,           // generate .d.ts files
  clean: true,         // wipe dist/ before build
  splitting: false,    // single bundle per entry
  minify: false,       // readable output for debugging
  sourcemap: true,
})
```

**Build output:**
```
dist/
├── index.js           ← ESM (programmatic import)
├── index.cjs          ← CJS (require())
├── index.d.ts         ← types
├── cli.js             ← ESM (bin entry)
├── cli.cjs            ← CJS (bin entry)
└── cli.d.ts
```

---

## Build Order

```
Step 1  → package.json + tsconfig.json + tsup.config.ts + types.ts
Step 2  → config.ts
Step 3  → utils.ts (error formatting, ID gen, helpers)
Step 4  → upstream.ts (undici client)
Step 5  → schema-normalize.ts
Step 6  → model-registry.ts
Step 7  → binding-store.ts
Step 8  → session-manager.ts (simplified, pinned model)
Step 9  → run-manager.ts (token pools, rotation, drain)
Step 10 → routes (healthz, models, chat, admin)
Step 11 → server.ts (wire routes + middleware)
Step 12 → index.ts (createServer export) + cli.ts (arg parsing)
Step 13 → config.example.json
```

Each step testable independently. No "big bang" wiring at the end.

---

## Step 14: Verification (Real Test with Live Freebuff Token)

After all modules are wired, verify with the **existing Go project's config** (which has a real auth token and keys).

### Setup

```bash
# 1. Copy config from Go project
cp ~/proj/Freebuff2API/config.json ~/proj/freebuff-proxy/config.json

# 2. Start the Node proxy on dev mode (hot reload)
cd ~/proj/freebuff-proxy
npm run dev
# → reads config.json from CWD
# → boots on :9187 (same port as Go config)
```

### Test Checklist

```bash
# T1: Health check — pool state, uptime
curl http://localhost:9187/healthz
# expect: { ok: true, uptime_sec: N, token_state: [...] }

# T2: Models list — should show free models
curl http://localhost:9187/v1/models
# expect: { object: "list", data: [{ id: "minimax/minimax-m2.7", ... }, ...] }

# T3: Chat completions — actual proxy request (non-stream)
curl -X POST http://localhost:9187/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/minimax-m2.7",
    "messages": [{"role": "user", "content": "say hello"}],
    "stream": false
  }'
# expect: OpenAI-format response with content

# T4: Chat completions — streaming (SSE)
curl -X POST http://localhost:9187/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/minimax-m2.7",
    "messages": [{"role": "user", "content": "count to 5"}],
    "stream": true
  }'
# expect: SSE chunks: data: {...}\n\ndata: {...}\n\n...data: [DONE]\n\n

# T5: Admin — check pool status (no API keys set, so open access)
curl http://localhost:9187/admin/status
# expect: { bindings: [], pools: [{ name: "token-1", ... }] }

# T6: Admin — bind a test key to glm
curl -X POST http://localhost:9187/admin/bind \
  -H "Content-Type: application/json" \
  -d '{ "api_key": "test-glm-key", "model": "z-ai/glm-5.1" }'
# expect: { ok: true }

# T7: Admin — verify binding persisted
curl http://localhost:9187/admin/status
# expect: bindings now shows test-glm-key → glm

# T8: Chat with bound key → should route to glm pool
# (only works if config has API_KEYS and glm token pool)
# Skip if single token — binding just marks preference

# T9: Invalid model — should error
curl -X POST http://localhost:9187/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{ "model": "nonexistent-model", "messages": [{"role": "user", "content": "hi"}] }'
# expect: 400 error with "unsupported model"

# T10: Missing model field — should error
curl -X POST http://localhost:9187/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{"role": "user", "content": "hi"}] }'
# expect: 400 error "model is required"
```

### Success criteria

```
✓ T1 healthz returns ok + pool state
✓ T2 models lists free models from registry
✓ T3 non-stream chat returns actual AI response
✓ T4 streaming chat returns SSE chunks ending with [DONE]
✓ T5 admin/status shows pool info
✓ T6 bind creates and persists binding
✓ T7 binding visible in status
✓ T9 invalid model → proper 400
✓ T10 missing model → proper 400
```

If T3 + T4 pass (real AI responses via Freebuff upstream) → **proxy works.**
