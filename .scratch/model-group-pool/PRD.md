# PRD: Per-Model Account Pool Architecture

**Status:** ready-for-agent
**Labels:** needs-triage

## Problem Statement

The current freebuff-proxy uses a single global active account managed by `RunManager.activePoolName`. Only one account can have a hot session at a time, and all requests route through it regardless of the requested model. This means:
- An account bound to `kimi-k2.6` is forced to serve `deepseek-v4-pro` requests by swapping sessions (via `RunManager.switchModel()`)
- Multiple accounts for the same model cannot share the load — only one account is ever active
- Sessions stay alive forever (no idle timeout), burning upstream quota even when idle
- No OpenAI Responses API support (`/v1/responses` endpoint)
- No automatic quota tracking or auto-pause on exhaustion
- Per-account proxy binding exists (`proxy_id` on Account, `proxy-store.ts`) but the routing logic doesn't take advantage of concurrent model-specific sessions

Users want to maximize free upstream quota by keeping multiple accounts active simultaneously — one hot session per model group, with idle timeout and automatic failover within the model group.

## Solution

Replace the single global active pool (`RunManager.activePoolName` + `activateNextPool()`) with **per-model account pools**. Each model has its own group of accounts. Within a group, one account maintains a hot session at a time. All concurrent requests for that model share that one hot session. After 10 minutes of idle time, the session dies. When a new request comes in, the pool picks the best available account (preferring hot sessions, falling back to idle accounts with session creation).

Port backend improvements from free2api (the TypeScript rewrite at `~/proj/free2api`, not the Go original):
- OpenAI Responses API (`/v1/responses` with 4 files: `responses.ts`, `responses-types.ts`, `responses-converter.ts`, `responses-stream.ts`)
- Buffy system prompt injection into every chat request
- Image content normalization (`input_image` → `image_url`, base64 data URL handling)
- `poolModel` override (use the active session's bound model, not the user's requested model, in upstream payload)
- Decompressed error body handling (`gzip`, `brotli`, `deflate` via `decompressBody()`, `readDecompressedBody()`)
- Garbled body detection (`sanitizeBodyText()`)
- Rate limit tracking from upstream session responses (`rateLimit`, `rateLimitsByModel`)
- `BUN_USER_AGENT` constant
- Per-model status endpoints (`/api/models`, `/api/accounts/usage`)

Keep the per-account proxy CRUD system from freebuff-proxy (`proxy-store.ts`, `routes/proxies.ts`) — do NOT port free2api's global proxy toggle (`routes/proxy.ts`).

## Files to Port / Copy / Create

This section maps every file operation: where to copy from, where to paste, and the decision (PORT / SKIP / CREATE).

### PORT from free2api → freebuff-proxy (copy logic, adapt to new arch)

