## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

Update dashboard status endpoints. Port from free2api where noted.

### 1. `/api/status` — per-model active session counts

Replace single `active_account` string with per-model breakdown:
```json
{"kimi-k2.6": 2, "deepseek-v4-pro": 1}
```

Shape change: was `{active_account: string, active_accounts: number}` — new shape is `{[model: string]: number}`.

Source for per-model data: iterate model groups from `ModelPoolManager` and count `account_status === 'active'` per model.

### 2. `/api/models` — admin model list

**Port from free2api** (`~/proj/free2api/src/routes/models.ts:4-8`):
```typescript
export function handleModelsList(registry: ModelRegistry) {
  return (c: Context) => c.json({ models: registry.models() })
}
```

freebuff-proxy currently only has `/v1/models` (OpenAI-compatible `handleModels()`). Add `/api/models` as a new admin endpoint returning raw model/agent IDs.

### 3. `/api/accounts/usage` — per-account detailed view

**Port from free2api** (`~/proj/free2api/src/routes/accounts.ts:221-263`):
- `serve_status`, `account_status`
- `rate_limit` and `rate_limits_by_model` from upstream
- `quota_reset_at` countdown
- `total_sessions` count (from TokenPool.sessionCount)
- `local_usage`: requests, tokens_in, tokens_out

Update dashboard frontend to consume these new shapes.

## Acceptance criteria

- [ ] `/api/status` returns per-model active session counts
- [ ] `/api/models` returns all models with agent mappings — port from `~/proj/free2api/src/routes/models.ts:4-8`
- [ ] `/api/accounts/usage` returns full per-account data — port from `~/proj/free2api/src/routes/accounts.ts:221-263`
- [ ] Dashboard shows per-model session counts on status page
- [ ] Dashboard shows reset countdown on account page
- [ ] Dashboard shows two status columns (serve + account)

## Blocked by

- [01-auth-store-schema](../issues/01-auth-store-schema.md) — needs account status fields
- [06-responses-api](../issues/06-responses-api.md) — responses endpoint should be live for full status
- [07-rate-limit-auto-pause](../issues/07-rate-limit-auto-pause.md) — needs rate limit data

## Files to modify

- `~/proj/freebuff-proxy/src/routes/models.ts` — add `handleModelsList()` (port from `~/proj/free2api/src/routes/models.ts:4-8`)
- `~/proj/freebuff-proxy/src/routes/accounts.ts` — add `handleAccountUsage()` (port from `~/proj/free2api/src/routes/accounts.ts:221-263`)
- `~/proj/freebuff-proxy/src/server.ts` — register new routes

## Source references
- `~/proj/free2api/src/routes/models.ts:4-8` (handleModelsList)
- `~/proj/free2api/src/routes/accounts.ts:221-263` (handleAccountUsage)
- `~/proj/freebuff-proxy/src/routes/models.ts` (existing handleModels for /v1/models)
