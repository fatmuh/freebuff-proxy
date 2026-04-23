import type { Context } from 'hono'
import type { BindingStore } from '../binding-store.js'
import type { RunManager } from '../run-manager.js'

interface BindBody {
  api_key: string
  model: string
}

interface UnbindBody {
  api_key: string
}

export function handleBind(bindings: BindingStore) {
  return async (c: Context) => {
    let body: BindBody
    try { body = await c.req.json<BindBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    if (!body.api_key || !body.model) {
      return c.json({ error: 'api_key and model are required' }, 400)
    }

    const created = bindings.bind(body.api_key, body.model)
    return c.json({ ok: true, created })
  }
}

export function handleUnbind(bindings: BindingStore) {
  return async (c: Context) => {
    let body: UnbindBody
    try { body = await c.req.json<UnbindBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    if (!body.api_key) {
      return c.json({ error: 'api_key is required' }, 400)
    }

    const deleted = bindings.unbind(body.api_key)
    return c.json({ ok: true, deleted })
  }
}

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