| Source (`~/proj/free2api/src/`) | Destination (`~/proj/freebuff-proxy/src/`) | What to adapt |
|----------------------------------|---------------------------------------------|---------------|
| `config.ts:40` — `SESSION_IDLE_TIMEOUT` parsing | `config.ts` — add after `httpProxy` line | Remove proxy-related config, keep idle timeout |
| `types.ts:48` — `sessionIdleTimeout` field in `Config` interface | `types.ts` — add to `Config` interface | N/A |
| `types.ts:61-71` — `SessionRateLimit`, `RateLimitsByModel` | `types.ts` — add before `FreeSessionResponse` | N/A |
| `types.ts:137-141` — `rateLimit`, `rateLimitsByModel` in `TokenSnapshot` | `types.ts` — add to `TokenSnapshot` | Change `active` field to `rateLimit` etc |
| `run-manager.ts:207-213` — `captureUsageData()` method | `run-manager.ts` — add to `TokenPool` class | N/A |
| `run-manager.ts:270-278` — `clearCooldown()` method | `run-manager.ts` — add to `TokenPool` class | N/A |
| `run-manager.ts:349-378` — `clearIdleTimer()` + `resetIdleTimer()` | `run-manager.ts` — add to `TokenPool` class | **Behavior change:** caller signals success post-response instead of calling in acquire() |
| `run-manager.ts:400-404` — captureUsageData call in `doSessionRefresh()` | `run-manager.ts` — add to `doSessionRefresh()` | N/A |
| `routes/chat.ts:286-290` — buffy system prompt injection | `routes/chat.ts` — add after message normalization | Requires ModelPoolManager context |
| `routes/chat.ts:308-357` — image normalization functions | `routes/chat.ts` — add at module level | N/A |
| `routes/chat.ts:273-306` — `injectUpstreamMetadata(poolModel)` | `routes/chat.ts` — replace existing function | Change signature to include `poolModel`, remove PRIMARY_MODELS fallback |
| `utils.ts:19` — `BUN_USER_AGENT` constant | `utils.ts` — add after existing constants | N/A |
| `utils.ts:151-163` — `decompressBody()` | `utils.ts` — add after existing helpers | N/A |
| `utils.ts:169-182` — `readDecompressedBody()` | `utils.ts` — add after `decompressBody()` | N/A |
| `utils.ts:192-211` — `sanitizeBodyText()` | `utils.ts` — add after `readDecompressedBody()` | N/A |
| `routes/models.ts:4-8` — `handleModelsList()` handler | `routes/models.ts` — add alongside existing `handleModels()` | Register in `server.ts` |
| `routes/accounts.ts:221-263` — `handleAccountUsage()` handler | `routes/accounts.ts` — add after existing handlers | Adapt `snap` to use model group data |
| `system-prompt.ts` | `system-prompt.ts` — **CREATE** new file | Copy verbatim from free2api |
| `routes/responses.ts` | `routes/responses.ts` — **CREATE** new file | Import injectUpstreamMetadata from chat.ts, use ModelPoolManager |
| `responses-types.ts` | `responses-types.ts` — **CREATE** new file | Copy verbatim |
| `responses-converter.ts` | `responses-converter.ts` — **CREATE** new file | Copy verbatim |
| `responses-stream.ts` | `responses-stream.ts` — **CREATE** new file | Copy verbatim |

### KEEP from freebuff-proxy (do not overwrite)

| File | Reason |
|------|--------|
| `proxy-store.ts` | Per-account proxy CRUD. free2api does not have this. |
| `routes/proxies.ts` | Per-account proxy routes (List/Create/Update/Delete/Test). free2api has `routes/proxy.ts` (global toggle) — NOT the same. |
| `upstream.ts` | Per-account proxy passthrough (proxyId param on startRun, chatCompletions, createSession). free2api uses global dispatcher instead. |
| `auth-store.ts` | Has `proxy_id` field. free2api uses global proxy in auth store instead of per-account proxy. |
| `routes/chat.ts` (current) | Keep request/response flow logic, but adapt to ModelPoolManager. Do NOT overwrite completely — merge changes. |
| PRIMARY_MODELS logic | freebuff-proxy has PRIMARY_MODELS fallback. **Remove this** — model groups replace the need for PRIMARY_MODELS fallback. |

### SKIP / DO NOT PORT from free2api

| Source (`~/proj/free2api/src/`) | Reason |
|--------------------------------|--------|
| `routes/proxy.ts` (global proxy toggle) | freebuff-proxy already has per-account proxy (`routes/proxies.ts` + `proxy-store.ts`). Global toggle is redundant and conflicts. |
| `proxy-agent.ts` (SOCKS5 agent) | freebuff-proxy's `upstream.ts` already handles SOCKS5 via undici. No need for custom SOCKS implementation. |
| `auth-store.ts` (global proxy fields) | free2api stores `proxy_enabled` + `proxy_url` in auth data. freebuff-proxy uses per-account proxy_id instead. |
| `run-manager.ts` (`activePoolName`, `setActivePool`, `activateNextPool`, `switchModel`) | Single-account architecture. Replaced by ModelPoolManager. |
| `PRIMARY_MODELS` / `DEFAULT_PRIMARY_MODEL` logic | Model groups handle this naturally. One account = one model. No need for primary model fallback. |

### CREATE new in freebuff-proxy

