import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Config } from './types.js'
import type { ModelRegistry } from './model-registry.js'
import type { RunManager } from './run-manager.js'
import type { AuthStore } from './auth-store.js'
import type { DB } from './db.js'
import type { UpstreamClient } from './upstream.js'
import type { ProxyStore } from './proxy-store.js'
import { handleModels } from './routes/models.js'
import { handleChatCompletions } from './routes/chat.js'
import { handleUsageSummary, handleUsageDaily, handleUsageByModel, handleUsageByAccount, handleUsageByApiKey, handleUsageHourly, handleUsageAnalytics } from './routes/usage.js'
import { handleRequestsList, handleRequestsPurge } from './routes/requests.js'
import { handleAuthCheck, handleAuthLogin, handleAuthLogout, dashboardAuthMiddleware } from './routes/auth.js'
import { handleAccountsList, handleAccountsAdd, handleAccountsUpdate, handleAccountsDelete, handlePools, handleAuthFlowStatus, handleAuthFlowCancel } from './routes/accounts.js'
import { handleKeysList, handleKeysCreate, handleKeysDelete, handleKeysToggle, handleKeysUpdate } from './routes/keys.js'
import { handleProxiesList, handleProxiesCreate, handleProxiesUpdate, handleProxiesDelete, handleProxiesTest } from './routes/proxies.js'
import { openAIError, containsString } from './utils.js'

type Variables = { apiKey: string }

export function createHonoApp(
  cfg: Config,
  registry: ModelRegistry,
  runs: RunManager,
  auth: AuthStore,
  db: DB,
  upstreamClient: UpstreamClient,
  proxyStore: ProxyStore,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>()
  const startedAt = new Date()

  app.use('/v1/*', async (c, next) => {
    if (!auth.isKeysEnabled()) {
      c.set('apiKey', undefined as unknown as string)
      return next()
    }

    const allKeys = auth.getAllApiKeyValues()

    const authorization = c.req.header('Authorization')?.trim() ?? ''
    if (!authorization) {
      return openAIError(401, 'missing authorization header', 'authentication_error')
    }

    const prefix = 'Bearer '
    if (!authorization.startsWith(prefix)) {
      return openAIError(401, 'invalid authorization format', 'authentication_error')
    }

    const apiKey = authorization.slice(prefix.length).trim()
    if (!containsString(allKeys, apiKey)) {
      return openAIError(401, 'invalid proxy api key', 'authentication_error')
    }

    c.set('apiKey', apiKey)
    return next()
  })

  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next()
    return dashboardAuthMiddleware(db)(c, next)
  })

  app.get('/v1/models', handleModels(registry, startedAt))
  app.all('/v1/chat/completions', handleChatCompletions(registry, runs, db, (apiKey) => auth.getApiKeyId(apiKey)))

  app.get('/api/auth/check', handleAuthCheck())
  app.post('/api/auth/login', handleAuthLogin(db))
  app.post('/api/auth/logout', handleAuthLogout(db))

  app.get('/api/accounts', handleAccountsList(auth))
  app.post('/api/accounts', handleAccountsAdd(auth, runs, cfg, upstreamClient, (...args: unknown[]) => console.log('[auth]', ...args)))
  app.get('/api/accounts/flows/:flowId/status', handleAuthFlowStatus(auth, runs, cfg, upstreamClient, (...args: unknown[]) => console.log('[auth]', ...args)))
  app.post('/api/accounts/flows/:flowId/cancel', handleAuthFlowCancel())
  app.patch('/api/accounts/:id', handleAccountsUpdate(auth, runs))
  app.delete('/api/accounts/:id', handleAccountsDelete(auth, runs))

  app.get('/api/pools', handlePools(runs))

  app.get('/api/keys', handleKeysList(auth))
  app.post('/api/keys', handleKeysCreate(auth))
  app.patch('/api/keys/toggle', handleKeysToggle(auth))
  app.delete('/api/keys/:key', handleKeysDelete(auth))
  app.patch('/api/keys/:key', handleKeysUpdate(auth))

  app.get('/api/proxies', handleProxiesList(proxyStore, auth))
  app.post('/api/proxies', handleProxiesCreate(proxyStore, upstreamClient))
  app.patch('/api/proxies/:id', handleProxiesUpdate(proxyStore, upstreamClient))
  app.delete('/api/proxies/:id', handleProxiesDelete(proxyStore, auth, upstreamClient))
  app.post('/api/proxies/:id/test', handleProxiesTest(proxyStore, upstreamClient))

  app.get('/api/usage/summary', handleUsageSummary(db))
  app.get('/api/usage/daily', handleUsageDaily(db))
  app.get('/api/usage/by-model', handleUsageByModel(db))
  app.get('/api/usage/by-account', handleUsageByAccount(db))
  app.get('/api/usage/by-key', handleUsageByApiKey(db))
  app.get('/api/usage/hourly', handleUsageHourly(db))

  app.get('/api/usage-analytics', handleUsageAnalytics(db))

  app.get('/api/requests', handleRequestsList(db))
  app.delete('/api/requests', handleRequestsPurge(db))

  app.get('/api/status', (c) => {
    const snapshots = runs.snapshots()
    const accounts = auth.listAccounts()
    const queued = snapshots.filter(p => p.sessionStatus === 'queued')
    const active = snapshots.filter(p => p.sessionStatus === 'active')
    return c.json({
      running: true,
      uptime_sec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      total_accounts: accounts.length,
      active_accounts: active.length,
      queued_accounts: queued.length,
      queues: queued.map(q => ({
        name: q.name,
        model: q.sessionModel,
        position: q.sessionPosition,
        depth: q.sessionQueueDepth,
        estimated_wait_ms: q.sessionEstWaitMs,
      })),
      sessions: active.map(a => ({
        name: a.name,
        status: a.sessionStatus,
        instanceId: a.sessionInstanceId,
        model: a.sessionModel,
        admittedAt: a.sessionAdmittedAt,
        expiresAt: a.sessionExpiresAt,
        remainingMs: a.sessionExpiresAt ? Math.max(0, new Date(a.sessionExpiresAt).getTime() - Date.now()) : 0,
      })),
    })
  })

  app.use('/*', serveStatic({ root: './dist-dashboard/' }))

  // SPA fallback: any unmatched route serves index.html so client-side routing works
  app.get('*', serveStatic({ root: './dist-dashboard/', path: 'index.html' }))

  return app
}
