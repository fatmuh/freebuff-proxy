import type { Context } from 'hono'
import type { AuthStore } from '../auth-store.js'
import type { BindingStore } from '../binding-store.js'

interface CreateBindingBody {
  api_key: string
  model: string
}

export function handleBindingsList(bindings: BindingStore, auth: AuthStore) {
  return (c: Context) => {
    const rawBindings = bindings.list()
    const keys = auth.listApiKeys()

    const enriched = rawBindings.map(b => {
      const apiKeyEntry = keys.find(k => k.key === b.apiKey)
      return {
        api_key: b.apiKey.slice(0, 6) + '...' + b.apiKey.slice(-4),
        full_key: b.apiKey,
        model: b.model,
        key_name: apiKeyEntry?.name ?? '',
        key_id: apiKeyEntry?.id ?? '',
        created_at: b.createdAt,
      }
    })

    return c.json({ bindings: enriched })
  }
}

export function handleBindingsCreate(bindings: BindingStore) {
  return async (c: Context) => {
    let body: CreateBindingBody
    try { body = await c.req.json<CreateBindingBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    if (!body.api_key || !body.model) {
      return c.json({ error: 'api_key and model are required' }, 400)
    }
    const created = bindings.bind(body.api_key, body.model)
    return c.json({ ok: true, created })
  }
}

export function handleBindingsDelete(bindings: BindingStore) {
  return (c: Context) => {
    const key = c.req.param('key')
    if (!key) {
      return c.json({ error: 'key is required' }, 400)
    }
    const deleted = bindings.unbind(key)
    return c.json({ ok: true, deleted })
  }
}
