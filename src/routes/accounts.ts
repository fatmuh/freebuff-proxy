import type { Context } from 'hono'
import type { RunManager } from '../run-manager.js'
import type { ModelPoolManager } from '../model-pool-manager.js'
import type { AuthStore, Account } from '../auth-store.js'
import type { Config, FreeSessionResponse } from '../types.js'
import type { DB } from '../db.js'
import { resolveModelId } from '../types.js'
import type { UpstreamClient } from '../upstream.js'
import { TokenPool } from '../run-manager.js'
import { startWebAuthFlow, getAuthFlowState, removeAuthFlow, cancelAuthFlow } from '../auth.js'
import { maskToken } from '../utils.js'

interface AddAccountBody {
  token?: string
  name?: string
  email?: string
  user_id?: string
  auth_token?: string
  session_model?: string
  proxy_id?: string
}

interface UpdateAccountBody {
  name?: string
  session_model?: string
  paused?: boolean
  proxy_id?: string
}

export function handleAccountsList(auth: AuthStore) {
  return (c: Context) => {
    return c.json({ accounts: auth.listAccounts() })
  }
}

export function handleAccountsAdd(auth: AuthStore, runs: RunManager, poolManager: ModelPoolManager, config: Config, client: UpstreamClient, log: (...args: unknown[]) => void) {
  return async (c: Context) => {
    let body: AddAccountBody
    try { body = await c.req.json<AddAccountBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    // If token provided → manual add (existing behavior)
    if (body.token) {
      const id = `acct-${auth.nextId()}`
      const account: Account = {
        id,
        name: body.name ?? id,
        email: body.email ?? '',
        user_id: body.user_id ?? '',
        token: body.token,
        auth_token: body.auth_token ?? '',
        session_model: resolveModelId(body.session_model ?? 'minimax-m2.7'),
        proxy_id: body.proxy_id ?? '',
        added_at: new Date().toISOString(),
        paused: false,
        serve_status: 'active',
        account_status: 'idle',
      }

      auth.addAccount(account)
      const pool = new TokenPool(id, account.token, account.session_model, config, client, log, 'data/session-state.json', account.proxy_id)
      runs.addPool(pool)
      poolManager.addPool(account, pool)
      return c.json({ ok: true, account: { ...account, token: maskToken(account.token), auth_token: maskToken(account.auth_token) } }, 201)
    }

    // No token → trigger web auth flow
    try {
      const result = await startWebAuthFlow(log)
      return c.json({ ok: true, loginUrl: result.loginUrl, flowId: result.flowId }, 202)
    } catch (err) {
      return c.json({ error: `auth flow failed: ${err}` }, 500)
    }
  }
}

export function handleAuthFlowStatus(auth: AuthStore, runs: RunManager, poolManager: ModelPoolManager, config: Config, client: UpstreamClient, log: (...args: unknown[]) => void) {
  return async (c: Context) => {
    const flowId = c.req.param('flowId')
    if (!flowId) return c.json({ error: 'flowId is required' }, 400)

    const state = getAuthFlowState(flowId)
    if (!state) return c.json({ error: 'flow not found' }, 404)

    if (state.status === 'authenticated' && state.authToken && state.user) {
      // Auto-create account from completed auth flow
      const id = `acct-${auth.nextId()}`
      const account: Account = {
        id,
        name: state.user.name || id,
        email: state.user.email,
        user_id: state.user.id,
        token: state.authToken,
        auth_token: '',
        session_model: resolveModelId('minimax-m2.7'),
        proxy_id: '',
        added_at: new Date().toISOString(),
        paused: false,
        serve_status: 'active',
        account_status: 'idle',
      }

      auth.addAccount(account)
      const pool = new TokenPool(id, account.token, account.session_model, config, client, log, 'data/session-state.json', account.proxy_id)
      runs.addPool(pool)
      poolManager.addPool(account, pool)
      removeAuthFlow(flowId)

      return c.json({
        status: 'authenticated',
        accountId: id,
        account: { ...account, token: maskToken(account.token), auth_token: maskToken(account.auth_token) },
      })
    }

    if (state.status === 'failed') {
      removeAuthFlow(flowId)
      return c.json({ status: 'failed', error: state.error })
    }

    return c.json({ status: 'pending' })
  }
}

export function handleAuthFlowCancel() {
  return (c: Context) => {
    const flowId = c.req.param('flowId')
    if (!flowId) return c.json({ error: 'flowId is required' }, 400)
    const cancelled = cancelAuthFlow(flowId)
    if (!cancelled) return c.json({ error: 'flow not found' }, 404)
    return c.json({ ok: true, status: 'cancelled' })
  }
}

export function handleAccountsUpdate(auth: AuthStore, runs: RunManager, poolManager: ModelPoolManager) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    let body: UpdateAccountBody
    try { body = await c.req.json<UpdateAccountBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    const account = auth.getAccount(id)
    if (!account) {
      return c.json({ error: 'account not found' }, 404)
    }

    if (body.name !== undefined) account.name = body.name

    if (body.proxy_id !== undefined && body.proxy_id !== account.proxy_id) {
      account.proxy_id = body.proxy_id
      const pool = runs.getPoolByName(id)
      if (pool) pool.proxyId = body.proxy_id
    }

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
        // Resume also re-enables after Freebuff ban (serve_status inactive).
        auth.clearAccountBan(id)
        const pool = runs.getPoolByName(id)
        if (pool) {
          pool.clearBan()
          pool.setPaused(false)
          void pool.prewarmSession()
        }
      }
      // Reflect actual pause state: manual OR auto-paused
      const pool = runs.getPoolByName(id)
      const effectivePaused = account.paused || (pool?.isAutoPaused() ?? false)
      return c.json({ ok: true, account: { ...account, paused: effectivePaused, token: maskToken(account.token), auth_token: maskToken(account.auth_token) } })
    }

    if (body.session_model !== undefined && resolveModelId(body.session_model) !== account.session_model) {
      account.session_model = resolveModelId(body.session_model)
      auth.updateAccount(account)
      // Update poolManager mapping: remove from old model group, re-add under new model
      const pool = runs.getPoolByName(id)
      if (pool) {
        poolManager.removePool(id)
        poolManager.addPool(account, pool)
      }
      void runs.switchModel(id, account.session_model).catch(err => {
        console.error(`[accounts] switchModel failed:`, err)
      })
    }

    auth.updateAccount(account)
    return c.json({ ok: true, account: { ...account, token: maskToken(account.token), auth_token: maskToken(account.auth_token) } })
  }
}

