import type { Context } from 'hono'
import type { AuthStore } from '../auth-store.js'
import { randomBytes } from 'node:crypto'

interface CreateKeyBody {
  key?: string
  name?: string
  bound_account_id?: string
}

interface UpdateKeyBody {
  name?: string
}

export function handleKeysList(auth: AuthStore) {
  return (c: Context) => {
    const keys = auth.listApiKeys()
    return c.json({ keys, enabled: auth.hasAnyApiKeys() })
  }
}

export function handleKeysCreate(auth: AuthStore) {
  return async (c: Context) => {
    let body: CreateKeyBody = {}
    try { body = await c.req.json<CreateKeyBody>() } catch { /* use default */ }

    const newKey = body.key ?? `sk-${randomBytes(24).toString('hex')}`
    const accounts = auth.listAccounts()
    const boundAccountId = body.bound_account_id ?? (accounts.length > 0 ? accounts[0].id : '')

    const entry = auth.addApiKey(newKey, body.name ?? 'Unnamed Key', boundAccountId)
    return c.json({ ok: true, key: newKey, name: entry.name, bound_account_id: entry.bound_account_id }, 201)
  }
}

export function handleKeysDelete(auth: AuthStore) {
  return async (c: Context) => {
    const key = c.req.param('key')
    if (!key) return c.json({ error: 'key is required' }, 400)

    const deleted = auth.removeApiKey(key)
    if (!deleted) return c.json({ error: 'key not found' }, 404)

    return c.json({ ok: true })
  }
}

export function handleKeysUpdate(auth: AuthStore) {
  return async (c: Context) => {
    const key = c.req.param('key')
    if (!key) return c.json({ error: 'key is required' }, 400)

    let body: UpdateKeyBody = {}
    try { body = await c.req.json<UpdateKeyBody>() } catch { /* noop */ }

    if (body.name) auth.updateApiKeyName(key, body.name)
    return c.json({ ok: true })
  }
}

export function handleKeysToggle(auth: AuthStore) {
  return async (c: Context) => {
    return c.json({ ok: true, enabled: auth.hasAnyApiKeys() })
  }
}