| File | Description |
|------|-------------|
| `model-pool-manager.ts` | New deep module. Model group selection + hot session affinity + failover logic. |
| `system-prompt.ts` | Buffy system prompt constant. Copied from free2api. |

## User Stories

1. As an API consumer, I want my `kimi-k2.6` requests to always hit an account bound to `kimi-k2.6`, so that I never waste a session swap.
2. As an API consumer, I want concurrent requests to the same model to share one hot session, so that I get low latency without queueing.
3. As a proxy admin, I want multiple accounts serving the same model to rotate automatically on failure, so that one bad account doesn't kill the entire model group.
4. As a proxy admin, I want sessions to auto-die after 10 minutes of idle time, so that upstream quota isn't wasted on unused accounts.
5. As a proxy admin, I want accounts to auto-pause when their daily quota is exhausted, so that I don't keep hitting rate limits.
6. As a proxy admin, I want paused accounts to auto-unpause at the exact upstream reset time, so that I don't have to babysit them.
7. As a proxy admin, I want to see the daily quota reset countdown on each account in the dashboard, so that I know when it'll be available again.
8. As a proxy admin, I want unlimited models (no rate limit entry in upstream response) to never be paused, so that they stay hot indefinitely.
9. As a proxy admin, I want failed upstream requests to NOT reset the idle timer, so that a broken session dies naturally.
10. As a proxy admin, I want each account to keep its own proxy binding, so that geo-restricted accounts use their specific proxy.
11. As a proxy admin, I want a 503 response with the model name when ALL accounts for a model are unavailable, so that clients know exactly what's wrong.
12. As an API consumer, I want the OpenAI Responses API (`/v1/responses`) to work through the proxy, so that I can use tools built for that API.
13. As a proxy admin, I want the dashboard to show per-model active session counts, so that I can see which models are hot.
14. As a proxy admin, I want to see account status as two columns (serve status + session status), so that I can distinguish "temporarily broken" from "not warmed up".
15. As a proxy admin, I want new accounts added to the proxy to be bound to a specific model at creation time, so that I don't have to manually configure them later.
16. As a proxy admin, I want the proxy to retry a failing request up to 3 times on the same account before moving to the next, so that transient errors don't immediately kill a session.
17. As a proxy admin, I want quota-exhausted accounts to stay paused even if I change my dashboard view, so that the proxy state is consistent.
18. As a proxy admin, I want to manually pause any account regardless of quota state, so that I have emergency override control.
19. As an API consumer, I want image content in various formats (`input_image`, base64 data URLs) to be normalized to `image_url` before hitting upstream, so that I don't have to worry about format compatibility.
20. As a proxy admin, I want the upstream error body to be properly decompressed (gzip, brotli, deflate) before logging or returning to client, so that I can actually read the error.
21. As a proxy admin, I want the system to detect binary/garbled error bodies and replace them with a clean message, so that logs aren't full of garbage.
22. As a proxy admin, I want per-account usage stats (total sessions, requests, tokens) alongside the quota info, so that I can see which accounts are heavily used.
23. As a proxy admin, I want the proxy to persist session state to disk so that restarts reuse existing upstream sessions, so that I don't lose my queue position on restart.
24. As a proxy admin, I want to see all available models in the dashboard with their upstream agent mappings, so that I know what model IDs to bind accounts to.
25. As an API consumer, I want the proxy to inject the buffy system prompt into every chat completion request, so that upstream treats it as a CLI client and doesn't reject it.

## Implementation Decisions

### Module: AuthStore
- freebuff-proxy's `Account` interface already has `session_model: string` (auth-store.ts:11). No schema change needed for this field.
- freebuff-proxy does NOT have `active_account_id` (only free2api does). The new architecture does not need it — replaced by the model group index.
- Add `serve_status` (`active` | `inactive`) and `account_status` (`idle` | `active` | `queued`) to the account record for dashboard display.
- Build an in-memory `Map<model_id, Account[]>` index on startup from the existing `session_model` field on each account. Refresh on every account add/remove/update.
- Keep per-account proxy binding (`proxy_id`) from freebuff-proxy.

