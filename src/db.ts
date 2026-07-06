import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface RequestLog {
  id?: number
  created_at: string
  api_key: string | null
  api_key_id: string | null
  account_id: string | null
  model: string
  agent_id: string | null
  run_id: string | null
  status_code: number | null
  tokens_in: number | null
  tokens_out: number | null
  latency_ms: number | null
  error: string | null
  is_stream: number
}

export interface AdminSession {
  id: string
  created_at: string
  expires_at: string
}

const CREATE_REQUEST_LOGS = `
CREATE TABLE IF NOT EXISTS request_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  api_key     TEXT,
  api_key_id  TEXT,
  account_id  TEXT,
  model       TEXT NOT NULL,
  agent_id    TEXT,
  run_id      TEXT,
  status_code INTEGER,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  latency_ms  INTEGER,
  error       TEXT,
  is_stream   INTEGER DEFAULT 0
);
`

const CREATE_ADMIN_SESSIONS = `
CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);',
  'CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model);',
  'CREATE INDEX IF NOT EXISTS idx_logs_api_key ON request_logs(api_key);',
  'CREATE INDEX IF NOT EXISTS idx_logs_api_key_id ON request_logs(api_key_id);',
  'CREATE INDEX IF NOT EXISTS idx_logs_account ON request_logs(account_id);',
]

export class DB {
  db: Database.Database
  private log: (...args: unknown[]) => void

  constructor(dataDir: string, log: (...args: unknown[]) => void) {
    this.log = log
    const dbPath = resolve(dataDir, 'proxy.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.init()
  }

  private init(): void {
    this.db.exec(CREATE_REQUEST_LOGS)
    this.db.exec(CREATE_ADMIN_SESSIONS)
    // Migration: add api_key_id column if missing (existing DBs)
    try { this.db.exec('ALTER TABLE request_logs ADD COLUMN api_key_id TEXT') } catch { /* already exists */ }
    for (const sql of INDEXES) this.db.exec(sql)
    this.log('db: schema initialized')
  }

  insertRequestLog(log: Omit<RequestLog, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO request_logs (created_at, api_key, api_key_id, account_id, model, agent_id, run_id, status_code, tokens_in, tokens_out, latency_ms, error, is_stream)
      VALUES (@created_at, @api_key, @api_key_id, @account_id, @model, @agent_id, @run_id, @status_code, @tokens_in, @tokens_out, @latency_ms, @error, @is_stream)
    `)
    const info = stmt.run(log)
    return info.lastInsertRowid as number
  }

  lastInsertRowid(): number {
    const row = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
    return row.id
  }

  updateRequestLogTokens(id: number, tokensIn: number | null, tokensOut: number | null): void {
    this.db.prepare('UPDATE request_logs SET tokens_in = @tokens_in, tokens_out = @tokens_out WHERE id = @id').run({
      id,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    })
  }

  queryRequests(filters: {
    model?: string
    account?: string
    api_key?: string
    status?: number
    from?: string
    to?: string
    page?: number
    limit?: number
    since_id?: number
  }): { rows: RequestLog[]; total: number } {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}

    if (filters.model) { conditions.push('model = @model'); params.model = filters.model }
    if (filters.account) { conditions.push('account_id = @account'); params.account = filters.account }
    if (filters.api_key) { conditions.push('api_key = @api_key'); params.api_key = filters.api_key }
    if (filters.status) { conditions.push('status_code = @status'); params.status = filters.status }
    if (filters.from) { conditions.push('created_at >= @from_date'); params.from_date = filters.from + 'T00:00:00' }
    if (filters.to) { conditions.push('created_at <= @to_date'); params.to_date = filters.to + 'T23:59:59' }
    if (filters.since_id) { conditions.push('id > @since_id'); params.since_id = filters.since_id }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

    const countSql = `SELECT COUNT(*) as total FROM request_logs ${where}`
    const countRow = this.db.prepare(countSql).get(params) as { total: number }

    const page = filters.page ?? 1
    const limit = filters.limit ?? 50
    const offset = (page - 1) * limit

    const dataSql = `SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`
    const rows = this.db.prepare(dataSql).all({ ...params, limit, offset }) as RequestLog[]

    return { rows, total: countRow.total }
  }

  purgeOldLogs(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const info = this.db.prepare('DELETE FROM request_logs WHERE created_at < @cutoff').run({ cutoff })
    return info.changes
  }

  getUsageSummary() {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    const query = (startDate: string) => {
      const row = this.db.prepare(`
        SELECT COUNT(*) as requests,
               COALESCE(SUM(tokens_in), 0) as tokens_in,
               COALESCE(SUM(tokens_out), 0) as tokens_out,
               COALESCE(AVG(latency_ms), 0) as avg_latency_ms
        FROM request_logs WHERE created_at >= @start
      `).get({ start: startDate }) as { requests: number; tokens_in: number; tokens_out: number; avg_latency_ms: number }
      return row
    }

    return {
      today: query(today + 'T00:00:00'),
      yesterday: query(yesterday + 'T00:00:00'),
      last_7d: query(weekAgo + 'T00:00:00'),
      last_30d: query(monthAgo + 'T00:00:00'),
    }
  }

  getUsageDaily(days: number = 30) {
    const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00'
    return this.db.prepare(`
      SELECT DATE(created_at) as date,
             COUNT(*) as requests,
             COALESCE(SUM(tokens_in), 0) as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out
      FROM request_logs
      WHERE created_at >= @start
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all({ start: startDate })
  }

  getUsageByModel(days: number = 30) {
    const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00'
    return this.db.prepare(`
      SELECT model,
             COUNT(*) as requests,
             COALESCE(SUM(tokens_in), 0) as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out
      FROM request_logs
      WHERE created_at >= @start
      GROUP BY model
      ORDER BY requests DESC
    `).all({ start: startDate })
  }

  getUsageByAccount(days: number = 30) {
    const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00'
    return this.db.prepare(`
      SELECT account_id,
             COUNT(*) as requests,
             COALESCE(SUM(tokens_in), 0) as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out
      FROM request_logs
      WHERE created_at >= @start
      GROUP BY account_id
      ORDER BY requests DESC
    `).all({ start: startDate })
  }

  getUsageByApiKey(days: number = 30) {
    const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00'
    return this.db.prepare(`
      SELECT api_key_id,
             COUNT(*) as requests,
             COALESCE(SUM(tokens_in), 0) as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out
      FROM request_logs
      WHERE created_at >= @start
      GROUP BY api_key_id
      ORDER BY requests DESC
    `).all({ start: startDate })
  }

  getUsageHourly() {
    const today = new Date().toISOString().slice(0, 10) + 'T00:00:00'
    return this.db.prepare(`
      SELECT strftime('%H', created_at) as hour,
             COUNT(*) as requests
      FROM request_logs
      WHERE created_at >= @today
      GROUP BY strftime('%H', created_at)
      ORDER BY hour
    `).all({ today })
  }

  // ── Usage Analytics (codex-lb style) ──────────────────────────

  /**
   * Returns aggregated usage analytics for the dashboard Usage page.
   * No cost/cached columns — just tokens & request counts.
   * Uses SQLite epoch-based bucketing to group data by timeframe.
   */
  getUsageAnalytics(timeframe: string, apiKeyId?: string | null) {
    const now = Date.now()
    let startAt: Date | null
    let bucketSeconds: number
    const DAY = 86_400_000

    // Resolve timeframe → start date + bucket size
    switch (timeframe) {
      case '1d':
        startAt = new Date(now - DAY)
        bucketSeconds = 3600 // 1h buckets
        break
      case '3d':
        startAt = new Date(now - 3 * DAY)
        bucketSeconds = 6 * 3600 // 6h buckets
        break
      case '7d':
        startAt = new Date(now - 7 * DAY)
        bucketSeconds = 24 * 3600 // 1d buckets
        break
      case '30d':
        startAt = new Date(now - 30 * DAY)
        bucketSeconds = 24 * 3600
        break
      default: { // "all" — find earliest record, auto-pick bucket
        const earliest = this._getEarliestCreatedAt(apiKeyId)
        // earliest is an ISO-8601 string from SQLite (already ends in 'Z' if stored with 'Z').
        // Only append 'Z' when the value lacks timezone info, otherwise new Date(...) throws.
        startAt = earliest ? new Date(earliest.endsWith('Z') ? earliest : earliest + 'Z') : null
        const spanSec = startAt ? (now - startAt.getTime()) / 1000 : 0
        if (spanSec > 730 * 86400) bucketSeconds = 30 * 86400
        else if (spanSec > 180 * 86400) bucketSeconds = 7 * 86400
        else if (spanSec > 45 * 86400) bucketSeconds = 86400
        else if (spanSec > 7 * 86400) bucketSeconds = 12 * 3600
        else bucketSeconds = 3600
        break
      }
    }

    const startIso = startAt ? startAt.toISOString() : null
    const endIso = new Date(now).toISOString()

    // ── Totals ──
    const totals = this._analyticsTotals(startIso, apiKeyId)

    // ── Bar buckets (per model per time bucket) ──
    const barBuckets = this._analyticsBarBuckets(startIso, endIso, bucketSeconds, apiKeyId)

    // ── Line points (aggregate tokens per bucket) ──
    const linePoints = this._analyticsLinePoints(startIso, endIso, bucketSeconds, apiKeyId)

    // ── Model usage table ──
    const modelUsage = this._analyticsModelUsage(startIso, apiKeyId)

    return {
      timeframe: {
        key: timeframe,
        bucket_seconds: bucketSeconds,
        start_at: startIso,
        end_at: endIso,
      },
      api_key_id: apiKeyId ?? null,
      totals,
      usage_over_time: barBuckets,
      usage_lines: linePoints,
      model_usage: modelUsage,
    }
  }

  /** Get earliest created_at for "all" timeframe */
  private _getEarliestCreatedAt(apiKeyId?: string | null): string | null {
    const sql = apiKeyId
      ? 'SELECT MIN(created_at) as v FROM request_logs WHERE api_key_id = ?'
      : 'SELECT MIN(created_at) as v FROM request_logs'
    const row = this.db.prepare(sql).get(apiKeyId ? [apiKeyId] : []) as { v: string | null }
    return row?.v ?? null
  }

  /** Totals: request_count, input_tokens, output_tokens, total_tokens */
  private _analyticsTotals(startIso: string | null, apiKeyId?: string | null) {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}
    if (startIso) { conditions.push('created_at >= @start'); params.start = startIso }
    if (apiKeyId) { conditions.push('api_key_id = @akid'); params.akid = apiKeyId }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const sql = `SELECT COUNT(*) as request_count,
                        COALESCE(SUM(tokens_in), 0) as input_tokens,
                        COALESCE(SUM(tokens_out), 0) as output_tokens
                 FROM request_logs ${where}`
    const row = this.db.prepare(sql).get(params) as { request_count: number; input_tokens: number; output_tokens: number }
    return {
      request_count: row.request_count,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.input_tokens + row.output_tokens,
    }
  }

  /** Bar chart data: per model per time bucket */
  private _analyticsBarBuckets(startIso: string | null, endIso: string, bucketSeconds: number, apiKeyId?: string | null) {
    const conditions: string[] = []
    const params: Record<string, unknown> = { end: endIso }
    if (startIso) { conditions.push('created_at >= @start'); params.start = startIso }
    if (apiKeyId) { conditions.push('api_key_id = @akid'); params.akid = apiKeyId }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    // SQLite bucket: (unixepoch(created_at) / bucketSeconds) * bucketSeconds
    const sql = `SELECT (unixepoch(created_at) / ${bucketSeconds}) * ${bucketSeconds} as bucket_epoch,
                       model,
                       COALESCE(SUM(tokens_in), 0) as input_tokens,
                       COALESCE(SUM(tokens_out), 0) as output_tokens
                FROM request_logs ${where}
                GROUP BY bucket_epoch, model
                ORDER BY bucket_epoch, model`
    const rows = this.db.prepare(sql).all(params) as { bucket_epoch: number; model: string; input_tokens: number; output_tokens: number }[]

    // Group by bucket → { t, models: [{ model, inputTokens, outputTokens }] }
    const map = new Map<number, { model: string; inputTokens: number; outputTokens: number }[]>()
    for (const r of rows) {
      if (!map.has(r.bucket_epoch)) map.set(r.bucket_epoch, [])
      map.get(r.bucket_epoch)!.push({
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })
    }

    // Fill gaps if we have a start
    const result: { t: string; models: { model: string; inputTokens: number; outputTokens: number }[] }[] = []
    if (startIso && map.size > 0) {
      const startEpoch = Math.floor(new Date(startIso).getTime() / 1000)
      const firstBucket = Math.ceil(startEpoch / bucketSeconds) * bucketSeconds
      const endEpoch = Math.floor(new Date(endIso).getTime() / 1000)
      for (let e = firstBucket; e <= endEpoch; e += bucketSeconds) {
        result.push({
          t: new Date(e * 1000).toISOString(),
          models: map.get(e) ?? [],
        })
      }
    } else {
      for (const [epoch, models] of map) {
        result.push({ t: new Date(epoch * 1000).toISOString(), models })
      }
    }
    return result
  }

  /** Line chart data: total tokens + request count per bucket */
  private _analyticsLinePoints(startIso: string | null, endIso: string, bucketSeconds: number, apiKeyId?: string | null) {
    const conditions: string[] = []
    const params: Record<string, unknown> = { end: endIso }
    if (startIso) { conditions.push('created_at >= @start'); params.start = startIso }
    if (apiKeyId) { conditions.push('api_key_id = @akid'); params.akid = apiKeyId }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const sql = `SELECT (unixepoch(created_at) / ${bucketSeconds}) * ${bucketSeconds} as bucket_epoch,
                       COALESCE(SUM(tokens_in), 0) + COALESCE(SUM(tokens_out), 0) as tokens,
                       COUNT(*) as request_count
                FROM request_logs ${where}
                GROUP BY bucket_epoch
                ORDER BY bucket_epoch`
    const rows = this.db.prepare(sql).all(params) as { bucket_epoch: number; tokens: number; request_count: number }[]

    // Fill gaps
    const map = new Map(rows.map(r => [r.bucket_epoch, r] as const))
    const result: { t: string; tokens: number; request_count: number }[] = []

    if (startIso && rows.length > 0) {
      const startEpoch = Math.floor(new Date(startIso).getTime() / 1000)
      const firstBucket = Math.ceil(startEpoch / bucketSeconds) * bucketSeconds
      const endEpoch = Math.floor(new Date(endIso).getTime() / 1000)
      for (let e = firstBucket; e <= endEpoch; e += bucketSeconds) {
        const entry = map.get(e)
        result.push({
          t: new Date(e * 1000).toISOString(),
          tokens: entry?.tokens ?? 0,
          request_count: entry?.request_count ?? 0,
        })
      }
    } else {
      for (const r of rows) {
        result.push({ t: new Date(r.bucket_epoch * 1000).toISOString(), tokens: r.tokens, request_count: r.request_count })
      }
    }
    return result
  }

  /** Model usage table rows */
  private _analyticsModelUsage(startIso: string | null, apiKeyId?: string | null) {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}
    if (startIso) { conditions.push('created_at >= @start'); params.start = startIso }
    if (apiKeyId) { conditions.push('api_key_id = @akid'); params.akid = apiKeyId }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const sql = `SELECT model,
                       COUNT(*) as request_count,
                       COALESCE(SUM(tokens_in), 0) as input_tokens,
                       COALESCE(SUM(tokens_out), 0) as output_tokens
                FROM request_logs ${where}
                GROUP BY model
                ORDER BY request_count DESC`
    const rows = this.db.prepare(sql).all(params) as { model: string; request_count: number; input_tokens: number; output_tokens: number }[]
    return rows.map(r => ({
      model: r.model,
      request_count: r.request_count,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      total_tokens: r.input_tokens + r.output_tokens,
    }))
  }

  // Session management
  createSession(id: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO admin_sessions (id, created_at, expires_at) VALUES (@id, @created_at, @expires_at)').run({
      id,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    })
  }

  getSession(id: string): AdminSession | undefined {
    return this.db.prepare('SELECT * FROM admin_sessions WHERE id = @id AND expires_at > @now').get({
      id,
      now: new Date().toISOString(),
    }) as AdminSession | undefined
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE id = @id').run({ id })
  }

  cleanExpiredSessions(): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < @now').run({
      now: new Date().toISOString(),
    })
  }

  close(): void {
    this.db.close()
  }
}
