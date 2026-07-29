import type { Config, CachedSession, ManagedRun, TokenSnapshot, RunSnapshot, SessionRateLimit, RateLimitsByModel } from './types.js'
import { UpstreamClient } from './upstream.js'
import type { AdsSpoof } from './ads-spoof.js'
import { sleep } from './utils.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'

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
  sessionModel: string
  readonly upstreamClient: UpstreamClient
  proxyId!: string

  private config: Config
  private log: (...args: unknown[]) => void
  private stateFile: string
  /** Per-prompt runs (empty — runs are created in acquire, completed in completeRun). */
  private _runs = new Map<string, ManagedRun>()
  private draining: ManagedRun[] = []
  session: CachedSession | null = null
  private sessionRefreshPromise: Promise<string | null> | null = null
  private sessionRebuildScheduled = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  /** Stable per-account trace_session_id (one per conversation, as the CLI
   *  does it; since the proxy is conversation-agnostic we use one per account). */
  readonly traceSessionId: string

  cooldownUntil: Date | null = null
  lastError = ''
  private _restoredState = false
  private _paused = false
  private _autoPaused = false
  private _banned = false
  private banReason = ''
  private onAccountBanned: ((poolName: string, reason: string) => void) | null = null
  _switching = false

  // Usage tracking
  sessionCount = 0
  rateLimit: SessionRateLimit | null = null
  rateLimitsByModel: RateLimitsByModel | null = null
  quotaResetAt: Date | null = null
  private quotaResetTimer: ReturnType<typeof setTimeout> | null = null
  private adsSpoof: AdsSpoof | null = null

  constructor(
    name: string,
    token: string,
    sessionModel: string,
    config: Config,
    upstreamClient: UpstreamClient,
    log: (...args: unknown[]) => void,
    stateFile: string = 'data/session-state.json',
    proxyId: string = '',
  ) {
    this.name = name
    this.token = token
    this.sessionModel = sessionModel
    this.config = config
    this.upstreamClient = upstreamClient
    this.log = log
    this.stateFile = stateFile
    this.traceSessionId = cryptoRandomUUID()
  }

  setAdsSpoof(ads: AdsSpoof | null): void {
    this.adsSpoof = ads
  }

  setOnAccountBanned(cb: ((poolName: string, reason: string) => void) | null): void {
    this.onAccountBanned = cb
  }

  isBanned(): boolean {
    return this._banned
  }

  banReasonText(): string {
    return this.banReason
  }

  /** Permanent Freebuff reject — stop routing this pool. */
  markBanned(reason: string): void {
    if (this._banned) return
    this._banned = true
    this.banReason = reason || 'banned'
    this.lastError = this.banReason
    this.session = null
    this.clearIdleTimer()
    this.clearCooldown()
    this.log(`${this.name}: BANNED — ${this.banReason}`)
    this.onAccountBanned?.(this.name, this.banReason)
  }

  /** Clear ban flag when user re-enables the account. */
  clearBan(): void {
    if (!this._banned) return
    this._banned = false
    this.banReason = ''
    if (this.lastError.toLowerCase().includes('banned') && !this.lastError.toLowerCase().includes('country_blocked')) {
      this.lastError = ''
    }
    this.log(`${this.name}: ban flag cleared`)
  }

  // ─── Public: Session ──────────────────────────────────────────

  async ensureSession(): Promise<string | null> {
    if (this._banned) return null

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
    this.clearIdleTimer()
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

  isPaused(): boolean {
    return this._paused || this._autoPaused
  }

  isAutoPaused(): boolean {
    return this._autoPaused
  }

  setPaused(paused: boolean): void {
    this._paused = paused
    if (paused) {
      // Manual pause — don't clear quota state (auto-unpause still works)
    } else {
      // Manual unpausing — clear auto-pause state so quota timer doesn't re-pause
      this._autoPaused = false
      if (this.quotaResetTimer) { clearTimeout(this.quotaResetTimer); this.quotaResetTimer = null }
      this.quotaResetAt = null
    }
  }

  // ─── Idle Timer ──────────────────────────────────────────────
  // Session dies after sessionIdleTimeout ms of no successful requests.
  // Timer resets ONLY on successful 2xx response (via signalSuccess()),
  // NOT on acquire — failed requests won't keep the session alive.

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    const timeout = this.config.sessionIdleTimeout
    if (timeout <= 0 || !this.session?.instanceId || this.session.status !== 'active') return

    const savedInstanceId = this.session.instanceId
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.session?.instanceId !== savedInstanceId) return
      if (this.hasInflightRequests()) {
        this.log(`${this.name}: idle timeout hit (inflight) — rescheduling`)
        this.resetIdleTimer()
        return
      }
      this.log(`${this.name}: session idle ${timeout}ms — ending session`)
      this.endSessionNow().catch(err => {
        this.log(`${this.name}: idle end-session error:`, err)
      })
    }, timeout)
  }

  /** Call after a successful 2xx upstream response to reset the idle timer.
   *  NOT called on acquire — only successful requests keep the session alive. */
  signalSuccess(): void {
    this.resetIdleTimer()
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
      const state = await this.upstreamClient.getSession(this.token, saved.instanceId, this.proxyId)

      // Capture quota data even when status is not active — upstream returns
      // current rateLimitsByModel on every getSession call.
      this.captureUsageData(state)

      if (state.status.trim() === 'active') {
        const sessionModel = state.model?.trim() ?? ''
        if (sessionModel && sessionModel !== this.sessionModel) {
          this.log(`${this.name}: saved session ${saved.instanceId} is for model ${sessionModel}, expected ${this.sessionModel} — ending it`)
          // Kill the old session so upstream doesn't block us with model_locked
          await this.upstreamClient.endSession(this.token, this.proxyId).catch(() => {})
          return null
        }

        const expiresAt = state.expiresAt?.trim() ? new Date(state.expiresAt) : null
        this.session = {
          status: 'active',
          instanceId: saved.instanceId,
          model: this.sessionModel,
          expiresAt,
          admittedAt: state.admittedAt ?? null,
          remainingMs: state.remainingMs ?? 0,
          position: 0, queueDepth: 0, estimatedWaitMs: 0,
        }
        this.lastError = ''
        this.captureUsageData(state)
        this.log(`${this.name}: ✅ restored session ${saved.instanceId} (expires ${expiresAt?.toISOString() ?? 'unknown'})`)
        this.watchSessionExpiry(saved.instanceId, expiresAt)
        this.persistSessionState()  // refresh saved timestamp
        this.resetIdleTimer()
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
    if (this._banned) {
      throw new Error(`account banned: ${this.banReason || 'banned'}`)
    }
    if (this.isCoolingDown()) {
      throw new Error(`token cooling down until ${this.cooldownUntil!.toISOString()}`)
    }

    const verbose = model !== 'prewarm'
    if (verbose) this.log(`${this.name}: ensureSession for model=${model}`)
    const instanceId = await this.ensureSession()
    if (verbose) this.log(`${this.name}: session instanceId=${instanceId ?? 'none'}`)

    // Per-prompt run: START a fresh run for every incoming request.
    // The real CLI does one START → steps → FINISH per user prompt.
    if (verbose) this.log(`${this.name}: starting run for agent=${agentId}`)
    const runId = await this.upstreamClient.startRun(this.token, agentId, this.proxyId)
    const run: ManagedRun = {
      id: runId,
      agentId,
      startedAt: new Date(),
      inflight: 1,
      requestCount: 1,
      finishing: false,
    }
    this.lastError = ''
    return { pool: this, run, model }
  }

  /** Report a step and FINISH the run — called after a successful chat completion.
   *  This implements the real CLI's per-prompt lifecycle: START → step → FINISH. */
  async completeRun(
    run: ManagedRun,
    credits: number,
    messageId: string | null,
  ): Promise<void> {
    const startTime = run.startedAt.toISOString()
    try {
      await this.upstreamClient.addAgentStep(
        this.token, run.id, 1, credits, [], messageId, 'completed', startTime, this.proxyId,
      )
      this.log(`${this.name}: run ${run.id} — step reported (credits=${credits})`)
    } catch (err) {
      this.log(`${this.name}: addAgentStep for run ${run.id} failed:`, err)
    }
    try {
      await this.upstreamClient.finishRun(
        this.token, run.id, 'completed', 1, credits, credits, undefined, this.proxyId,
      )
      this.log(`${this.name}: run ${run.id} — FINISH completed`)
    } catch (err) {
      this.log(`${this.name}: finishRun ${run.id} failed:`, err)
    }
  }

  /** FINISH a run that failed — called on error paths. */
  async failRun(run: ManagedRun, status: string, errorMessage: string): Promise<void> {
    try {
      await this.upstreamClient.finishRun(
        this.token, run.id, status, run.requestCount, 0, 0, errorMessage, this.proxyId,
      )
    } catch (err) {
      this.log(`${this.name}: failRun ${run.id} failed:`, err)
    }
  }

  release(run: ManagedRun): void {
    if (run.inflight > 0) run.inflight--
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

  clearCooldown(): void {
    this.cooldownUntil = null
  }

  // ─── Usage Tracking ──────────────────────────────────────────

  /** Extract rate limit data from a session response and store it on the pool.
   *  Derives rateLimit from rateLimitsByModel[sessionModel] so the dashboard
   *  always shows the bound model's current quota even when the upstream
   *  response only includes rateLimitsByModel. */
  captureUsageData(resp: { rateLimit?: SessionRateLimit; rateLimitsByModel?: RateLimitsByModel }): void {
    if (resp.rateLimitsByModel) {
      this.rateLimitsByModel = resp.rateLimitsByModel
      const bound = resp.rateLimitsByModel[this.sessionModel]
      if (bound) this.rateLimit = bound
    }
    if (resp.rateLimit) this.rateLimit = resp.rateLimit
  }

  /** Triggered when upstream returns a quota error. Auto-pause if so. */
  triggerQuotaPause(): void {
    if (!this.rateLimitsByModel) return
    const limit = this.rateLimitsByModel[this.sessionModel]
    if (!limit) return
    this._autoPaused = true
    const resetAt = limit.resetAt ? new Date(limit.resetAt) : null
    if (resetAt && resetAt.getTime() > Date.now()) {
      this.quotaResetAt = resetAt
      this.scheduleQuotaReset(resetAt)
      this.log(`${this.name}: quota error from upstream (${limit.recentCount}/${limit.limit}), auto-pausing until ${resetAt.toISOString()}`)
    } else {
      this.log(`${this.name}: quota error from upstream (${limit.recentCount}/${limit.limit}), auto-pausing (no reset time)`)
    }
  }

  /** Schedule a one-shot timer to auto-unpause at resetAt. */
  private scheduleQuotaReset(resetAt: Date): void {
    if (this.quotaResetTimer) clearTimeout(this.quotaResetTimer)
    const delay = resetAt.getTime() - Date.now()
    if (delay <= 0) {
      this.unpauseFromQuota()
      return
    }
    this.quotaResetTimer = setTimeout(() => this.unpauseFromQuota(), delay)
  }

  /** Auto-unpause from quota exhaustion. Does NOT override manual pause. */
  private unpauseFromQuota(): void {
    this.quotaResetTimer = null
    this.quotaResetAt = null
    this._autoPaused = false
    this.log(`${this.name}: quota reset — auto-unpausing`)
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
      switching: this._switching,
      sessionStatus: this._banned ? (this.banReason || 'banned') : (this.session?.status ?? 'none'),
      sessionInstanceId: this.session?.instanceId ?? '',
      sessionExpiresAt: this.session?.expiresAt?.toISOString() ?? null,
      sessionAdmittedAt: this.session?.admittedAt ?? null,
      sessionRemainingMs: this.session?.remainingMs ?? 0,
      sessionPosition: this.session?.position ?? 0,
      sessionQueueDepth: this.session?.queueDepth ?? 0,
      sessionEstWaitMs: this.session?.estimatedWaitMs ?? 0,
      cooldownUntil: this.cooldownUntil?.toISOString() ?? null,
      lastError: this.lastError,
      paused: this._paused,
      autoPaused: this._autoPaused,
      banned: this._banned,
      banReason: this.banReason,
      sessionCount: this.sessionCount,
      rateLimit: this.rateLimit,
      rateLimitsByModel: this.rateLimitsByModel,
      quotaResetAt: this.quotaResetAt?.toISOString() ?? null,
    }
  }

  // ─── Maintenance ──────────────────────────────────────────────

  async maintain(): Promise<void> {
    // Per-prompt runs are completed inline — no cached-run rotation needed.
  }

  async shutdown(): Promise<void> {
    this.clearIdleTimer()
    if (this.quotaResetTimer) { clearTimeout(this.quotaResetTimer); this.quotaResetTimer = null }
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
    if (this._banned) return null
    const model = this.sessionModel
    try {
      const result = await this.refreshSession(model)
      if (result.status === 'banned') {
        this.markBanned('banned')
        return null
      }
      if (result.status === 'country_blocked') {
        // Geo reject: fail over only — not permanent ban.
        this.lastError = 'country_blocked'
        throw new Error('country_blocked')
      }
      if (result.status === 'active' && result.instanceId) {
        // Upstream may bind to a different model than requested (e.g. free tier
        // forces deepseek even though we asked for kimi). Kill it immediately.
        if (result.sessionModel && result.sessionModel !== model) {
          this.log(`${this.name}: upstream bound session to ${result.sessionModel}, expected ${model} — killing it`)
          await this.upstreamClient.endSession(this.token, this.proxyId).catch(() => {})
          throw new Error(`model mismatch: upstream bound ${result.sessionModel} but account is ${model}`)
        }

        this.session = {
          status: 'active', instanceId: result.instanceId, model,
          expiresAt: result.expiresAt, admittedAt: result.admittedAt ?? null, remainingMs: result.remainingMs ?? 0,
          position: 0, queueDepth: 0, estimatedWaitMs: 0,
        }
        this.lastError = ''
        this.sessionCount++
        this.captureUsageData(result)
        this.watchSessionExpiry(result.instanceId, result.expiresAt)
        this.persistSessionState()  // save to disk for restart reuse
        this.resetIdleTimer()
        this.adsSpoof?.maybeFire(this.name, this.token, this.proxyId || undefined)
        return result.instanceId
      }
      if (result.status === 'queued' && result.instanceId) {
        this.session = {
          status: 'queued', instanceId: result.instanceId, model,
          expiresAt: null, admittedAt: null, remainingMs: 0,
          position: result.position,
          queueDepth: result.queueDepth, estimatedWaitMs: result.estimatedWaitMs,
        }
        this.captureUsageData(result)
        this.backgroundPollSession(model, result.instanceId)
        return null
      }
      this.session = null
      this.lastError = `unexpected session status: ${result.status}`
      return null
    } catch (err) {
      this.session = null
      const msg = String(err)
      this.lastError = msg
      // Legacy throw path if parseSessionResponse still throws banned text
      if (msg.includes('"status":"banned"') || msg.includes('status":"banned')) {
        if (!msg.includes('country_blocked')) this.markBanned('banned')
      } else if (msg.includes('country_blocked')) {
        this.lastError = 'country_blocked'
      }
      this.log(`${this.name}: session refresh failed:`, err)
      return null
    }
  }

  private async refreshSession(model: string): Promise<{
    status: string; instanceId: string; expiresAt: Date | null
    sessionModel?: string
    admittedAt: string | null; remainingMs: number
    position: number; queueDepth: number; estimatedWaitMs: number
    rateLimit?: SessionRateLimit
    rateLimitsByModel?: RateLimitsByModel
  }> {
    let lockedRetries = 0
    let state = await this.upstreamClient.createSession(this.token, model, this.proxyId)

    for (;;) {
      switch (state.status.trim()) {
        case 'disabled':
          return { status: 'disabled', instanceId: '', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 }

        case 'banned':
        case 'country_blocked':
          return { status: state.status.trim(), instanceId: '', expiresAt: null, admittedAt: null, remainingMs: 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 }

        case 'model_locked': {
          lockedRetries++
          if (lockedRetries > MAX_MODEL_LOCKED_RETRIES) {
            throw new Error(`model_locked after ${lockedRetries} retries`)
          }
          this.log(`${this.name}: model_locked, ending upstream session and retrying (${lockedRetries}/${MAX_MODEL_LOCKED_RETRIES})`)
          // Send DELETE directly — endSessionNow() bails out because
          // this.session is still null during session creation.
          await this.upstreamClient.endSession(this.token, this.proxyId).catch(() => {})
          await sleep(2_000)
          state = await this.upstreamClient.createSession(this.token, model, this.proxyId)
          continue
        }

        case 'active': {
          const id = state.instanceId?.trim() ?? ''
          if (!id) throw new Error('session active but missing instanceId')
          const exp = state.expiresAt?.trim() ? new Date(state.expiresAt) : null
          return { status: 'active', instanceId: id, expiresAt: exp, sessionModel: state.model?.trim(), admittedAt: state.admittedAt ?? null, remainingMs: state.remainingMs ?? 0, position: 0, queueDepth: 0, estimatedWaitMs: 0, rateLimit: state.rateLimit, rateLimitsByModel: state.rateLimitsByModel }
        }

        case 'queued': {
          const id = state.instanceId?.trim() ?? ''
          if (!id) throw new Error('session queued but missing instanceId')
          this.session = {
            status: 'queued', instanceId: id, model, expiresAt: null,
            admittedAt: null, remainingMs: 0,
            position: state.position ?? 0, queueDepth: state.queueDepth ?? 0,
            estimatedWaitMs: state.estimatedWaitMs ?? 0,
          }
          this.captureUsageData(state)
          const delay = smartPollDelay(state.estimatedWaitMs ?? 0)
          this.log(`${this.name}: queued (pos ${state.position}/${state.queueDepth}), polling in ${delay}ms`)
          await sleep(delay)
          state = await this.upstreamClient.getSession(this.token, id, this.proxyId)
          continue
        }

        case 'none': case 'ended': case 'superseded':
          state = await this.upstreamClient.createSession(this.token, model, this.proxyId)
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
          const state = await this.upstreamClient.getSession(this.token, instanceId, this.proxyId)
          if (state.status.trim() === 'active') {
            const exp = state.expiresAt?.trim() ? new Date(state.expiresAt) : null
            this.session = { status: 'active', instanceId, model, expiresAt: exp, admittedAt: state.admittedAt ?? null, remainingMs: state.remainingMs ?? 0, position: 0, queueDepth: 0, estimatedWaitMs: 0 }
            this.lastError = ''
            this.sessionCount++
            this.captureUsageData(state)
            this.log(`${this.name}: bg poll → active!`)
            this.watchSessionExpiry(instanceId, exp)
            this.persistSessionState()  // save to disk
            this.resetIdleTimer()
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
    this.log(`${this.name}: session invalidated (${reason}) — will create on next request`)
    this.sessionRebuildScheduled = false
  }

  private hasInflightRequests(): boolean {
    for (const r of this._runs.values()) if (r.inflight > 0) return true
    for (const r of this.draining) if (r.inflight > 0) return true
    return false
  }

  async endSessionNow(): Promise<void> {
    this.clearIdleTimer()
    const s = this.session
    this.session = null
    if (!s || s.status === 'disabled' || !s.instanceId) return
    this.log(`${this.name}: ending session (${s.model}/${s.instanceId})`)
    await this.upstreamClient.endSession(this.token, this.proxyId)
    this.log(`${this.name}: session ended`)
  }

  // ─── Private: Run Lifecycle ──────────────────────────────────
  // (Per-prompt runs are managed in acquire/completeRun/failRun above.
  //  No cached-run rotation or draining needed.)
}

// ─── RunManager ────────────────────────────────────────────────

export class RunManager {
  private pools: TokenPool[]
  private config: Config
  private upstreamClient: UpstreamClient
  private log: (...args: unknown[]) => void
  private maintainTimer: ReturnType<typeof setInterval> | null = null
  private agentIds: string[] = []
  private nextIdx = 0
  private adsSpoof: AdsSpoof | null = null
  private onAccountBanned: ((poolName: string, reason: string) => void) | null = null

  constructor(config: Config, upstreamClient: UpstreamClient, log: (...args: unknown[]) => void) {
    this.config = config
    this.upstreamClient = upstreamClient
    this.log = log
    this.pools = []
  }

  setAdsSpoof(ads: AdsSpoof | null): void {
    this.adsSpoof = ads
    for (const pool of this.pools) pool.setAdsSpoof(ads)
  }

  setOnAccountBanned(cb: ((poolName: string, reason: string) => void) | null): void {
    this.onAccountBanned = cb
    for (const pool of this.pools) pool.setOnAccountBanned(cb)
  }

  // ─── Switch Pool Model ────────────────────────────────────────
  // Ends the current session on the pool and switches to a new model.
  // One auth token = one session on upstream, so we reuse the same pool.

  async switchModel(poolName: string, newModel: string): Promise<void> {
    const pool = this.getPoolByName(poolName) ?? this.pools[0]
    if (!pool) throw new Error('no pool available')
    if (pool.sessionModel === newModel) return

    const oldModel = pool.sessionModel
    this.log(`switching pool ${pool.name} from ${oldModel} → ${newModel}`)

    await pool.endSessionNow().catch(err => this.log(`end session failed: ${err}`))
    pool.session = null
    pool._switching = true
    pool.sessionModel = newModel

    // Session will be created on next request
    pool._switching = false
    this.log(`session for ${newModel} will be created on next request`)
  }

  async start(agentIds: string[]): Promise<void> {
    this.agentIds = agentIds
    // Session created on first request — no prewarm to avoid wasting
    // premium session quota on idle sessions that never receive chat traffic.

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

    const matching = this.pools.filter(p => p.sessionModel === primaryModel && !p.isPaused() && !p.isBanned())

    if (matching.length === 0) {
      throw new Error(`no session available for model ${primaryModel}. Add/switch an account in the dashboard.`)
    }

    const startIdx = this.nextIdx % matching.length
    this.nextIdx++

    const errors: string[] = []
    for (let i = 0; i < matching.length; i++) {
      const pool = matching[(startIdx + i) % matching.length]
      if (pool.isCoolingDown()) continue
      try { return await pool.acquire(agentId, model) }
      catch (err) { errors.push(`${pool.name}: ${err}`) }
    }

    throw new Error(`all pools for ${primaryModel} are unavailable (${errors.join('; ')})`)
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

  addPool(pool: TokenPool): void {
    if (this.adsSpoof) pool.setAdsSpoof(this.adsSpoof)
    if (this.onAccountBanned) pool.setOnAccountBanned(this.onAccountBanned)
    this.pools.push(pool)
    this.log(`run-manager: added pool ${pool.name} (model: ${pool.sessionModel})`)
  }

  removePool(name: string): void {
    const idx = this.pools.findIndex(p => p.name === name)
    if (idx !== -1) {
      this.pools.splice(idx, 1)
      this.log(`run-manager: removed pool ${name}`)
    }
  }

  getPoolByName(name: string): TokenPool | undefined {
    return this.pools.find(p => p.name === name)
  }
}

function smartPollDelay(estimatedWaitMs: number): number {
  if (estimatedWaitMs <= 0) return SESSION_POLL_INTERVAL
  return Math.max(SESSION_POLL_INTERVAL, Math.min(60_000, estimatedWaitMs / 20))
}
