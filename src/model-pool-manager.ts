import type { Account, ServeStatus } from './auth-store.js'
import type { RunLease, TokenPool } from './run-manager.js'
import type { Config } from './types.js'
import { UpstreamClient } from './upstream.js'

// ─── Account Pool ──────────────────────────────────────────────
// Wraps a TokenPool with model-group selection metadata.

export interface AccountPool {
  account: Account
  pool: TokenPool
}

/** Result of ModelPoolManager.acquire — always includes a loggable reason on failure. */
export interface AcquireResult {
  lease: RunLease | null
  /** Empty when lease is set; otherwise the real failure detail for request logs. */
  reason: string
}

// ─── Model Pool Manager ────────────────────────────────────────
// Manages per-model account groups. Each model maps to a list of
// AccountPools. Selection prefers hot sessions (active, least inflight)
// over idle accounts. Idle accounts trigger synchronous session creation
// via pool.ensureSession() inside pool.acquire().

export class ModelPoolManager {
  private modelPools = new Map<string, AccountPool[]>()
  private inflight = new Map<TokenPool, number>()
  private lastUsedAt = new Map<TokenPool, number>()
  private log: (...args: unknown[]) => void
  private config: Config
  private upstreamClient: UpstreamClient

  constructor(
    config: Config,
    upstreamClient: UpstreamClient,
    log: (...args: unknown[]) => void,
  ) {
    this.config = config
    this.upstreamClient = upstreamClient
    this.log = log
  }

  // ─── Pool Lifecycle ──────────────────────────────────────────

  addPool(account: Account, pool: TokenPool): void {
    const model = account.session_model
    let pools = this.modelPools.get(model)
    if (!pools) {
      pools = []
      this.modelPools.set(model, pools)
    }
    // Remove existing entry for same account id (replace)
    const existing = pools.findIndex(p => p.account.id === account.id)
    if (existing !== -1) {
      pools.splice(existing, 1)
    }
    pools.push({ account, pool })
    this.inflight.set(pool, 0)
    this.log(`model-pool-manager: added pool ${account.id} for model ${model}`)
  }

  removePool(accountId: string): boolean {
    for (const [model, pools] of this.modelPools) {
      const idx = pools.findIndex(p => p.account.id === accountId)
      if (idx !== -1) {
        const removed = pools.splice(idx, 1)[0]
        this.inflight.delete(removed.pool)
        this.lastUsedAt.delete(removed.pool)
        if (pools.length === 0) this.modelPools.delete(model)
        this.log(`model-pool-manager: removed pool ${accountId} from model ${model}`)
        return true
      }
    }
    return false
  }

  getModels(): string[] {
    return [...this.modelPools.keys()]
  }

  getPoolCount(): number {
    let count = 0
    for (const pools of this.modelPools.values()) count += pools.length
    return count
  }

  // ─── Acquire ─────────────────────────────────────────────────
  // Selects the best account for the model and acquires a run lease.
  // Retries up to 3 times on the same account before moving to the next.
  // On total failure, reason holds the real cause (not a generic placeholder).

  async acquire(
    model: string,
    agentId: string,
    requestedModel: string,
    excludePoolNames?: Set<string>,
  ): Promise<AcquireResult> {
    const pools = this.modelPools.get(model)
    if (!pools?.length) {
      const reason = `no accounts configured for model ${model}`
      this.log(`model-pool-manager: ${reason}`)
      return { lease: null, reason }
    }

    const MAX_RETRIES_PER_ACCOUNT = 3
    // Exclude pools that already failed for this request (switch account on retry)
    const candidates = excludePoolNames && excludePoolNames.size > 0
      ? this.selectOrder(pools).filter(ap => !excludePoolNames.has(ap.pool.name))
      : this.selectOrder(pools)
    const ordered = candidates
    const errors: string[] = []

    if (ordered.length === 0) {
      const skipped = pools.map(ap => {
        const bits: string[] = [ap.account.id]
        if (ap.account.serve_status !== 'active') bits.push(`serve=${ap.account.serve_status}`)
        if (ap.account.paused) bits.push('manual-paused')
        if (ap.pool.isAutoPaused()) bits.push('auto-paused-quota')
        if (ap.pool.isPaused() && !ap.account.paused && !ap.pool.isAutoPaused()) bits.push('paused')
        if (ap.pool.isCoolingDown()) bits.push(`cooldown-until=${ap.pool.cooldownUntil?.toISOString() ?? '?'}`)
        if (excludePoolNames?.has(ap.pool.name)) bits.push('excluded-this-request')
        if (ap.pool.lastError) bits.push(`lastError=${ap.pool.lastError.slice(0, 200)}`)
        return bits.join(' ')
      })
      const reason = `no healthy accounts for model ${model}: ${skipped.join(' | ') || 'none'}`
      this.log(`model-pool-manager: ${reason}`)
      return { lease: null, reason }
    }

    for (const ap of ordered) {
      for (let attempt = 0; attempt < MAX_RETRIES_PER_ACCOUNT; attempt++) {
        try {
          const lease = await ap.pool.acquire(agentId, requestedModel)
          this.inflight.set(ap.pool, (this.inflight.get(ap.pool) ?? 0) + 1)
          this.lastUsedAt.set(ap.pool, Date.now())
          return { lease, reason: '' }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          const msg = `${ap.account.id} (attempt ${attempt + 1}): ${detail}`
          this.log(`model-pool-manager: acquire failed — ${msg}`)
          errors.push(msg)

          // Cooldown → skip remaining retries on this account
          if (ap.pool.isCoolingDown()) break

          // Refresh session on session/run errors so next attempt gets a fresh one
          if (ap.pool.session?.status === 'active' || ap.pool.session?.status === 'queued') {
            ap.pool.invalidateSession(detail)
          }
        }
      }
    }

    const reason = `all pools exhausted for ${model}: ${errors.join('; ') || 'unknown'}`
    this.log(`model-pool-manager: ${reason}`)
    return { lease: null, reason }
  }

