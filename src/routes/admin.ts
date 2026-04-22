import type { Context } from 'hono'
import type { BindingStore } from '../binding-store.js'
import type { RunManager } from '../run-manager.js'

// ─── POST /admin/bind ──────────────────────────────────────────
export function handleBind(bindings: BindingStore, runs: RunManager) {
  return async (c: Context) => {
    const body = await c.req.json<{ api_key?: string; model?: string }>().catch(() => null)
    if (!body?.api_key || !body?.model) {
      return c.json({ error: 'api_key and model are required' }, 400)
    }

    const created = bindings.bind(body.api_key, body.model)
    await runs.switchModel(body.model).catch(err => {
      console.error('[admin/bind] switchModel failed:', err)
    })
    return c.json({ ok: true, created })
  }
}

// ─── POST /admin/unbind ────────────────────────────────────────
export function handleUnbind(bindings: BindingStore) {
  return async (c: Context) => {
    const body = await c.req.json<{ api_key?: string }>().catch(() => null)
    if (!body?.api_key) {
      return c.json({ error: 'api_key is required' }, 400)
    }

    const deleted = bindings.unbind(body.api_key)
    return c.json({ ok: true, deleted })
  }
}

// ─── GET /admin/status ─────────────────────────────────────────
// Everything in one place: health, bindings, pools
export function handleStatus(bindings: BindingStore, runs: RunManager, startedAt: Date) {
  return (c: Context) => {
    return c.json({
      ok: true,
      started_at: startedAt.toISOString(),
      uptime_sec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      bindings: bindings.list(),
      pools: runs.snapshots(),
    })
  }
}
