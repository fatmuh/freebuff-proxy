import type { Config, CachedSession, ManagedRun, TokenSnapshot, RunSnapshot } from './types.js'
import { UpstreamClient } from './upstream.js'
import { sleep } from './utils.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

// ─── Constants ─────────────────────────────────────────────────

const SESSION_POLL_INTERVAL = 5_000
const SESSION_RETRY_DELAY = 10_000
const MAX_MODEL_LOCKED_RETRIES = 5
const SESSION_EXPIRY_BUFFER = 5_000

// ─── Persisted Session State ───────────────────────────────────

interface SavedSessionState {
  instanceId: string
  model: string
  expiresAt: string | null
  savedAt: string
}

// ─── RunLease ──────────────────────────────────────────────────

export interface RunLease {
  pool: TokenPool
  run: ManagedRun
  model: string
}

// ─── TokenPool ─────────────────────────────────────────────────

export class TokenPool {
  readonly name: string
  readonly token: string
  readonly sessionModel: string
  readonly upstreamClient: UpstreamClient

  private config: Config
  private log: (...args: unknown[]) => void
  private _runs = new Map<string, ManagedRun>()
  private draining: ManagedRun[] = []
  private stateFile: string  // path to persist session state

  session: CachedSession | null = null
  private sessionRefreshPromise: Promise<string | null> | null = null
  private sessionRebuildScheduled = false

  cooldownUntil: Date | null = null
  lastError = ''
  private _restoredState = false  // have we tried restoring from disk?

  constructor(
    name: string,
    token: string,
    sessionModel: string,
    config: Config,
    upstreamClient: UpstreamClient,
    log: (...args: unknown[]) => void,
    stateFile: string = 'data/session-state.json',
  ) {
    this.name = name
    this.token = token
    this.sessionModel = sessionModel
    this.config = config
    this.upstreamClient = upstreamClient
    this.log = log
    this.stateFile = stateFile
  }

  // ─── Public: Session ──────────────────────────────────────────

  async ensureSession(): Promise<string | null> {
    // If we haven't tried restoring yet, try it
    if (!this._restoredState) {
      this._restoredState = true
      const restored = await this.tryRestoreSession()
      if (restored) return restored
    }

    if (this.session?.status === 'active' && this.session.instanceId) {
      const exp = this.session.expiresAt
      if (!exp || Date.now() < exp.getTime() - SESSION_EXPIRY_BUFFER) {
        return this.session.instanceId
      }
    }

    if (this.session?.status === 'queued') {
      if (this.sessionRefreshPromise) return this.sessionRefreshPromise
      return this.startSessionRefresh()
    }

    return this.startSessionRefresh()
  }

  invalidateSession(reason: string): void {
    this.session = null
    if (reason) this.lastError = reason
    this.scheduleSessionRebuild(reason)
  }

  currentSessionInstanceId(): string {
    return this.session?.instanceId ?? ''
  }

  hasReadySession(): boolean {
    return this.session?.status === 'active' && !!this.session?.instanceId
  }

  isCoolingDown(): boolean {
    return this.cooldownUntil !== null && Date.now() < this.cooldownUntil.getTime()
  }

  // ─── Session Persistence ──────────────────────────────────────
  // Save session state to disk so we can reuse on restart.
  // Sessions live on codebuff's backend for ~1hr. If we restart
  // the proxy within that window, we can skip the queue.

  private async tryRestoreSession(): Promise<string | null> {
    try {
      const raw = await readFile(this.stateFile, 'utf-8')
      const allStates = JSON.parse(raw) as Record<string, SavedSessionState>
      const saved = allStates[this.name]
      if (!saved?.instanceId) return null

      this.log(`${this.name}: found saved session ${saved.instanceId}, checking if still active...`)

      // Ask upstream: is this session still active?
      const state = await this.upstreamClient.getSession(this.token, saved.instanceId)

      if (state.status.trim() === 'active') {
        const expiresAt = state.expiresAt?.trim() ? new Date(state.expiresAt) : null
        this.session = {
          status: 'active',
          instanceId: saved.instanceId,
          model: this.sessionModel,
          expiresAt,
          position: 0, queueDepth: 0, estimatedWaitMs: 0,
        }
        this.lastError = ''
        this.log(`${this.name}: ✅ restored session ${saved.instanceId} (expires ${expiresAt?.toISOString() ?? 'unknown'})`)
        this.watchSessionExpiry(saved.instanceId, expiresAt)
        this.persistSessionState()  // refresh saved timestamp
        return saved.instanceId
      }

      this.log(`${this.name}: saved session ${saved.instanceId} is ${state.status} (not reusable)`)
    } catch (err) {
      this.log(`${this.name}: no saved session to restore`)
    }
    return null
  }

