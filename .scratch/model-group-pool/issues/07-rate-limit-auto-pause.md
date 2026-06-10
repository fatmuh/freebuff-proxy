## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

Port rate limit tracking from free2api and add auto-pause/unpause logic.

### 1. Track rate limits

Port `captureUsageData()` from `~/proj/free2api/src/run-manager.ts:207-213`:
```typescript
captureUsageData(resp: { rateLimit?: SessionRateLimit; rateLimitsByModel?: RateLimitsByModel }): void {
  if (resp.rateLimit) this.rateLimit = resp.rateLimit
  if (resp.rateLimitsByModel) this.rateLimitsByModel = resp.rateLimitsByModel
}
```

Call it in these places in freebuff-proxy's TokenPool (porting from free2api locations):
- `tryRestoreSession()` — after confirming session is active (free2api: run-manager.ts:162)
- `doSessionRefresh()` — after session becomes active (free2api: run-manager.ts:401)
- `doSessionRefresh()` — after session is queued (free2api: run-manager.ts:414)
- `backgroundPollSession()` — when queued session becomes active (free2api: run-manager.ts:504)

### 2. Detect quota exhaustion

Check `recentCount >= limit` for the account's bound model in `rateLimitsByModel`. 

When exhausted:
- Set `serve_status` to `inactive`
- Set `quota_reset_at` to upstream `resetAt` timestamp
- Schedule one-shot `setTimeout` at `resetAt` → auto-unpause

### 3. Unlimited models

Models with no entry in `rateLimitsByModel` for the bound model never get auto-paused.

### 4. Manual pause override

User manually paused accounts stay paused regardless of quota state. Manual unpausing clears any auto-pause.

## Acceptance criteria

- [ ] `captureUsageData()` ported from `~/proj/free2api/src/run-manager.ts:207-213`
- [ ] Called in session restore, refresh, and background poll (port from free2api: run-manager.ts:162,401,414,504)
- [ ] Quota exhaustion detected: `recentCount >= limit` for bound model
- [ ] On exhaustion: `serve_status` → `inactive`, `quota_reset_at` set
- [ ] One-shot timer fires at `resetAt` → `serve_status` → `active`
- [ ] Unlimited models (no rate limit entry) never auto-paused
- [ ] Manual pause takes precedence over auto-unpause
- [ ] Dashboard shows reset countdown per account

## Blocked by

- [01-auth-store-schema](../issues/01-auth-store-schema.md) — needs `serve_status` field

## Files to modify

- `~/proj/freebuff-proxy/src/run-manager.ts` — add `captureUsageData()`, quota detection, auto-pause logic
- `~/proj/freebuff-proxy/src/types.ts` — add `SessionRateLimit`, `RateLimitsByModel` types (port from `~/proj/free2api/src/types.ts:61-71`)

## Source references
- `~/proj/free2api/src/run-manager.ts:207-213` (captureUsageData)
- `~/proj/free2api/src/run-manager.ts:162` (call in tryRestoreSession)
- `~/proj/free2api/src/run-manager.ts:401` (call in doSessionRefresh active path)
- `~/proj/free2api/src/run-manager.ts:414` (call in doSessionRefresh queued path)
- `~/proj/free2api/src/run-manager.ts:504` (call in backgroundPollSession)
- `~/proj/free2api/src/types.ts:61-71` (SessionRateLimit types)
- `~/proj/free2api/src/routes/accounts.ts:256-257` (rate limit response format example)
