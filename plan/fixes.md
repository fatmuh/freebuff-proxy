# Fixes & Adjustments Plan

Based on audit of current implementation vs `webui-sqlite-auth.md`.

---

## Golden Rule: DB vs JSON Separation

| Storage | What goes here | Why |
|---------|---------------|-----|
| **SQLite** (`proxy.db`) | `request_logs` + `admin_sessions` ONLY | High-write, needs querying/filtering/aggregation |
| **JSON files** | Everything else: accounts, API keys, bindings, config | Small datasets, human-readable, git-friendly |

**Nothing else goes into SQLite.** No API keys, no accounts, no bindings, no settings. If it's not a per-request log row or a dashboard session, it lives in a JSON file.

Current state already follows this ✅ — just making it explicit.

---

## Fix 1: Token Extraction from Response

**Problem**: `tokens_in` / `tokens_out` always logged as `null` in `chat.ts`. Plan says capture from response/stream chunks. Currently the response body is streamed through without parsing token counts.

**What to do**:
- For **non-stream** responses: buffer the response body → parse JSON → extract `usage.prompt_tokens` / `usage.completion_tokens` → log them → then forward the buffered body to client
- For **stream** responses: intercept SSE chunks → look for the chunk before `[DONE]` that contains `usage: { prompt_tokens, completion_tokens }` → extract → log after stream completes
- Update ALL `db.insertRequestLog()` calls in `chat.ts` to pass actual `tokens_in` / `tokens_out` instead of `null`

**Files**: `src/routes/chat.ts`

---

## Fix 2: Wire DELETE /api/requests

**Problem**: `handleRequestsPurge` exists in `requests.ts:22-28` but is never registered in `server.ts`. Purge endpoint is unreachable.

**What to do**:
- Add `app.delete('/api/requests', handleRequestsPurge(db))` to `server.ts`

**Files**: `src/server.ts`

---

## Fix 3: Remove Auto-Purge Entirely

**Problem**: Auto-purge of request logs is unnecessary complexity. The DB grows, but SQLite handles large tables fine. No need for a cron job that deletes data. If the user wants to clear old logs, they can do it manually via `DELETE /api/requests?days=N`.

