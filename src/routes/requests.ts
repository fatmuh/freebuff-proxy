import type { Context } from 'hono'
import type { DB } from '../db.js'

export function handleRequestsList(db: DB) {
  return (c: Context) => {
    const filters = {
      model: c.req.query('model'),
      account: c.req.query('account'),
      api_key: c.req.query('api_key'),
      status: c.req.query('status') ? parseInt(c.req.query('status')!) : undefined,
      from: c.req.query('from'),
      to: c.req.query('to'),
      page: c.req.query('page') ? parseInt(c.req.query('page')!) : 1,
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : 50,
      since_id: c.req.query('since_id') ? parseInt(c.req.query('since_id')!) : undefined,
    }
    const result = db.queryRequests(filters)
    return c.json(result)
  }
}

export function handleRequestsPurge(db: DB) {
  return (c: Context) => {
    const days = parseInt(c.req.query('days') ?? '7')
    const deleted = db.purgeOldLogs(days)
    return c.json({ ok: true, deleted, retention_days: days })
  }
}