### Module: ModelPoolManager (new, deep module)
- Encapsulates all model-group selection logic in a single testable interface.
- Replaces free2api's `RunManager.activePoolName` + `activateNextPool()` pattern entirely.
- In free2api, `activateNextPool(afterName?, reason, requiredModel?)` filters by `sessionModel` and ends sessions on other pools (run-manager.ts:652-669). The new architecture does NOT end other pools' sessions — accounts for different models stay hot simultaneously.
- Interface shape:
  ```typescript
  type ModelPool = {
    model: string
    accounts: AccountPool[]
  }
  type AccountPool = {
    account: Account
    pool: TokenPool
    serve_status: 'active' | 'inactive'
    account_status: 'idle' | 'active' | 'queued'
    cooldown_until: Date | null
    quota_reset_at: Date | null
    last_used_at: Date | null
    inflight: number
  }
  ```
- Selection algorithm:
  ```typescript
  function selectAccount(model: string, pools: AccountPool[]): AccountPool | null {
    const healthy = pools.filter(p => 
      p.serve_status === 'active' && 
      !p.cooldown_until || Date.now() > p.cooldown_until.getTime()
    )
    const hot = healthy.filter(p => p.account_status === 'active')
    if (hot.length) {
      // least inflight, then least recently used
      return hot.sort((a, b) => a.inflight - b.inflight || a.last_used_at - b.last_used_at)[0]
    }
    const idle = healthy.filter(p => p.account_status === 'idle')
    if (idle.length) {
      return idle[0] // will create session synchronously, blocks until active
    }
    return null
  }
  ```
- Each `AccountPool` wraps one `TokenPool` (from existing run-manager). The `TokenPool` manages the actual upstream session and agent run lifecycle.

### Module: TokenPool (modified from run-manager, porting from free2api)
- **Port from free2api:** `clearIdleTimer()` and `resetIdleTimer()` (run-manager.ts:349-378). freebuff-proxy currently lacks these.
- **Behavior change:** In free2api, `resetIdleTimer()` is called on `acquire()` — before the upstream call. This means failed requests keep the session alive. **In the new architecture, timer resets ONLY after a successful 2xx response**, not on acquire. This requires the caller (chat route) to signal success back to the pool after receiving the upstream response.
- **Port from free2api:** `captureUsageData(resp)` (run-manager.ts:207-213) to extract `rateLimit` and `rateLimitsByModel` from upstream session responses. freebuff-proxy currently lacks this.
- Add `quota_reset_at` field and a one-shot `setTimeout` to auto-unpause at `resetAt`.
- **Port from free2api:** `clearCooldown()` method (run-manager.ts:276). freebuff-proxy currently only has `markCooldown()` — no way to clear before timer expires.
- Keep session persistence to disk (already in free2api). freebuff-proxy currently has `persistSessionState()` but free2api's version also saves `rateLimit` data.

### Module: Chat Completions Route
- **Port from free2api:** `BUFFY_SYSTEM_PROMPT` injection as a system message (chat.ts:286-290). freebuff-proxy currently does not inject any system prompt.
- **Port from free2api:** Image content normalization: `input_image` → `image_url`, base64 data URL handling (chat.ts:308-357). freebuff-proxy currently has no image normalization.
- **Port from free2api:** `poolModel` override. In free2api's `injectUpstreamMetadata()`, `cloned.model = poolModel` (chat.ts:282) instead of the user's requested model. In freebuff-proxy, `cloned.model = requestedModel` (chat.ts:262). The new architecture uses `poolModel` — the active session's bound model.
- **Behavior change:** Move `resetIdleTimer()` call to **after** successful upstream response, not on acquire. In free2api, it's called inside `pool.acquire()` before the upstream call.
- **Port from free2api:** Decompressed error body handling. Use `readDecompressedBody()` + `sanitizeBodyText()` for upstream error responses. freebuff-proxy currently just does `body.text()`.

### Module: Responses API Route (new, from free2api)
- Port all 4 files from free2api: `responses.ts`, `responses-types.ts`, `responses-converter.ts`, `responses-stream.ts`.
- `responses.ts` imports `injectUpstreamMetadata` from `chat.ts` (free2api: responses.ts:13), which triggers buffy prompt injection and image normalization automatically.
- Same retry/failover logic as chat: 3 retries per account, then failover to next in model group.
- Reuse the model pool selection logic.