  // ─── Release / Invalidate / Cooldown ─────────────────────────

  release(lease: RunLease): void {
    const count = this.inflight.get(lease.pool) ?? 0
    if (count > 0) this.inflight.set(lease.pool, count - 1)
    lease.pool.release(lease.run)
  }

  invalidate(lease: RunLease, reason: string): void {
    lease.pool.invalidate(lease.run, reason)
  }

  cooldown(lease: RunLease, durationMs: number, reason: string): void {
    lease.pool.markCooldown(durationMs, reason)
  }

  // ─── Selection Algorithm ─────────────────────────────────────
  // Returns AccountPools sorted by preference:
  //   1. Healthy pools only (active serve_status, not on cooldown)
  //   2. Hot (has active session) before idle (no session)
  //   3. Among hot: least inflight, then least recently used

  private selectOrder(pools: AccountPool[]): AccountPool[] {
    const healthy = pools.filter(p => this.isHealthy(p))
    if (healthy.length === 0) return []

    const hot: AccountPool[] = []
    const idle: AccountPool[] = []

    for (const ap of healthy) {
      const status = this.accountStatus(ap)
      if (status === 'active') hot.push(ap)
      else idle.push(ap)
    }

    hot.sort((a, b) => {
      const aInflight = this.inflight.get(a.pool) ?? 0
      const bInflight = this.inflight.get(b.pool) ?? 0
      if (aInflight !== bInflight) return aInflight - bInflight
      const aUsed = this.lastUsedAt.get(a.pool) ?? 0
      const bUsed = this.lastUsedAt.get(b.pool) ?? 0
      return aUsed - bUsed
    })

    return [...hot, ...idle]
  }

  private isHealthy(ap: AccountPool): boolean {
    if (ap.account.serve_status !== 'active') return false
    if (ap.pool.isCoolingDown()) return false
    if (ap.account.paused) return false
    if (ap.pool.isPaused()) return false  // quota-exhausted auto-pause
    return true
  }

  private accountStatus(ap: AccountPool): 'idle' | 'active' | 'queued' {
    const s = ap.pool.session
    if (!s) return 'idle'
    if (s.status === 'active') return 'active'
    if (s.status === 'queued') return 'queued'
    return 'idle'
  }

  // ─── Rate Limit Info (for dashboard) ──────────────────────────

  getAccountRateInfo(): Array<{
    accountId: string
    model: string
    rateLimit: import('./types.js').SessionRateLimit | null
    rateLimitsByModel: import('./types.js').RateLimitsByModel | null
    quotaResetAt: string | null
  }> {
    const result: Array<{
      accountId: string
      model: string
      rateLimit: import('./types.js').SessionRateLimit | null
      rateLimitsByModel: import('./types.js').RateLimitsByModel | null
      quotaResetAt: string | null
    }> = []
    for (const pools of this.modelPools.values()) {
      for (const ap of pools) {
        result.push({
          accountId: ap.account.id,
          model: ap.pool.sessionModel,
          rateLimit: ap.pool.rateLimit,
          rateLimitsByModel: ap.pool.rateLimitsByModel,
          quotaResetAt: ap.pool.quotaResetAt?.toISOString() ?? null,
        })
      }
    }
    return result
  }

  // ─── Maintenance ─────────────────────────────────────────────

  async maintain(): Promise<void> {
    for (const pools of this.modelPools.values()) {
      for (const ap of pools) {
        try {
          await ap.pool.maintain()
        } catch (err) {
          this.log(`model-pool-manager: maintain ${ap.account.id} failed:`, err)
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const pools of this.modelPools.values()) {
      for (const ap of pools) promises.push(ap.pool.shutdown())
    }
    await Promise.allSettled(promises)
  }
}