  private async persistSessionState(): Promise<void> {
    try {
      // Read existing file first (other pools may have saved their state)
      let allStates: Record<string, SavedSessionState> = {}
      try {
        const raw = await readFile(this.stateFile, 'utf-8')
        allStates = JSON.parse(raw)
      } catch { /* no file yet */ }

      if (this.session?.status === 'active' && this.session.instanceId) {
        allStates[this.name] = {
          instanceId: this.session.instanceId,
          model: this.sessionModel,
          expiresAt: this.session.expiresAt?.toISOString() ?? null,
          savedAt: new Date().toISOString(),
        }
      } else {
        delete allStates[this.name]
      }

      await mkdir(dirname(this.stateFile), { recursive: true })
      await writeFile(this.stateFile, JSON.stringify(allStates, null, 2))
    } catch (err) {
      this.log(`${this.name}: persist session state failed:`, err)
    }
  }

  async prewarmSession(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      try {
        const id = await this.ensureSession()
        if (id) return
      } catch (err) {
        this.log(`${this.name}: session prewarm failed (${i + 1}/3):`, err)
      }
      await sleep(SESSION_RETRY_DELAY)
    }
  }

  // ─── Public: Runs ─────────────────────────────────────────────

  getRun(agentId: string): ManagedRun | undefined {
    return this._runs.get(agentId)
  }

  async acquire(agentId: string, model: string): Promise<RunLease> {
    if (this.isCoolingDown()) {
      throw new Error(`token cooling down until ${this.cooldownUntil!.toISOString()}`)
    }

    this.log(`${this.name}: ensureSession for model=${model}`)
    const instanceId = await this.ensureSession()
    this.log(`${this.name}: session instanceId=${instanceId ?? 'none'}`)

    let run = this._runs.get(agentId)
    const needsRotate = !run || (Date.now() - run.startedAt.getTime() >= this.config.rotationInterval)

    if (needsRotate) {
      this.log(`${this.name}: rotating run for agent=${agentId}`)
      await this.rotateAgent(agentId)
      run = this._runs.get(agentId)!
    }

    if (!run) throw new Error('run missing after rotation')

    run.inflight++
    run.requestCount++
    return { pool: this, run, model }
  }

  release(run: ManagedRun): void {
    if (run.inflight > 0) run.inflight--
    this.finishIfReady(run).catch(err => {
      this.log(`${this.name}: finish released run ${run.id} failed:`, err)
    })
  }

  invalidate(run: ManagedRun, reason: string): void {
    if (this._runs.get(run.agentId) === run) this._runs.delete(run.agentId)
    this.draining = this.draining.filter(r => r !== run)
    if (reason) this.lastError = reason
  }

  markCooldown(durationMs: number, reason: string): void {
    if (durationMs <= 0) return
    this.cooldownUntil = new Date(Date.now() + durationMs)
    if (reason) this.lastError = reason
  }

  snapshot(): TokenSnapshot {
    const runs: RunSnapshot[] = []
    for (const run of this._runs.values()) {
      runs.push({
        agentId: run.agentId,
        runId: run.id,
        startedAt: run.startedAt.toISOString(),
        inflight: run.inflight,
        requestCount: run.requestCount,
      })
    }
    return {
      name: this.name,
      sessionModel: this.sessionModel,
      runs,
      drainingRuns: this.draining.length,
      sessionStatus: this.session?.status ?? 'none',
      sessionInstanceId: this.session?.instanceId ?? '',
      sessionExpiresAt: this.session?.expiresAt?.toISOString() ?? null,
      sessionPosition: this.session?.position ?? 0,
      sessionQueueDepth: this.session?.queueDepth ?? 0,
      sessionEstWaitMs: this.session?.estimatedWaitMs ?? 0,
      cooldownUntil: this.cooldownUntil?.toISOString() ?? null,
      lastError: this.lastError,
    }
  }

  // ─── Maintenance ──────────────────────────────────────────────

  async maintain(): Promise<void> {
    const toRotate: string[] = []
    for (const [agentId, run] of this._runs) {
      if (Date.now() - run.startedAt.getTime() >= this.config.rotationInterval) {
        toRotate.push(agentId)
      }
    }
    for (const agentId of toRotate) {
      try { await this.rotateAgent(agentId) } catch (err) {
        this.log(`${this.name}: rotate ${agentId} failed:`, err)
      }
    }
    const drainingCopy = [...this.draining]
    for (const run of drainingCopy) await this.finishIfReady(run)
  }

  async shutdown(): Promise<void> {
    // DON'T finish runs or end session on shutdown.
    // Runs expire on their own at codebuff's backend.
    // Sessions expire after ~1hr naturally.
    // Killing them wastes a free session that could be reused on restart.
    this.log(`${this.name}: shutting down (leaving session + runs alive on upstream)`)
    // Persist current session state so we can reuse on restart
    await this.persistSessionState()
    this._runs.clear()
    this.draining = []
  }

  // ─── Private: Session Lifecycle ──────────────────────────────

  private startSessionRefresh(): Promise<string | null> {
    if (this.sessionRefreshPromise) return this.sessionRefreshPromise
    this.sessionRefreshPromise = this.doSessionRefresh()
    const p = this.sessionRefreshPromise
    void p.finally(() => { if (this.sessionRefreshPromise === p) this.sessionRefreshPromise = null })
    return p
  }

  private async doSessionRefresh(): Promise<string | null> {
    const model = this.sessionModel
    try {
      const result = await this.refreshSession(model)
      if (result.status === 'active' && result.instanceId) {
        this.session = {
          status: 'active', instanceId: result.instanceId, model,
          expiresAt: result.expiresAt, position: 0, queueDepth: 0, estimatedWaitMs: 0,
        }
        this.lastError = ''
        this.watchSessionExpiry(result.instanceId, result.expiresAt)
        this.persistSessionState()  // save to disk for restart reuse
        return result.instanceId
      }
      if (result.status === 'queued' && result.instanceId) {
        this.session = {
          status: 'queued', instanceId: result.instanceId, model,
          expiresAt: null, position: result.position,
          queueDepth: result.queueDepth, estimatedWaitMs: result.estimatedWaitMs,
        }
        this.backgroundPollSession(model, result.instanceId)
        return null
      }
      this.session = null
      this.lastError = `unexpected session status: ${result.status}`
      return null
    } catch (err) {
      this.session = null
      this.lastError = String(err)
      this.log(`${this.name}: session refresh failed:`, err)
      return null
    }
  }

  private async refreshSession(model: string): Promise<{
    status: string; instanceId: string; expiresAt: Date | null
    position: number; queueDepth: number; estimatedWaitMs: number
  }> {
    let lockedRetries = 0
    let state = await this.upstreamClient.createSession(this.token, model)

    for (;;) {
      switch (state.status.trim()) {
        case 'disabled':
          return { status: 'disabled', instanceId: '', expiresAt: null, position: 0, queueDepth: 0, estimatedWaitMs: 0 }

        case 'model_locked': {
          lockedRetries++
          if (lockedRetries > MAX_MODEL_LOCKED_RETRIES) {
            throw new Error(`model_locked after ${lockedRetries} retries`)
          }
          this.log(`${this.name}: model_locked, retrying (${lockedRetries}/${MAX_MODEL_LOCKED_RETRIES})`)
          await this.endSessionNow().catch(() => {})
          await sleep(2_000)
          state = await this.upstreamClient.createSession(this.token, model)
          continue
        }

        case 'active': {
          const id = state.instanceId?.trim() ?? ''
          if (!id) throw new Error('session active but missing instanceId')
          const exp = state.expiresAt?.trim() ? new Date(state.expiresAt) : null
          return { status: 'active', instanceId: id, expiresAt: exp, position: 0, queueDepth: 0, estimatedWaitMs: 0 }
        }

        case 'queued': {
          const id = state.instanceId?.trim() ?? ''
          if (!id) throw new Error('session queued but missing instanceId')
          this.session = {
            status: 'queued', instanceId: id, model, expiresAt: null,
            position: state.position ?? 0, queueDepth: state.queueDepth ?? 0,
            estimatedWaitMs: state.estimatedWaitMs ?? 0,
          }
          const delay = smartPollDelay(state.estimatedWaitMs ?? 0)
          this.log(`${this.name}: queued (pos ${state.position}/${state.queueDepth}), polling in ${delay}ms`)
          await sleep(delay)
          state = await this.upstreamClient.getSession(this.token, id)
          continue
        }

        case 'none': case 'ended': case 'superseded':
          state = await this.upstreamClient.createSession(this.token, model)
          continue

        default:
          throw new Error(`unexpected session status: ${state.status}`)
      }
    }
  }

  private backgroundPollSession(model: string, instanceId: string): void {
    const poll = async () => {
      while (true) {
        if (this.session?.instanceId !== instanceId || this.session?.status !== 'queued') return
        const delay = smartPollDelay(this.session?.estimatedWaitMs ?? 0)
        this.log(`${this.name}: bg poll pos=${this.session?.position}/${this.session?.queueDepth}, next ${delay}ms`)
        await sleep(delay)
        try {
          const state = await this.upstreamClient.getSession(this.token, instanceId)
          if (state.status.trim() === 'active') {
            const exp = state.expiresAt?.trim() ? new Date(state.expiresAt) : null
            this.session = { status: 'active', instanceId, model, expiresAt: exp, position: 0, queueDepth: 0, estimatedWaitMs: 0 }
            this.lastError = ''
            this.log(`${this.name}: bg poll → active!`)
            this.watchSessionExpiry(instanceId, exp)
            this.persistSessionState()  // save to disk
            return
          }
          if (state.status.trim() === 'queued') {
            if (this.session?.instanceId === instanceId) {
              this.session.position = state.position ?? 0
              this.session.queueDepth = state.queueDepth ?? 0
              this.session.estimatedWaitMs = state.estimatedWaitMs ?? 0
            }
            continue
          }
          this.session = null
          this.scheduleSessionRebuild(`bg poll got status ${state.status}`)
          return
        } catch (err) {
          this.session = null
          this.scheduleSessionRebuild('bg poll failed')
          return
        }
      }
    }
    void poll()
  }

  private watchSessionExpiry(instanceId: string, expiresAt: Date | null): void {
    if (!instanceId || !expiresAt) return
    const ms = expiresAt.getTime() - Date.now() + 1_000
    if (ms <= 0) { this.scheduleSessionRebuild('expired'); return }
    const watch = async () => {
      await sleep(ms)
      if (this.session?.instanceId !== instanceId || this.session?.status !== 'active') return
      while (this.hasInflightRequests()) await sleep(1_000)
      this.session = null
      this.scheduleSessionRebuild('expired')
    }
    void watch()
  }

  private scheduleSessionRebuild(reason: string): void {
    if (this.sessionRebuildScheduled || this.isCoolingDown()) return
    this.sessionRebuildScheduled = true
    this.log(`${this.name}: rebuilding session (${reason})`)
    void (async () => {
      try { await this.prewarmSession() } finally { this.sessionRebuildScheduled = false }
    })()
  }

  private hasInflightRequests(): boolean {
    for (const r of this._runs.values()) if (r.inflight > 0) return true
    for (const r of this.draining) if (r.inflight > 0) return true
    return false
  }

  private async endSessionNow(): Promise<void> {
    const s = this.session
    this.session = null
    if (!s || s.status === 'disabled' || !s.instanceId) return
    this.log(`${this.name}: ending session (${s.model}/${s.instanceId})`)
    await this.upstreamClient.endSession(this.token)
    this.log(`${this.name}: session ended`)
  }

  // ─── Private: Run Lifecycle ──────────────────────────────────

  private async rotateAgent(agentId: string): Promise<void> {
    if (this.isCoolingDown()) throw new Error(`token cooling down until ${this.cooldownUntil!.toISOString()}`)
    const runId = await this.upstreamClient.startRun(this.token, agentId)
    const oldRun = this._runs.get(agentId)
    this._runs.set(agentId, {
      id: runId, agentId, startedAt: new Date(),
      inflight: 0, requestCount: 0, finishing: false,
    })
    this.lastError = ''
    if (oldRun) {
      this.draining.push(oldRun)
      this.finishIfReady(oldRun).catch(err => {
        this.log(`${this.name}: finish rotated run ${oldRun.id} failed:`, err)
      })
    }
  }

  private async finishIfReady(run: ManagedRun): Promise<void> {
    if (run.inflight > 0 || run.finishing) return
    if (this._runs.get(run.agentId) === run) return
    run.finishing = true
    try {
      await this.upstreamClient.finishRun(this.token, run.id, run.requestCount)
      this.draining = this.draining.filter(r => r !== run)
    } catch (err) {
      run.finishing = false
      this.lastError = String(err)
    }
  }
}

