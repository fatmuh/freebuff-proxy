# WebUI + SQLite + Auth + Dashboard Plan

## Current State

- Hono server on `:9187` with `/v1/models`, `/v1/chat/completions`, `/admin/*`
- Auth: `API_KEYS` (proxy keys) checked via Bearer header middleware (`server.ts:23-46`)
- Auth flow for Codebuff tokens: `auth.ts` → CLI-based fingerprint → login URL → poll → get `authToken` → save to config.json
- Bindings: `binding-store.ts` → reads/writes `data/bindings.json` (maps proxy apikey → model)
- Token pools: `run-manager.ts` → `TokenPool[]` per `AUTH_TOKENS` from config
  - Each pool = 1 auth token + 1 session (active/queued) + runs per agent
  - Queue status: `session.position`, `session.queueDepth`, `session.estimatedWaitMs`
- **Current acquire() is NOT true round-robin** (`run-manager.ts:596-611`) — it sorts by readiness and picks the most ready pool first, so one pool gets all traffic until it fails. Need true round-robin across matching pools.
- No request logging, no DB, no web UI

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Hono Server (:9187)                                             │
│                                                                   │
│  /v1/*            → proxy routes (existing, + logging middleware) │
│  /admin/*         → JSON API (existing, stays)                   │
│  /api/auth/*      → dashboard login/logout                       │
│  /api/accounts/*  → add/remove/pause Codebuff accounts            │
│  /api/bindings/*  → CRUD for apikey→model bindings              │
│  /api/usage/*     → usage stats + aggregation queries            │
│  /api/requests/*  → request log queries + filters                │
│  /api/keys/*      → proxy API key CRUD                           │
│  /api/pools       → live pool/session/run status                 │
│  /*.html/js/css   → Solid dashboard (static)                    │
│                                                                   │
│  SQLite (better-sqlite3)         JSON files                      │
│  ├── request_logs  (per-request)  ├── config.json (server config) │
│  └── admin_sessions (login)      ├── bindings.json (apikey→model)│
│                                   └── accounts.json (account DB)  │
└──────────────────────────────────────────────────────────────────┘
```

### Why JSON for accounts/bindings, SQLite only for logs

- Accounts/bindings are small datasets, read frequently, rarely written
- JSON is human-readable, easy to edit manually, git-friendly
- SQLite for request_logs: high write volume, needs querying/filtering/aggregation
- Keeps it simple — no migration needed for bindings (they stay JSON)

---

## Step 1: SQLite for Request Logging

### Schema (only request_logs + admin_sessions)

```sql
-- Per-request metadata log
CREATE TABLE request_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,       -- ISO timestamp
  api_key     TEXT,                -- which proxy API key made request (sk-xxx or empty)
  account_id  TEXT,                -- which Codebuff account (acct-1, acct-2)
  model       TEXT NOT NULL,       -- requested model (minimax/minimax-m2.7)
  agent_id    TEXT,                -- agent that handled it (base2-free)
  run_id      TEXT,                -- upstream run ID
  status_code INTEGER,            -- HTTP response status (200, 429, etc.)
  tokens_in   INTEGER,            -- input tokens (if available)
  tokens_out  INTEGER,            -- output tokens (if available)
  latency_ms  INTEGER,            -- total request time in ms
  error       TEXT,                -- error message if failed
  is_stream   INTEGER DEFAULT 0    -- was it a streaming request?
);

CREATE INDEX idx_logs_created ON request_logs(created_at);
CREATE INDEX idx_logs_model ON request_logs(model);
CREATE INDEX idx_logs_api_key ON request_logs(api_key);
CREATE INDEX idx_logs_account ON request_logs(account_id);

-- Dashboard login sessions
CREATE TABLE admin_sessions (
  id         TEXT PRIMARY KEY,     -- session ID (crypto random)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL          -- 24h TTL
);
```

### Request Logging Middleware

On `/v1/chat/completions`:
- Before request: record `created_at`, `api_key`, `model`, `account_id` (pool name)
- After response: add `status_code`, `latency_ms`, `tokens_in`, `tokens_out`, `error`
- For streams: capture final chunk metadata
- Insert into `request_logs`
- Auto-purge: delete logs older than 7 days (configurable via `LOG_RETENTION_DAYS`) on daily tick

### New dep

```
better-sqlite3
```

---

## Step 2: Dashboard Auth (Simple Password)

### Flow

- **Password**: set via `DASHBOARD_PASSWORD` env var or `.env` file
- **If not set**: dashboard has NO password protection (local/dev mode)
- **If set**: all `/api/*` + dashboard routes require session cookie

### Login

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/auth/login | none | `{ password }` → session cookie |
| POST | /api/auth/logout | session | clear session |
| GET | /api/auth/check | none | returns `{ protected: bool }` |

### Session

- Stored in `admin_sessions` SQLite table
- 24h expiry, HttpOnly cookie, `sid` cookie name
- Middleware checks cookie on every `/api/*` route (except `/api/auth/*`)

---

## Step 3: Accounts (Codebuff Auth Tokens) — JSON + Web Management

### accounts.json structure

```json
{
  "accounts": [
    {
      "id": "acct-1",
      "name": "My Minimax Account",
      "token": "fa82...full-token-here",
      "session_model": "minimax/minimax-m2.7",
      "added_at": "2026-04-22T10:00:00Z",
      "paused": false
    },
    {
      "id": "acct-2",
      "name": "GLM Account",
      "token": "3c1d...full-token-here",
      "session_model": "z-ai/glm-5.1",
      "added_at": "2026-04-22T11:00:00Z",
      "paused": true
    }
  ]
}
```

### Adding an Account (from website)

1. User clicks [Add Account] on dashboard
2. Server calls `auth.ts:authenticate()` → same CLI auth flow but triggered from web
3. User gets a login URL (freebuff.com/auth/...) → opens in browser → authenticates
4. Server polls until authenticated → gets `authToken`
5. Server saves account to `accounts.json` with unique ID (e.g. `acct-3`)
6. Server creates a new `TokenPool` for this token at runtime (no restart)
7. Queue status shown live: `position`, `queueDepth`, `estimatedWaitMs`

### Removing an Account

- DELETE → removes from `accounts.json` → shuts down that TokenPool → drain runs → end session
- If it was the only pool for a model → that model becomes unavailable → requests fail with "no session available for model X"

### Pausing an Account

- PATCH `/api/accounts/:id` with `{ paused: true }`
- Ends the session on upstream (calls `pool.endSessionNow()`)
- Marks pool as paused → excluded from round-robin rotation
- Pool's runs drain naturally
- Keeps account in `accounts.json` with `paused: true`
- Resume: PATCH with `{ paused: false }` → creates new pool/session → enters queue → comes back online

### Switching Session Model (per account)

- Each account has `session_model` (minimax or glm)
- User can switch from dashboard: PATCH `/api/accounts/:id`
- Calls `runManager.switchModel(newModel)` on that pool
- This ends current session → creates new session for new model → likely enters queue
- Queue status updates live on dashboard

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/accounts | list all accounts (token masked) |
| POST | /api/accounts | start auth flow → returns `{ loginUrl }` |
| GET | /api/accounts/:id/status | poll auth flow status (pending/authenticated) |
| PATCH | /api/accounts/:id | update name, session_model, paused |
| DELETE | /api/accounts/:id | remove account + shutdown pool |

---

## Step 4: Round-Robin Request Routing (FIX)

### Current Problem

`run-manager.ts:596-611` sorts pools by readiness and picks the first one. This means one pool gets ALL traffic until it fails. Not round-robin.

### Fix: True Round-Robin with Model Isolation

```typescript
// In RunManager.acquire():

// 1. Filter pools by matching session_model
const matching = this.pools.filter(p => p.sessionModel === primaryModel && !p.isPaused())

// 2. If NO matching pool exists → FAIL immediately
//    "no session available for model X. Go to dashboard and add/switch an account."
if (matching.length === 0) {
  throw new Error(`no session available for model ${primaryModel}`)
}

// 3. Round-robin through matching pools
const startIdx = this.nextIdx % matching.length  // atomic counter
for (let i = 0; i < matching.length; i++) {
  const pool = matching[(startIdx + i) % matching.length]
  // skip cooling down pools, try next
  if (pool.isCoolingDown()) continue
  try { return await pool.acquire(agentId, model) }
  catch { continue }
}

// 4. All matching pools failed
throw new Error(`all pools for ${primaryModel} are unavailable`)
```

### Key Behavior

- **Model isolation**: request for `minimax` → ONLY goes to pools with `sessionModel === 'minimax'`
- **GLM bound key → GLM accounts only**: if no GLM account exists → fails with clear error: "no session available for model z-ai/glm-5.1. Add a GLM account in the dashboard."
- **Round-robin**: distributes across all matching, non-paused, non-cooldown pools
- **Paused pools excluded**: paused accounts don't participate in routing
- **Fallback removed**: old code fell back to ALL pools if no match → now it FAILS instead (correct behavior)

### Changes needed

- Add `isPaused()` method to `TokenPool`
- Add `paused` state to `TokenPool` (set by pause/unpause API)
- Change `RunManager.acquire()` to use round-robin counter + model-strict filtering
- Error response to client: OpenAI-compatible error with clear message about which model is missing

---

## Step 5: Bindings + API Keys (JSON, managed from dashboard)

### Bindings stay in bindings.json

- Maps proxy API key (`sk-xxx`) → model (minimax or glm)
- When a request comes in with that API key → route to pool with matching `session_model`
- Managed from dashboard

### API Keys toggle

- `API_KEYS` in config.json: if empty array → no proxy auth needed (local mode)
- If populated → requests must include `Authorization: Bearer sk-xxx`
- Dashboard shows current state: "API Key protection: ON/OFF"
- Can create/manage API keys from dashboard

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/bindings | list all bindings |
| POST | /api/bindings | bind apikey → model |
| DELETE | /api/bindings/:key | remove binding |
| GET | /api/keys | list proxy API keys (masked) |
| POST | /api/keys | create new API key |
| DELETE | /api/keys/:key | remove API key |
| PATCH | /api/keys/toggle | enable/disable API key requirement |

---

## Step 6: Usage & Request Pages (SQLite queries)

### Usage Page — Aggregated Stats

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/usage/summary | today's totals: requests, tokens_in, tokens_out, avg latency |
| GET | /api/usage/daily | daily breakdown for charting (last 30d) |
| GET | /api/usage/by-model | per-model usage breakdown |
| GET | /api/usage/by-account | per-account usage breakdown |

### Usage Summary Response Example

```json
{
  "today": { "requests": 142, "tokens_in": 52300, "tokens_out": 18400, "avg_latency_ms": 2100 },
  "yesterday": { "requests": 98, ... },
  "last_7d": { "requests": 890, ... },
  "last_30d": { "requests": 3400, ... }
}
```

### Usage Daily Response (for charts)

```json
[
  { "date": "2026-04-22", "requests": 142, "tokens_in": 52300, "tokens_out": 18400 },
  { "date": "2026-04-21", "requests": 98, "tokens_in": 31000, "tokens_out": 12000 }
]
```

### Requests Page — Individual Request Log

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/requests | paginated request logs with filters |
| DELETE | /api/requests | purge logs older than N days |

### Query Params for /api/requests

```
?model=minimax/minimax-m2.7    # filter by model
&account=acct-1                # filter by account
&api_key=sk-xxx                # filter by proxy key
&status=200                    # filter by HTTP status
&from=2026-04-20               # date range start
&to=2026-04-22                 # date range end
&page=1                        # pagination
&limit=50                      # per page
```

---

## Step 7: Solid Dashboard

### Why Solid
- ~7kb bundle vs React ~45kb
- Fine-grained reactivity → live queue updates only re-render changed rows
- JSX + signals (familiar DX)

### Design System — Follow `plan/demo/mock.html`

The mock defines the visual language. Our dashboard follows its **design tokens, colors, borders, backgrounds, and typography**. Not its specific elements/charts.

**Color tokens (Catppuccin Mocha — default dark theme):**
```css
--bg-color: #1e1e2e          /* page background */
--surface-color: #181825     /* cards, sidebar, topbar */
--border-color: #313244      /* all borders (1px solid) */
--dot-color: #313244          /* dotted bg pattern */
--text-main: #cdd6f4         /* primary text */
--text-muted: #a6adc8        /* labels, secondary text */
--primary: #89b4fa           /* links, active nav, charts */
--accent-green: #a6e3a1      /* "live" status, success */
--accent-red: #f38ba8         /* errors, down status */
--accent-mauve: #cba6f7      /* brand indicator, accents */
--hover-bg: #313244          /* hover state bg */
```

**Light theme (white) — second theme via toggle:**
```css
--bg-color: #f8f9fa
--surface-color: #ffffff
--border-color: #dee2e6
--dot-color: #ced4da
--text-main: #212529
--text-muted: #868e96
--primary: #339af0
--accent-green: #40c057
--accent-red: #fa5252
--accent-mauve: #845ef7
--hover-bg: #f1f3f5
```

**Design rules from mock:**
- Background: dotted pattern `radial-gradient(var(--dot-color) 1px, transparent 1px)` at `24px 24px`
- All borders: `1px solid var(--border-color)` — no rounded corners (everything is square/sharp)
- Only round element: `border-radius: 50%` on the live status indicator dot (8px)
- Cards: `background: var(--surface-color)`, `border: 1px solid var(--border-color)`, `padding: 24px`
- Font: `Inter` for UI, `JetBrains Mono` for numbers/metrics/code
- Card titles: `0.85rem`, uppercase, `letter-spacing: 1px`, `var(--text-muted)`
- Big metrics: `JetBrains Mono`, `2.5rem`, `font-weight: 700`
- Sidebar: 260px wide, `var(--surface-color)` bg, `1px solid var(--border-color)` right border
- Active nav: `var(--primary)` color, `4px solid var(--primary)` left border, `var(--hover-bg)` bg
- Tables: `JetBrains Mono` for data, `Inter` for headers, headers uppercase
- Badges: `var(--hover-bg)` bg, `1px solid var(--border-color)`, `var(--text-main)` text, square
- Theme toggle: bottom of sidebar, transparent bg, `1px solid var(--border-color)` border

**Our dashboard uses these tokens. Our layout and pages are our own.** We don't copy the mock's "Provider Latency" table or "Cache Hit Rate" card — we build our own content (accounts, bindings, requests) using the same visual language.

### Sidebar — 5 Sections

```
┌─────────────────┐
│  🔄 Freebuff     │
│                   │
│  Home             │   ← today's usage, token counts, req counts, model-wise breakdown, account status at a glance (queue pos, cooldown)
│  Accounts         │   ← add/remove/pause Codebuff accounts, session model switch, queue status LIVE
│  Bindings         │   ← apikey → model mapping
│  API Keys         │   ← proxy key management, on/off toggle
│  Requests         │   ← per-request log table with filters + usage charts (daily/30d)
└─────────────────┘
```

### Pages

**Home** — the dashboard overview, everything at a glance
- **Today's stats cards**: total requests, tokens_in, tokens_out, avg latency
- **Model-wise breakdown**: minimax: 80 req / glm: 62 req (today)
- **Account status strip**: each account in a row → status badge:
  - 🟢 Active
  - 🟡 Queued #3/12 (~2min)
  - 🔴 Cooldown (5min left)
  - ⏸ Paused
- **Quick usage sparkline**: requests per hour today (mini chart)
- **Recent requests**: last 5 requests in a mini table

**Accounts**
- Table: name, token (masked), session_model, status, actions
- Status shown LIVE (polls `/api/pools` every 3s):
  - Active → green badge "Active"
  - Queued → amber badge "Queued #3/12 (~2min)"
  - Cooldown → red badge "Cooldown (5min left)"
  - Paused → gray badge "Paused"
- [Add Account] → opens auth flow → shows login URL → polls until done
- [Switch Model] dropdown → minimax / glm → triggers session rebuild → shows queue
- [Pause] → ends session, pauses pool → row shows "Paused" badge
- [Resume] → unpauses, creates new session → enters queue → shows queue status
- [Remove] → confirms → shuts down pool → removes account

**Bindings**
- Table: apikey → model
- [Add Binding] → apikey + model dropdown
- [Remove] per row

**API Keys**
- Toggle: "Require API Key" ON/OFF (calls `/api/keys/toggle`)
- Table: key (masked), bound model, created date
- [Generate Key] → creates random `sk-xxx` key
- [Remove] per key

**Requests**
- Top: usage charts (line chart: requests/day last 30d, bar chart: tokens/day, pie: per-model split)
- Bottom: request log table
- Table columns: time, model, account, api_key, status, tokens_in, tokens_out, latency, error
- Filters: model, account, api_key, status, date range
- Auto-refresh toggle (5s)
- Pagination
- [Export CSV]

### Live Updates Strategy

- Home page (account status strip): poll `/api/pools` every 3s → Solid signals update only changed badges
- Accounts page (queue status): same poll `/api/pools` every 3s
- Requests page: poll `/api/requests?since=lastId` every 5s
- No SSE/WebSocket — polling is simpler and sufficient for admin dashboard

### Directory Structure

```
dashboard/
├── src/
│   ├── App.tsx                    # router + auth guard
│   ├── components/
│   │   ├── Layout.tsx              # sidebar + main area
│   │   ├── LoginPage.tsx           # password form
│   │   ├── HomePage.tsx            # today's stats + account status strip + model breakdown
│   │   ├── AccountsPanel.tsx       # accounts + queue status + add/switch/pause/resume
│   │   ├── BindingsPanel.tsx       # apikey → model CRUD
│   │   ├── ApiKeysPanel.tsx        # proxy key management + toggle
│   │   └── RequestsPage.tsx        # usage charts + request log table + filters
│   ├── lib/
│   │   ├── api.ts                  # fetch wrapper for /api/*
│   │   └── auth.ts                 # session check + login/logout
│   └── index.tsx
├── index.html
├── vite.config.ts                  # SolidPlugin + build to ../dist-dashboard/
└── tsconfig.json
```

### Mobile Support

All pages must be responsive and usable on mobile:
- **<768px**: sidebar collapses to bottom nav bar (horizontal scroll), cards stack full-width
- **768-1024px**: sidebar stays, cards go 2-column grid
- **>1024px**: full desktop layout, 12-col grid
- Touch-friendly: buttons min 44px tap target, table rows scroll horizontally on small screens
- The mock already has media queries at 768px and 1024px breakpoints — follow the same pattern
- No hamburger menu complexity — sidebar becomes bottom nav on mobile (like the mock's `flex-direction: row` for nav-links)

### Build & Serve

- `vite build` → outputs to `dist-dashboard/`
- Hono serves static files via `serveStatic` from `@hono/node-server`
- In dev: Vite dev server on `:5173`, proxy `/api/*` to Hono on `:9187`

### New deps (all SolidJS ecosystem)

```
solid-js                    # core framework
@solidjs/router             # client-side routing
vite-plugin-solid           # Vite plugin for Solid
chart.js                    # chart engine
solid-chartjs               # Solid wrapper for chart.js
```

---

## Implementation Order

```
Step 1: SQLite + request logging
  1a: Add better-sqlite3 + create db.ts (init schema, helpers)
  1b: Add request logging middleware on /v1/chat/completions
  1c: Add /api/usage/* + /api/requests/* endpoints
  1d: Auto-purge old logs on daily tick

Step 2: Dashboard auth
  2a: Add admin_sessions table + auth middleware
  2b: Add /api/auth/login, /api/auth/logout, /api/auth/check
  2c: DASHBOARD_PASSWORD env var support (.env file)

Step 3: Round-robin fix + account management
  3a: Fix RunManager.acquire() → true round-robin + model-strict filtering (no fallback)
  3b: Add isPaused() to TokenPool + paused state
  3c: Create accounts.json persistence layer (accounts-store.ts)
  3d: Adapt auth.ts to work as web-triggered flow (return loginUrl, poll status)
  3e: Add /api/accounts/* endpoints (CRUD + switch model + pause/resume)
  3f: Runtime pool creation: adding account → new TokenPool without restart

Step 4: API key management
  4a: Add /api/keys/* endpoints (list, create, delete, toggle)
  4b: Toggle: enable/disable API key requirement at runtime

Step 5: Solid dashboard
  5a: Scaffold with Vite + Solid
  5b: Login page + auth guard
  5c: Layout + sidebar + routing (5 sections)
  5d: HomePage (today's stats + account status strip + model breakdown)
  5e: AccountsPanel (CRUD + pause/resume + live queue status)
  5f: BindingsPanel (CRUD)
  5g: ApiKeysPanel (CRUD + toggle)
  5h: RequestsPage (usage charts + request log table + filters)
  5i: Build pipeline: vite build → Hono serveStatic
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| DB for logs | SQLite (better-sqlite3) | High write, needs querying/filtering |
| Accounts storage | JSON (accounts.json) | Small dataset, human-readable, easy backup |
| Bindings storage | JSON (bindings.json) | Same — keep existing, no migration |
| Frontend | Solid | Tiny bundle, fine-grained live updates |
| Auth | Session cookie + password from env | Simple, single-admin, no password in DB |
| Dashboard password | DASHBOARD_PASSWORD env / .env | Optional — no set = no protection |
| Real-time | Poll (3-5s) | Simple, sufficient for admin dashboard |
| Account creation | Web-triggered auth flow | Same as CLI but from browser — user gets login URL |
| API keys toggle | Runtime ON/OFF | Local mode = no auth; expose to internet = turn on |
| Request routing | Round-robin + model-strict | Distributes load; fails fast if no matching pool |
| Pause vs delete | Pause keeps account, stops traffic | Don't lose account config; resume anytime |
| Model isolation | Strict: GLM key → GLM accounts only | Prevents cross-model contamination |
