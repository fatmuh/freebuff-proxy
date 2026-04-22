import type { Context } from 'hono'
import type { RunManager } from '../run-manager.js'

// GET /healthz — returns proxy health + pool states
export function handleHealthz(runs: RunManager, startedAt: Date) {
  return (c: Context) => {
    return c.json({
      ok: true,
      started_at: startedAt.toISOString(),
      uptime_sec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      token_state: runs.snapshots(),
    })
  }
}
