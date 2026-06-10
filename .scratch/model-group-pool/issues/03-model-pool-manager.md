## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

New deep module `ModelPoolManager` that encapsulates all model group selection logic. It maintains a map of model → account pools.

When a request for a model arrives:
1. Look up the model group
2. Filter out `serve_status: inactive` and accounts on cooldown
3. Prefer hot accounts (`account_status: active`) — pick least `inflight`, then least recently used
4. If no hot accounts, pick an idle account and create a session synchronously (blocks request until active)
5. On failure: retry up to 3 times on same account, then failover to next in group

Replaces free2api's single-active-account pattern:
- `~/proj/free2api/src/run-manager.ts:652-669` — `setActivePool()` ends sessions on other pools. New arch does NOT do this.
- `~/proj/free2api/src/run-manager.ts:657` — `activateNextPool()` with `requiredModel`. New arch filters by model group instead.
- `~/proj/free2api/src/run-manager.ts:722-731` — `acquire()` goes to single active pool. New arch selects from model group.

Each account pool routes upstream calls through its own per-account proxy dispatcher:
- `~/proj/freebuff-proxy/src/upstream.ts:96` — `startRun(authToken, agentId, proxyId?)`
- `~/proj/freebuff-proxy/src/upstream.ts:125` — `chatCompletions(authToken, body, proxyId?)`
- `~/proj/freebuff-proxy/src/upstream.ts:144` — `createSession(authToken, model, proxyId?)`

## Selection algorithm

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
    return idle[0] // will create session synchronously
  }
  return null
}
```

## Acceptance criteria

- [ ] `ModelPoolManager` module exists with testable interface
- [ ] Selection prefers hot sessions over idle
- [ ] Least-inflight tie-breaker for hot accounts
- [ ] Idle accounts trigger synchronous session creation
- [ ] 3 retries per account before moving to next in group
- [ ] Per-account proxy dispatcher used on upstream calls
- [ ] Unit tests cover: all hot, mix hot/idle, all unavailable, cooldown, quota exhausted, failover

## Blocked by

- [02-token-pool-idle-timeout](../issues/02-token-pool-idle-timeout.md) — needs idle/active session states

## Files to create

- `~/proj/freebuff-proxy/src/model-pool-manager.ts` (NEW)

## Files to modify

- `~/proj/freebuff-proxy/src/run-manager.ts` (adapt TokenPool for model group usage)
- `~/proj/freebuff-proxy/src/server.ts` (wire ModelPoolManager into routes)

## Source reference
- `~/proj/free2api/src/run-manager.ts:652-669` (what NOT to do: end other sessions)
- `~/proj/free2api/src/run-manager.ts:722-731` (acquire pattern to replace)