export function handleAccountsDelete(auth: AuthStore, runs: RunManager, poolManager: ModelPoolManager) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    const account = auth.getAccount(id)
    if (!account) {
      return c.json({ error: 'account not found' }, 404)
    }

    const pool = runs.getPoolByName(id)
    if (pool) await pool.shutdown().catch(() => {})
    runs.removePool(id)
    poolManager.removePool(id)
    auth.removeAccount(id)
    return c.json({ ok: true })
  }
}

export function handlePools(runs: RunManager) {
  return (c: Context) => {
    return c.json({ pools: runs.snapshots() })
  }
}

export function handleRefreshQuota(auth: AuthStore, runs: RunManager) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    const account = auth.getAccount(id)
    if (!account) return c.json({ error: 'account not found' }, 404)

    const pool = runs.getPoolByName(id)
    if (!pool) return c.json({ error: 'pool not found' }, 404)

    try {
      const instanceId = pool.currentSessionInstanceId()
      const result = await pool.upstreamClient.inspectSession(pool.token, instanceId, pool.proxyId)
      const ok = result.statusCode >= 200 && result.statusCode < 300
      if (ok) {
        try {
          pool.captureUsageData(JSON.parse(result.body) as FreeSessionResponse)
        } catch {
          // The raw response is still useful to show, even if it is malformed.
        }
      }
      const rl = pool.rateLimit
      console.log(`[refresh-quota] ${pool.name}: status=${result.statusCode} ${rl?.recentCount ?? '?'}/${rl?.limit ?? '?'} reset=${rl?.resetAt ?? 'none'}`)
      return c.json({ ok, statusCode: result.statusCode, response: result.body, rateLimit: pool.rateLimit, rateLimitsByModel: pool.rateLimitsByModel })
    } catch (err) {
      console.log(`[refresh-quota] ${pool.name}: error — ${err}`)
      return c.json({ ok: false, statusCode: null, response: `refresh failed: ${err}` })
    }
  }
}

export function handleAccountUsage(auth: AuthStore, runs: RunManager, poolManager: ModelPoolManager, db: DB) {
  return (c: Context) => {
    const pools = new Map(runs.snapshots().map(s => [s.name, s]))
    const rateInfoMap = new Map(poolManager.getAccountRateInfo().map(r => [r.accountId, r]))
    const dbUsageMap = new Map<string, { requests: number; tokens_in: number; tokens_out: number }>()

    const dbUsage = db.getUsageByAccount(30) as { account_id: string | null; requests: number; tokens_in: number; tokens_out: number }[]
    for (const row of dbUsage) {
      if (row.account_id) {
        dbUsageMap.set(row.account_id, {
          requests: row.requests,
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
        })
      }
    }

    const accounts = auth.listAccountsFull()
    const usage = accounts.map(acct => {
      const snap = pools.get(acct.id)
      const rateInfo = rateInfoMap.get(acct.id)
      const dbRow = dbUsageMap.get(acct.id)
      const pool = runs.getPoolByName(acct.id)
      const effectivePaused = acct.paused || (pool?.isAutoPaused() ?? false)
      const banned = pool?.isBanned() ?? false
      const banReason = pool?.banReasonText() || (snap?.banReason ?? '')
      return {
        id: acct.id,
        name: acct.name,
        email: acct.email,
        session_model: acct.session_model,
        paused: effectivePaused,
        auto_paused: pool?.isAutoPaused() ?? false,
        banned,
        ban_reason: banReason,
        serve_status: acct.serve_status,
        account_status: banned
          ? (banReason || 'banned')
          : (snap?.sessionStatus ?? 'none'),
        session_instance_id: snap?.sessionInstanceId ?? '',
        session_expires_at: snap?.sessionExpiresAt ?? null,
        session_remaining_ms: snap?.sessionRemainingMs ?? 0,
        quota_reset_at: rateInfo?.quotaResetAt ?? snap?.quotaResetAt ?? rateInfo?.rateLimit?.resetAt ?? snap?.rateLimit?.resetAt ?? null,
        total_sessions: snap?.sessionCount ?? 0,
        rate_limit: rateInfo?.rateLimit ?? snap?.rateLimit ?? null,
        rate_limits_by_model: rateInfo?.rateLimitsByModel ?? snap?.rateLimitsByModel ?? null,
        local_usage: dbRow ?? { requests: 0, tokens_in: 0, tokens_out: 0 },
        last_error: snap?.lastError ?? '',
      }
    })

    return c.json({ accounts: usage })
  }
}