### Module: UpstreamClient (modified)
- Keep per-account proxy passthrough from freebuff-proxy: `startRun(token, agentId, proxyId)`, `chatCompletions(token, body, proxyId)` (upstream.ts:96, 125, 144).
- **Do NOT port** free2api's global proxy system (`setProxy(url)` on a single dispatcher). free2api uses `this.dispatcher` (global singleton) with no per-account proxy support (upstream.ts:39-67).
- **Port from free2api:** `BUN_USER_AGENT` constant (utils.ts:19).

### Module: Utils
- **Port from free2api:** `decompressBody()` (utils.ts:151-163), `readDecompressedBody()` (utils.ts:169-182), `sanitizeBodyText()` (utils.ts:192-211). freebuff-proxy currently lacks all three.
- **Port from free2api:** `BUN_USER_AGENT` (utils.ts:19). freebuff-proxy currently lacks this.

### Module: Config
- **Port from free2api:** `SESSION_IDLE_TIMEOUT` env var parsing (default `10m`) (config.ts:40). freebuff-proxy currently lacks this.

### Module: Dashboard / Status API
- `/api/status` returns per-model active session counts: `{"kimi-k2.6": 2, "deepseek-v4-pro": 1}`.
- `/api/accounts/usage` returns per-account usage + rate limits + reset timers.
- `/api/models` returns list of available models (**port from free2api**: models.ts:4-8). freebuff-proxy currently only has `/v1/models` (OpenAI-compatible) but no `/api/models` admin endpoint.

### API Contracts
- `POST /v1/responses` — new endpoint, OpenAI Responses API format, converts to chat completions internally.
- `GET /api/models` — returns all supported models with agent mappings (**port from free2api**).
- `GET /api/accounts/usage` — returns per-account: `serve_status`, `account_status`, `rate_limit`, `rate_limits_by_model`, `quota_reset_at`, `total_sessions`, `local_usage` (**port from free2api**).
- `GET /api/status` — changed shape: per-model breakdown instead of single active account.

## Testing Decisions

### What to test
- **ModelPoolManager** (deep module): selection algorithm with various states (all hot, mix, all unavailable, cooldown, quota exhausted). Only test the selection output, not internal state.
- **TokenPool idle timer**: verify that failed requests do NOT extend session life, successful ones DO. This is a behavior change from free2api.
- **Quota auto-unpause**: verify that `setTimeout` fires at `resetAt` and flips serve_status.
- **Responses API converter**: verify chat payload shape and round-trip correctness.
- **Image normalization**: verify input formats → standardized output.

### What NOT to test
- Dashboard UI rendering
- File system writes (session persistence)
- Actual upstream network calls (mock upstream client)

### Prior art
- No existing tests in either project. This PRD introduces the first testable deep module (ModelPoolManager).

## Out of Scope

- Global proxy toggle (keeping per-account proxy from freebuff-proxy, skipping free2api's global toggle)
- WebSocket or SSE for live dashboard updates (polling is fine)
- Load balancing across multiple proxy instances
- Metrics / Prometheus export
- Request caching or deduplication
- Billing / credit tracking beyond upstream quota
- Multi-model bindings per account (one account = one model only)

## Further Notes

- The free2api backend features being ported are well-tested in production. The risk is mainly in the integration with freebuff-proxy's per-account proxy system.
- Session persistence (saving instanceId to disk) should be kept — it allows restart without re-queueing.
- The upstream's `rateLimitsByModel` includes limits for ALL models, not just the bound one. The proxy should only care about the bound model's quota.
- Unlimited models (no entry in `rateLimitsByModel` for the bound model) never get auto-paused.
- If a user changes an account's bound model while it's quota-exhausted on the old model, it should become active immediately for the new model (no waiting for old resetAt).
- The idle timer behavior is a **change from free2api**: free2api resets the timer on `acquire()` (before upstream call), meaning failed requests keep the session alive. The new architecture resets only after successful response, so broken sessions die naturally.
