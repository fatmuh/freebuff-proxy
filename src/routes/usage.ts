import type { Context } from 'hono'
import type { DB } from '../db.js'

export function handleUsageSummary(db: DB) {
  return (c: Context) => {
    return c.json(db.getUsageSummary())
  }
}

export function handleUsageDaily(db: DB) {
  return (c: Context) => {
    const days = parseInt(c.req.query('days') ?? '30')
    return c.json(db.getUsageDaily(days))
  }
}

export function handleUsageByModel(db: DB) {
  return (c: Context) => {
    const days = parseInt(c.req.query('days') ?? '30')
    return c.json(db.getUsageByModel(days))
  }
}

export function handleUsageByAccount(db: DB) {
  return (c: Context) => {
    const days = parseInt(c.req.query('days') ?? '30')
    return c.json(db.getUsageByAccount(days))
  }
}

export function handleUsageByApiKey(db: DB) {
  return (c: Context) => {
    const days = parseInt(c.req.query('days') ?? '30')
    return c.json(db.getUsageByApiKey(days))
  }
}

export function handleUsageHourly(db: DB) {
  return (c: Context) => {
    return c.json(db.getUsageHourly())
  }
}