**What to do**:
- Remove the `purgeInterval` + `LOG_RETENTION_DAYS` constant from `index.ts` entirely
- Remove `db.purgeOldLogs()` call from the interval
- Remove `db.cleanExpiredSessions()` from that same interval — but session cleanup is still needed. Move session cleanup to a simpler mechanism (e.g. clean on login, or a lighter interval)
- Keep `DELETE /api/requests` endpoint (once wired in Fix 2) for manual purging if desired
- Keep `purgeOldLogs()` method in `db.ts` (it's useful for the manual endpoint), just don't call it automatically

**Files**: `src/index.ts`

---

## Fix 4: Resume Should Auto-Start New Session

**Problem**: When unpausing an account (`PATCH /api/accounts/:id { paused: false }`), code at `routes/accounts.ts:77-79` only calls `pool.setPaused(false)`. But the session was already ended when the account was paused (via `endSessionNow()` at line 74). So after resume, the pool has no session — it sits idle and broken. Requests to that pool will fail.

**What to do**:
- After `pool.setPaused(false)`, call `void pool.prewarmSession()` to trigger session rebuild
- This makes the pool re-enter the queue → wait for slot → come back online naturally
- Dashboard will see the pool go from Paused → Queued → Active (via the 3s poll)

**Code change** (`routes/accounts.ts:77-79`):
```
// Before (broken):
} else {
  const pool = runs.getPoolByName(id)
  if (pool) pool.setPaused(false)
}

// After (fixed):
} else {
  const pool = runs.getPoolByName(id)
  if (pool) {
    pool.setPaused(false)
    void pool.prewarmSession()  // rebuild session after unpause
  }
}
```

**Files**: `src/routes/accounts.ts`

---

## Fix 5: Web-Triggered Auth Flow for Adding Accounts

**Problem**: Plan says click [Add Account] → server triggers Codebuff auth → returns login URL → user opens in browser → server polls → gets `authToken` → saves account. Currently: user must paste a raw token manually. This is not how it should work. Also missing `GET /api/accounts/flows/:id/status` for polling auth progress.

**What to do**:
- `POST /api/accounts` with no `token` field → triggers `authenticate()` from `auth.ts` → returns `{ loginUrl, flowId }`
- `POST /api/accounts` with `token` field → still works as manual fallback (for advanced users)
- Server starts background polling for the auth flow
- New endpoint: `GET /api/accounts/flows/:flowId/status` → returns `{ status: "pending" | "authenticated" | "failed", accountId?, error? }`
- Once authenticated → server auto-creates account + pool + saves to auth.json
- Dashboard [Add Account] → shows login URL → polls flow status every 3s → shows "Waiting for authentication..." → on success, refreshes accounts list

**Flow**:
```
User clicks [Add Account] on dashboard
  → Dashboard sends POST /api/accounts { name, session_model }
  → Server calls authenticate() from auth.ts
  → authenticate() does: fingerprint → get login URL → start polling
  → Server returns { loginUrl, flowId } immediately
  → Dashboard shows login URL as clickable link + "Open this URL to authenticate"
  → Dashboard polls GET /api/accounts/flows/{flowId}/status every 3s
  → User opens login URL in new tab → authenticates on codebuff.com
  → Server's background poll detects authentication → gets authToken
  → Server auto-creates account entry + TokenPool
  → Flow status endpoint returns { status: "authenticated", accountId: "acct-3" }
  → Dashboard refreshes → new account appears with queue status
```

**Implementation notes**:
- Need to track in-flight auth flows (Map of flowId → state) in memory on server
- `auth.ts:authenticate()` needs to be adapted to return the login URL early (not block until complete)
- The auth flow is the same as CLI — just split into: (1) return URL, (2) background poll, (3) resolve

**Files**: `src/routes/accounts.ts`, `src/auth.ts`, `dashboard/src/components/AccountsPanel.tsx`

---

## Fix 6: Remove Bindings Page — Bindings Live on Accounts Page

**Problem**: Plan had a separate Bindings page (`BindingsPanel.tsx`). But bindings (apikey → model routing) are directly tied to accounts — they determine which account's pool handles a request. A separate page is redundant and splits a single concern across two pages.

**Current architecture (two overlapping systems)**:
- `binding-store.ts` → `bindings.json`: maps `apikey → model` (used for routing in `chat.ts:40`)
- `auth-store.ts` → `auth.json`: each `ApiKeyEntry` has `bound_account_id` → account → account.session_model (redundant routing path via `getBindingForApiKey()`)

These overlap. Both can determine what model a request routes to. We need to pick ONE path.

**Decision**: Keep `binding-store.ts` (`bindings.json`) as the routing source. It's already what `chat.ts` uses. Remove `bound_account_id` from API keys (see Fix 7).

**What to do**:
- **Delete** `dashboard/src/components/BindingsPanel.tsx`
- **Remove** `/bindings` from `Layout.tsx` nav (5 items → 4 items: Home, Accounts, API Keys, Requests)
- **Keep** `/api/bindings/*` backend routes — they're still needed internally
- **Add** a "Bindings" sub-section on the Accounts page:
  - Table showing: apikey (masked) → model → bound account (if resolvable)
  - [Add Binding] → pick an API key from dropdown + pick model → creates binding
  - [Remove] per binding row
  - This way: accounts + their bindings are on one page
- Remove the `/bindings` route from `App.tsx` / router

**Files**: `dashboard/src/components/AccountsPanel.tsx`, `dashboard/src/components/Layout.tsx`, delete `dashboard/src/components/BindingsPanel.tsx`, `dashboard/src/App.tsx` (or router file)

---

## Fix 7: API Keys Page — Proxy Keys Only, No Binding/Account Concept

**Problem**: Current `ApiKeyEntry` in `auth-store.ts` has `bound_account_id` — tying a proxy key to a specific account. This is wrong. API keys are just proxy access credentials (`sk-xxx`). They gate WHO can use the proxy. The routing (which model/account to use) is determined by the binding, not by the key itself.

**Current state** (redundant routing):
```
Request comes in with sk-abc
  → chat.ts:40 checks bindings.get("sk-abc") → gets model → routes to pool ✅ (correct path)
  → auth-store.getBindingForApiKey("sk-abc") → bound_account_id → account.session_model (redundant!)
```

**What to do**:
- **Remove** `bound_account_id` from `ApiKeyEntry` interface in `auth-store.ts`
- **Remove** `getBindingForApiKey()` method from `auth-store.ts` (redundant — `binding-store.ts` handles this)
- **Remove** account selection dropdown from API key creation form in `ApiKeysPanel.tsx`
- **Remove** "Bound To" column from the keys table in `ApiKeysPanel.tsx`
- API keys = just `sk-xxx` + a name + creation date. That's it.
- Show current protection state: "API Key protection: ON (N keys)" or "OFF (no keys configured)"

**ApiKeyEntry after fix** (note: added `id` field — see Fix 8):
```json
{
  "id": "key-1",
  "key": "sk-abc123...",
  "name": "My Key",
  "created_at": "2026-04-22T10:00:00Z"
}
```

**Files**: `src/auth-store.ts`, `dashboard/src/components/ApiKeysPanel.tsx`

---

## Fix 8: API Key ID — Per-Key Usage Tracking

**Problem**: We want to track usage per API key (tokens used, request count). Currently `request_logs.api_key` stores the raw key string. This works for filtering but is fragile — if a key is deleted, you lose the ability to correlate. We need a stable `id` on each API key that gets logged in every request row.

**What to do**:

1. **Add `id` field to `ApiKeyEntry`** in `auth-store.ts`:
   - Auto-generated on creation: `key-1`, `key-2`, etc. (same pattern as accounts: `acct-1`)
   - Use `nextIdNum` counter (already exists in AuthStore for accounts) — either share it or add a separate counter for keys

2. **Add `api_key_id` column to `request_logs`** in SQLite:
   ```sql
   ALTER TABLE request_logs ADD COLUMN api_key_id TEXT;
   CREATE INDEX idx_logs_api_key_id ON request_logs(api_key_id);
   ```
   - `api_key_id` = the `id` from `ApiKeyEntry` (e.g. `"key-1"`)
   - Populated on every request: look up the API key used → get its `id` → log it
   - If no API key (open mode) → `null`

3. **Update `chat.ts`** to look up the API key's `id` and pass it to `db.insertRequestLog()`:
   - Currently logs `api_key: "sk-abc..."` → also log `api_key_id: "key-1"`
   - Need to pass the `AuthStore` (or a lookup function) to `handleChatCompletions`

4. **Add per-key usage queries** in `db.ts`:
   - `getUsageByApiKey(days)` → groups by `api_key_id`, returns `{ api_key_id, requests, tokens_in, tokens_out }`
   - Join with key name from auth.json for display

5. **Add endpoint** `GET /api/usage/by-key` → returns per-key usage breakdown

6. **Dashboard**: Show per-key usage on API Keys page — each key row shows its total requests + tokens

**Schema change in `db.ts`**:
```sql
-- Add to CREATE TABLE request_logs:
api_key_id TEXT,

-- Add to indexes:
CREATE INDEX IF NOT EXISTS idx_logs_api_key_id ON request_logs(api_key_id);
```

**RequestLog interface update**:
```typescript
export interface RequestLog {
  // ... existing fields ...
  api_key_id: string | null  // NEW: stable ID for per-key tracking
}
```

**Files**: `src/auth-store.ts`, `src/db.ts`, `src/routes/chat.ts`, `src/routes/usage.ts`, `src/server.ts`, `dashboard/src/components/ApiKeysPanel.tsx`

---

## Fix 9: API Keys Stored in JSON — Confirm Correct

**Problem**: User wants to make sure API keys are in a JSON file, NOT in SQLite.

**Current state**: API keys are in `auth.json` (a JSON file). They are NOT in SQLite. ✅

**What to do**:
- This is already correct — just verify nothing leaks
- Confirm: `db.ts` has NO methods for API key storage → ✅ (only request_logs + admin_sessions)
- After Fix 7 removes `bound_account_id`, the `auth.json` structure becomes cleaner
- **No code changes needed** for this fix — it's a verification point

**Files**: none (verification only)

---

## Fix 10: Remove Dead Keys Toggle Code

**Problem**: `handleKeysToggle` exists in `keys.ts:61-65` but is (1) not wired in `server.ts`, and (2) doesn't actually toggle — just reports `hasAnyApiKeys()`. It's dead, misleading code.

**What to do**:
- **Delete** `handleKeysToggle` from `src/routes/keys.ts`
- API key protection is implicitly:
  - **ON** when ≥1 key exists → requests need `Authorization: Bearer sk-xxx`
  - **OFF** when 0 keys exist → proxy is open (local/dev mode)
- Show this state on the API Keys page: "Protection: ON (3 keys)" or "Protection: OFF (open access — no keys)"
- The `enabled` boolean from `GET /api/keys` response (`auth.hasAnyApiKeys()`) already reports this correctly

**Files**: `src/routes/keys.ts` (remove toggle function)

---

## Fix 11: Charts on Requests Page

**Problem**: Plan specifies line chart (requests/day 30d), bar chart (tokens/day), pie chart (per-model split). Currently only data tables — `chart.js` + `solid-chartjs` are in `devDependencies` but never used.

**What to do**:
- Add to `RequestsPage.tsx`:
  - **Line chart**: requests per day (last 30d) — data from `/api/usage/daily`
  - **Bar chart**: tokens_in / tokens_out per day — same `/api/usage/daily` data
  - **Pie chart**: per-model request split — data from `/api/usage/by-model`
- Import and register chart.js components:
  ```
  Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend)
  ```
- Use `solid-chartjs` `<SolidChart>` component
- Charts go ABOVE the request log table (plan: "Top: usage charts, Bottom: request log table")

**Files**: `dashboard/src/components/RequestsPage.tsx`

---

## Fix 12: Model-wise Breakdown on Home Page

**Problem**: Plan says Home page shows "minimax: 80 req / glm: 62 req (today)" per model. Currently only total request count.

**What to do**:
- Fetch `/api/usage/by-model` on Home page
- Add a "MODEL BREAKDOWN" section: inline display of each model + today's request count
- Simple badges/rows, no chart needed on Home page
- Example: `minimax/minimax-m2.7: 142 requests` / `z-ai/glm-5.1: 62 requests`

**Files**: `dashboard/src/components/HomePage.tsx`

---

## Fix 13: Sparkline on Home Page

**Problem**: Plan says "quick usage sparkline: requests per hour today". Not implemented.

**What to do**:
- Add a new DB method `getUsageHourly()` that groups requests by hour for the current day
- Add endpoint `GET /api/usage/hourly` → returns `[{ hour: "2026-04-22T10:00:00Z", requests: 12 }, ...]`
- On Home page: render a simple SVG sparkline (24 data points = 24 hours)
- No need for full chart.js here — a tiny SVG polyline is lighter and fits the "at a glance" feel
- Alternative: if chart.js is already loaded from Fix 10, reuse it for a small line chart

**Files**: `src/db.ts`, `src/routes/usage.ts`, `dashboard/src/components/HomePage.tsx`

---

## Fix 14: Topbar as Permanent Full-Width Header

**Problem**: The topbar (showing "Proxy Running", uptime, total accounts, active, queued) currently lives inside `HomePage.tsx` only. It disappears when you navigate to Accounts, API Keys, or Requests. It should be a permanent header visible on ALL pages, stretching the full screen width (above sidebar + content).

**Current state**: Topbar is rendered inside `HomePage.tsx:75-96` as a child of the page content area. It only shows on the Home route.

**What to do**:
- **Move** the topbar from `HomePage.tsx` into `Layout.tsx` — it becomes part of the shell that wraps all pages
- Position it as a **full-width strip** at the very top of the viewport (above both sidebar and main content)
- Layout restructure:
  ```
  ┌──────────────────────────────────────────────────┐
  │  TOPBAR (full width: Proxy Running | Uptime | Accounts | Active | Queued)  │
  ├──────────┬───────────────────────────────────────┤
  │ Sidebar  │  Main Content (page)                  │
  │          │                                       │
  │ Home     │                                       │
  │ Accounts │                                       │
  │ API Keys │                                       │
  │ Requests │                                       │
  │          │                                       │
  └──────────┴───────────────────────────────────────┘
  ```
- The topbar should:
  - Span `100vw` (full width, not just the content area)
  - Be `position: fixed` or `sticky` at the top
  - Have `var(--surface-color)` background + `1px solid var(--border-color)` bottom border
  - Height: ~44px, compact
  - Main content offset: `padding-top` to account for the header height
- **Remove** the topbar from `HomePage.tsx` (it lives in Layout now)
- The topbar polls `/api/status` every 3s for live data (same as current)
- Data source: `useContext` or a shared signal so it doesn't re-fetch per page

**CSS changes**:
- `.app-container` changes from `display: flex` (sidebar + content) to a grid or nested flex with topbar row first
- `.topbar` gets `position: fixed; top: 0; left: 0; right: 0; z-index: 200`
- `.sidebar` gets `top: 44px` (below topbar) instead of `top: 0`
- `.main-content` gets `padding-top: 44px` or equivalent offset
- On mobile (<768px): topbar stays full width, sidebar bottom nav unaffected

**Files**: `dashboard/src/components/Layout.tsx`, `dashboard/src/components/HomePage.tsx`, `dashboard/src/index.css`

| File | Action | What Changes |
|------|--------|-------------|
| `src/routes/chat.ts` | MODIFY | Extract `tokens_in`/`tokens_out` from non-stream body + stream final chunk; look up `api_key_id` from AuthStore and log it |
| `src/server.ts` | MODIFY | Add `app.delete('/api/requests', ...)`, keep `/api/bindings/*` routes, add `GET /api/usage/by-key`, pass authStore to chat handler |
| `src/index.ts` | MODIFY | Remove auto-purge interval + `LOG_RETENTION_DAYS`; move session cleanup elsewhere |
| `src/routes/accounts.ts` | MODIFY | Resume calls `prewarmSession()`, add auth flow endpoints (`POST` returns loginUrl, `GET flows/:id/status`) |
| `src/auth.ts` | MODIFY | Adapt `authenticate()` to return loginUrl early + background poll (non-blocking) |
| `src/auth-store.ts` | MODIFY | Remove `bound_account_id` from `ApiKeyEntry`, remove `getBindingForApiKey()`, add `id` field to `ApiKeyEntry` with auto-increment |
| `src/routes/keys.ts` | MODIFY | Remove `handleKeysToggle` dead code |
| `src/db.ts` | MODIFY | Add `api_key_id` column to `request_logs` + index; add `getUsageHourly()`; add `getUsageByApiKey()` |
| `src/routes/usage.ts` | MODIFY | Add `GET /api/usage/hourly` endpoint, add `GET /api/usage/by-key` endpoint |
| `dashboard/src/components/AccountsPanel.tsx` | MODIFY | Add auth flow UI (loginUrl + polling), add bindings sub-section |
| `dashboard/src/components/ApiKeysPanel.tsx` | MODIFY | Remove account binding from form + table, show protection ON/OFF state, show per-key usage stats |
| `dashboard/src/components/RequestsPage.tsx` | MODIFY | Add chart.js line/bar/pie charts above request log table |
| `dashboard/src/components/HomePage.tsx` | MODIFY | Add model breakdown section + hourly sparkline, remove topbar (moved to Layout) |
| `dashboard/src/components/Layout.tsx` | MODIFY | Remove Bindings nav item (5 → 4 items), add permanent full-width topbar with status polling |
| `dashboard/src/components/BindingsPanel.tsx` | DELETE | Remove — bindings move to Accounts page |
| `dashboard/src/App.tsx` | MODIFY | Remove `/bindings` route |
| `dashboard/src/index.css` | MODIFY | Topbar full-width fixed header styles, layout restructure for topbar+sidebar+content |
