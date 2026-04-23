import type { Context } from 'hono'
import type { RunManager } from '../run-manager.js'
import type { AuthStore, Account } from '../auth-store.js'
import { maskToken } from '../utils.js'

interface AddAccountBody {
  token: string
  name?: string
  email?: string
  user_id?: string
  auth_token?: string
  session_model?: string
}

interface UpdateAccountBody {
  name?: string
  session_model?: string
  paused?: boolean
}

export function handleAccountsList(auth: AuthStore) {
  return (c: Context) => {
    return c.json({ accounts: auth.listAccounts() })
  }
}

export function handleAccountsAdd(auth: AuthStore) {
  return async (c: Context) => {
    let body: AddAccountBody
    try { body = await c.req.json<AddAccountBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    if (!body.token) {
      return c.json({ error: 'token is required' }, 400)
    }

    const id = `acct-${auth.nextId()}`
    const account: Account = {
      id,
      name: body.name ?? id,
      email: body.email ?? '',
      user_id: body.user_id ?? '',
      token: body.token,
      auth_token: body.auth_token ?? '',
      session_model: body.session_model ?? 'minimax/minimax-m2.7',
      added_at: new Date().toISOString(),
      paused: false,
    }

    auth.addAccount(account)
    return c.json({ ok: true, account: { ...account, token: maskToken(account.token), auth_token: maskToken(account.auth_token) } }, 201)
  }
}

export function handleAccountsUpdate(auth: AuthStore, runs: RunManager) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    let body: UpdateAccountBody
    try { body = await c.req.json<UpdateAccountBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    const account = auth.getAccount(id)
    if (!account) {
      return c.json({ error: 'account not found' }, 404)
    }

    if (body.name !== undefined) account.name = body.name

    if (body.paused !== undefined && body.paused !== account.paused) {
      account.paused = body.paused
      auth.updateAccount(account)
      if (body.paused) {
        const pool = runs.getPoolByName(id)
        if (pool) {
          pool.setPaused(true)
          await pool.endSessionNow().catch(() => {})
        }
      } else {
        const pool = runs.getPoolByName(id)
        if (pool) pool.setPaused(false)
      }
      return c.json({ ok: true, account: { ...account, token: maskToken(account.token), auth_token: maskToken(account.auth_token) } })
    }

    if (body.session_model !== undefined && body.session_model !== account.session_model) {
      account.session_model = body.session_model
      auth.updateAccount(account)
      void runs.switchModel(id, body.session_model).catch(err => {
        console.error(`[accounts] switchModel failed:`, err)
      })
    }

    auth.updateAccount(account)
    return c.json({ ok: true, account: { ...account, token: maskToken(account.token), auth_token: maskToken(account.auth_token) } })
  }
}

export function handleAccountsDelete(auth: AuthStore, runs: RunManager) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    const account = auth.getAccount(id)
    if (!account) {
      return c.json({ error: 'account not found' }, 404)
    }

    const pool = runs.getPoolByName(id)
    if (pool) await pool.shutdown().catch(() => {})
    runs.removePool(id)
    auth.removeAccount(id)
    return c.json({ ok: true })
  }
}

export function handlePools(runs: RunManager) {
  return (c: Context) => {
    return c.json({ pools: runs.snapshots() })
  }
}
