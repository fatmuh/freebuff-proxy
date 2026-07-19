import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelPoolManager } from '../model-pool-manager.js'
import type { Account } from '../auth-store.js'
import type { TokenPool, RunLease } from '../run-manager.js'
import type { Config } from '../types.js'

function makeAccount(id: string, model: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    name: id,
    email: `${id}@test.com`,
    user_id: 'u1',
    token: `tok-${id}`,
    auth_token: `auth-${id}`,
    session_model: model,
    proxy_id: '',
    added_at: new Date().toISOString(),
    paused: false,
    serve_status: 'active',
    account_status: 'idle',
    ...overrides,
  }
}

function makePool(overrides: Partial<TokenPool> = {}): TokenPool {
  return {
    name: 'test-pool',
    token: 'tok',
    sessionModel: 'model-a',
    proxyId: '',
    session: null,
    cooldownUntil: null,
    lastError: '',
    rateLimit: null,
    rateLimitsByModel: null,
    quotaResetAt: null,
    acquire: vi.fn(),
    release: vi.fn(),
    invalidate: vi.fn(),
    markCooldown: vi.fn(),
    isCoolingDown: vi.fn(() => false),
    isPaused: vi.fn(() => false),
    isAutoPaused: vi.fn(() => false),
    isBanned: vi.fn(() => false),
    banReasonText: vi.fn(() => ''),
    markBanned: vi.fn(),
    clearBan: vi.fn(),
    hasReadySession: vi.fn(() => false),
    ensureSession: vi.fn(),
    signalSuccess: vi.fn(),
    invalidateSession: vi.fn(),
    endSessionNow: vi.fn(),
    setPaused: vi.fn(),
    snapshot: vi.fn(),
    maintain: vi.fn(),
    shutdown: vi.fn(),
    prewarmSession: vi.fn(),
    getRun: vi.fn(),
    currentSessionInstanceId: vi.fn(() => ''),
    ...overrides,
  } as unknown as TokenPool
}

function makeLease(pool: TokenPool): RunLease {
  return {
    pool,
    run: { id: 'run-1', agentId: 'agent-1', startedAt: new Date(), inflight: 1, requestCount: 1, finishing: false },
    model: 'model-a',
  }
}

const mockConfig = {} as Config
const mockClient = {} as any
const noopLog = () => {}

