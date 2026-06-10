## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

Add `SESSION_IDLE_TIMEOUT` config (default `10m`). 

**Port from free2api** (`~/proj/free2api/src/run-manager.ts:349-378`):
- Copy `clearIdleTimer()` and `resetIdleTimer()` methods into freebuff-proxy's TokenPool class
- freebuff-proxy currently lacks these methods entirely

**Port from free2api** (`~/proj/free2api/src/config.ts:40`):
- Add `SESSION_IDLE_TIMEOUT='10m'` env var parsing to freebuff-proxy's config loader

**Behavior change from free2api:**
- In free2api, `resetIdleTimer()` is called inside `pool.acquire()` — **before** the upstream call (run-manager.ts:238)
- **In the new architecture, timer resets ONLY after a successful 2xx response**, not on acquire
- This requires the caller (chat route) to signal success back to the pool after receiving the upstream response
- Failed requests will NOT reset the timer, so broken sessions die naturally

After the timeout expires, end the session and set `account_status` to `idle`.

Keep existing session persistence to disk so that restart reuses the upstream session instance ID if still valid.

## Acceptance criteria

- [ ] `SESSION_IDLE_TIMEOUT` env var parsed as duration (default `10m`) — port from `~/proj/free2api/src/config.ts:40`
- [ ] `resetIdleTimer()` exists — port from `~/proj/free2api/src/run-manager.ts:359`
- [ ] `clearIdleTimer()` cancels the timeout — port from `~/proj/free2api/src/run-manager.ts:349`
- [ ] Timer only resets after upstream returns 2xx, not on acquire (behavior change from free2api)
- [ ] After timeout: session ends, `account_status` becomes `idle`
- [ ] Session persistence to disk still works (instanceId saved on active, checked on restore)
- [ ] Unit test: session dies after 10 min idle, survives on successful requests, does NOT survive on failed requests

## Blocked by

None - can start immediately

## Files to modify

- `~/proj/freebuff-proxy/src/config.ts` (add SESSION_IDLE_TIMEOUT parsing)
- `~/proj/freebuff-proxy/src/types.ts` (add sessionIdleTimeout to Config interface)
- `~/proj/freebuff-proxy/src/run-manager.ts` (add idle timer methods to TokenPool)

## Source reference
- `~/proj/free2api/src/config.ts:40`
- `~/proj/free2api/src/types.ts:48`
- `~/proj/free2api/src/run-manager.ts:349-378`
