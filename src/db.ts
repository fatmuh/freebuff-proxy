import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface RequestLog {
  id?: number
  created_at: string
  api_key: string | null
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
    for (const sql of INDEXES) this.db.exec(sql)
    this.log('db: schema initialized')
  }

  insertRequestLog(log: Omit<RequestLog, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO request_logs (created_at, api_key, account_id, model, agent_id, run_id, status_code, tokens_in, tokens_out, latency_ms, error, is_stream)
      VALUES (@created_at, @api_key, @account_id, @model, @agent_id, @run_id, @status_code, @tokens_in, @tokens_out, @latency_ms, @error, @is_stream)
    `)
    const info = stmt.run(log)
    return info.lastInsertRowid as number
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