describe('ModelPoolManager', () => {
  let mgr: ModelPoolManager

  beforeEach(() => {
    mgr = new ModelPoolManager(mockConfig, mockClient, noopLog)
  })

  describe('selectAccount — all hot', () => {
    it('picks the hot account with least inflight', async () => {
      const pool1 = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })
      const pool2 = makePool({ session: { status: 'active', instanceId: 'i2', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, pool1)
      mgr.addPool(acct2, pool2)

      // Simulate pool1 having 2 inflight, pool2 having 0
      ;(mgr as any).inflight.set(pool1, 2)
      ;(mgr as any).inflight.set(pool2, 0)

      const lease = makeLease(pool2)
      vi.mocked(pool2.acquire).mockResolvedValue(lease)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBe(lease)
      expect(pool2.acquire).toHaveBeenCalled()
      expect(pool1.acquire).not.toHaveBeenCalled()
    })
  })

  describe('selectAccount — mix hot/idle', () => {
    it('prefers hot account over idle', async () => {
      const hotPool = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })
      const idlePool = makePool({ session: null })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, hotPool)
      mgr.addPool(acct2, idlePool)

      const lease = makeLease(hotPool)
      vi.mocked(hotPool.acquire).mockResolvedValue(lease)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBe(lease)
      expect(hotPool.acquire).toHaveBeenCalled()
      expect(idlePool.acquire).not.toHaveBeenCalled()
    })
  })

  describe('selectAccount — all unavailable', () => {
    it('returns null when all accounts are inactive', async () => {
      const pool1 = makePool()
      const pool2 = makePool()

      const acct1 = makeAccount('a1', 'model-a', { serve_status: 'inactive' })
      const acct2 = makeAccount('a2', 'model-a', { serve_status: 'inactive' })

      mgr.addPool(acct1, pool1)
      mgr.addPool(acct2, pool2)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBeNull()
      expect(pool1.acquire).not.toHaveBeenCalled()
      expect(pool2.acquire).not.toHaveBeenCalled()
    })

    it('returns null when no pools exist for model', async () => {
      const result = await mgr.acquire('nonexistent', 'agent-1', 'nonexistent')
      expect(result.lease).toBeNull()
      expect(result.reason).toContain('no accounts configured')
    })
  })

  describe('selectAccount — cooldown', () => {
    it('skips accounts on cooldown', async () => {
      const coolingPool = makePool({ isCoolingDown: vi.fn(() => true) })
      const okPool = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, coolingPool)
      mgr.addPool(acct2, okPool)

      const lease = makeLease(okPool)
      vi.mocked(okPool.acquire).mockResolvedValue(lease)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBe(lease)
      expect(coolingPool.acquire).not.toHaveBeenCalled()
      expect(okPool.acquire).toHaveBeenCalled()
    })
  })

  describe('selectAccount — paused accounts', () => {
    it('skips paused accounts', async () => {
      const pausedPool = makePool()
      const okPool = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })

      const acct1 = makeAccount('a1', 'model-a', { paused: true })
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, pausedPool)
      mgr.addPool(acct2, okPool)

      const lease = makeLease(okPool)
      vi.mocked(okPool.acquire).mockResolvedValue(lease)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBe(lease)
      expect(pausedPool.acquire).not.toHaveBeenCalled()
    })
  })

  describe('failover — retries then moves to next', () => {
    it('retries on same account up to 3 times, then moves to next', async () => {
      const failPool = makePool({ session: { status: 'active', instanceId: 'i-fail', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })
      const okPool = makePool({ session: { status: 'active', instanceId: 'i-ok', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, failPool)
      mgr.addPool(acct2, okPool)

      // failPool fails 3 times, okPool succeeds
      vi.mocked(failPool.acquire).mockRejectedValue(new Error('session failed'))
      const lease = makeLease(okPool)
      vi.mocked(okPool.acquire).mockResolvedValue(lease)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBe(lease)
      expect(failPool.acquire).toHaveBeenCalledTimes(3)
      expect(okPool.acquire).toHaveBeenCalledTimes(1)
    })

    it('returns null if all accounts fail all retries', async () => {
      const pool1 = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })
      const pool2 = makePool({ session: { status: 'active', instanceId: 'i2', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, pool1)
      mgr.addPool(acct2, pool2)

      vi.mocked(pool1.acquire).mockRejectedValue(new Error('fail'))
      vi.mocked(pool2.acquire).mockRejectedValue(new Error('fail'))

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBeNull()
      expect(pool1.acquire).toHaveBeenCalledTimes(3)
      expect(pool2.acquire).toHaveBeenCalledTimes(3)
    })

    it('stops retrying account when it goes on cooldown mid-retry', async () => {
      const pool = makePool({
        session: null,
        isCoolingDown: vi.fn(() => false),
      })

      const acct = makeAccount('a1', 'model-a')
      mgr.addPool(acct, pool)

      // First attempt fails and puts pool on cooldown
      vi.mocked(pool.acquire).mockRejectedValueOnce(new Error('auth rejected'))
      // After first failure, pool goes on cooldown
      vi.mocked(pool.isCoolingDown).mockReturnValueOnce(false).mockReturnValue(true)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      // Should stop after 1 attempt (cooldown detected before retry 2)
      expect(pool.acquire).toHaveBeenCalledTimes(1)
      expect(result.lease).toBeNull()
    })
  })

  describe('release / invalidate / cooldown', () => {
    it('delegates release to pool and decrements inflight', () => {
      const pool = makePool()
      const lease = makeLease(pool)
      ;(mgr as any).inflight.set(pool, 3)

      mgr.release(lease)
      expect((mgr as any).inflight.get(pool)).toBe(2)
      expect(pool.release).toHaveBeenCalledWith(lease.run)
    })

    it('delegates invalidate to pool', () => {
      const pool = makePool()
      const lease = makeLease(pool)

      mgr.invalidate(lease, 'bad run')
      expect(pool.invalidate).toHaveBeenCalledWith(lease.run, 'bad run')
    })

    it('delegates cooldown to pool', () => {
      const pool = makePool()
      const lease = makeLease(pool)

      mgr.cooldown(lease, 60_000, 'auth rejected')
      expect(pool.markCooldown).toHaveBeenCalledWith(60_000, 'auth rejected')
    })
  })

  describe('addPool / removePool', () => {
    it('adds pool to model group', () => {
      const pool = makePool()
      const acct = makeAccount('a1', 'model-a')
      mgr.addPool(acct, pool)
      expect(mgr.getPoolCount()).toBe(1)
      expect(mgr.getModels()).toEqual(['model-a'])
    })

    it('replaces existing pool for same account id', () => {
      const pool1 = makePool()
      const pool2 = makePool()
      const acct = makeAccount('a1', 'model-a')

      mgr.addPool(acct, pool1)
      mgr.addPool(acct, pool2)
      expect(mgr.getPoolCount()).toBe(1)
    })

    it('removes pool by account id', () => {
      const pool = makePool()
      const acct = makeAccount('a1', 'model-a')
      mgr.addPool(acct, pool)

      const removed = mgr.removePool('a1')
      expect(removed).toBe(true)
      expect(mgr.getPoolCount()).toBe(0)
      expect(mgr.getModels()).toEqual([])
    })

    it('returns false when removing nonexistent account', () => {
      expect(mgr.removePool('nonexistent')).toBe(false)
    })

    it('pools with different models are separate groups', () => {
      const poolA = makePool()
      const poolB = makePool()
      const acctA = makeAccount('a1', 'model-a')
      const acctB = makeAccount('a2', 'model-b')

      mgr.addPool(acctA, poolA)
      mgr.addPool(acctB, poolB)

      expect(mgr.getPoolCount()).toBe(2)
      expect(mgr.getModels().sort()).toEqual(['model-a', 'model-b'])
    })
  })

  describe('inflight tracking', () => {
    it('increments inflight on acquire success', async () => {
      const pool = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })
      const acct = makeAccount('a1', 'model-a')
      mgr.addPool(acct, pool)

      const lease = makeLease(pool)
      vi.mocked(pool.acquire).mockResolvedValue(lease)

      await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect((mgr as any).inflight.get(pool)).toBe(1)
    })

    it('does not increment inflight on acquire failure', async () => {
      const pool = makePool({ session: null })
      const acct = makeAccount('a1', 'model-a')
      mgr.addPool(acct, pool)

      vi.mocked(pool.acquire).mockRejectedValue(new Error('fail'))

      await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect((mgr as any).inflight.get(pool)).toBe(0)
    })
  })

  describe('quota-exhausted accounts', () => {
    it('skips quota-paused accounts', async () => {
      const quotaPaused = makePool({ isPaused: vi.fn(() => true) })
      const okPool = makePool({ session: { status: 'active', instanceId: 'i1', model: 'model-a', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 } })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, quotaPaused)
      mgr.addPool(acct2, okPool)

      const lease = makeLease(okPool)
      vi.mocked(okPool.acquire).mockResolvedValue(lease)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBe(lease)
      expect(quotaPaused.acquire).not.toHaveBeenCalled()
      expect(okPool.acquire).toHaveBeenCalled()
    })

    it('returns null when all accounts are quota-paused', async () => {
      const pool1 = makePool({ isPaused: vi.fn(() => true) })
      const pool2 = makePool({ isPaused: vi.fn(() => true) })

      const acct1 = makeAccount('a1', 'model-a')
      const acct2 = makeAccount('a2', 'model-a')

      mgr.addPool(acct1, pool1)
      mgr.addPool(acct2, pool2)

      const result = await mgr.acquire('model-a', 'agent-1', 'model-a')
      expect(result.lease).toBeNull()
    })
  })

  describe('getAccountRateInfo', () => {
    it('returns rate limit info for all pools', () => {
      const pool1 = makePool({
        rateLimit: { model: 'model-a', limit: 100, period: 'pacific_day', resetTimeZone: 'US/Pacific', resetAt: '2026-06-11T00:00:00Z', windowHours: 24, recentCount: 50 },
        rateLimitsByModel: { 'model-a': { model: 'model-a', limit: 100, period: 'pacific_day', resetTimeZone: 'US/Pacific', resetAt: '2026-06-11T00:00:00Z', windowHours: 24, recentCount: 50 } },
        quotaResetAt: null,
      })
      const acct1 = makeAccount('a1', 'model-a')
      mgr.addPool(acct1, pool1)

      const info = mgr.getAccountRateInfo()
      expect(info).toHaveLength(1)
      expect(info[0].accountId).toBe('a1')
      expect(info[0].rateLimit?.recentCount).toBe(50)
      expect(info[0].rateLimitsByModel?.['model-a']?.limit).toBe(100)
    })

    it('returns null quotaResetAt when no quota exhaustion', () => {
      const pool1 = makePool({ quotaResetAt: null })
      const acct1 = makeAccount('a1', 'model-a')
      mgr.addPool(acct1, pool1)

      const info = mgr.getAccountRateInfo()
      expect(info[0].quotaResetAt).toBeNull()
    })
  })
})