// ─── RunManager ────────────────────────────────────────────────

export class RunManager {
  private pools: TokenPool[]
  private config: Config
  private upstreamClient: UpstreamClient
  private log: (...args: unknown[]) => void
  private maintainTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: Config, upstreamClient: UpstreamClient, log: (...args: unknown[]) => void) {
    this.config = config
    this.upstreamClient = upstreamClient
    this.log = log
    this.pools = config.authTokens.map((token, i) => {
      const model = config.tokenModels[i] ?? 'minimax/minimax-m2.7'
      return new TokenPool(
        `token-${i + 1}`, token, model,
        config, upstreamClient, log,
      )
    })
  }

  async start(agentIds: string[]): Promise<void> {
    const prewarmPromises = this.pools.map(async pool => {
      await pool.prewarmSession()
      for (const agentId of agentIds) {
        try {
          await pool.acquire(agentId, 'prewarm')
          const run = pool.getRun(agentId)
          if (run) pool.release(run)
        } catch (err) {
          this.log(`${pool.name}: prewarm ${agentId} failed:`, err)
        }
      }
    })
    await Promise.allSettled(prewarmPromises)

    this.maintainTimer = setInterval(() => {
      for (const pool of this.pools) {
        pool.maintain().catch(err => this.log(`${pool.name}: maintain failed:`, err))
      }
    }, 60_000)
  }

  async close(): Promise<void> {
    if (this.maintainTimer) { clearInterval(this.maintainTimer); this.maintainTimer = null }
    const results = await Promise.allSettled(this.pools.map(p => p.shutdown()))
    for (const r of results) if (r.status === 'rejected') this.log('shutdown error:', r.reason)
  }

  async acquire(primaryModel: string, agentId: string, model: string): Promise<RunLease> {
    if (!this.pools.length) throw new Error('no auth tokens configured')
    const matching = this.pools.filter(p => p.sessionModel === primaryModel)
    const candidates = matching.length > 0 ? matching : this.pools
    const sorted = [...candidates].sort((a, b) => {
      if (a.hasReadySession() !== b.hasReadySession()) return a.hasReadySession() ? -1 : 1
      if (a.isCoolingDown() !== b.isCoolingDown()) return a.isCoolingDown() ? 1 : -1
      return 0
    })
    const errors: string[] = []
    for (const pool of sorted) {
      try { return await pool.acquire(agentId, model) }
      catch (err) { errors.push(`${pool.name}: ${err}`) }
    }
    throw new Error('unable to acquire run (' + errors.join('; ') + ')')
  }

  release(lease: RunLease | null): void {
    if (lease?.pool && lease.run) lease.pool.release(lease.run)
  }

  invalidate(lease: RunLease, reason: string): void {
    if (lease?.pool && lease.run) lease.pool.invalidate(lease.run, reason)
  }

  cooldown(lease: RunLease, durationMs: number, reason: string): void {
    if (lease?.pool) lease.pool.markCooldown(durationMs, reason)
  }

  snapshots(): TokenSnapshot[] {
    return this.pools.map(p => p.snapshot())
  }

  getPools(): TokenPool[] {
    return this.pools
  }
}

function smartPollDelay(estimatedWaitMs: number): number {
  if (estimatedWaitMs <= 0) return SESSION_POLL_INTERVAL
  return Math.max(SESSION_POLL_INTERVAL, Math.min(60_000, estimatedWaitMs / 20))
}
