import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Config } from './types.js'
import type { ModelRegistry } from './model-registry.js'
import type { RunManager } from './run-manager.js'
import type { BindingStore } from './binding-store.js'
import type { AuthStore } from './auth-store.js'
import type { DB } from './db.js'
import { handleModels } from './routes/models.js'
import { handleChatCompletions } from './routes/chat.js'
import { handleBind, handleUnbind, handleStatus } from './routes/admin.js'
import { handleUsageSummary, handleUsageDaily, handleUsageByModel, handleUsageByAccount } from './routes/usage.js'
import { handleRequestsList } from './routes/requests.js'
import { handleAuthCheck, handleAuthLogin, handleAuthLogout, dashboardAuthMiddleware } from './routes/auth.js'
import { handleAccountsList, handleAccountsAdd, handleAccountsUpdate, handleAccountsDelete, handlePools } from './routes/accounts.js'
import { handleBindingsList, handleBindingsCreate, handleBindingsDelete } from './routes/bindings.js'
import { handleKeysList, handleKeysCreate, handleKeysDelete, handleKeysUpdate } from './routes/keys.js'
import { openAIError, containsString } from './utils.js'

type Variables = { apiKey: string }

export function createHonoApp(
  cfg: Config,
  registry: ModelRegistry,
  runs: RunManager,
  bindings: BindingStore,
  auth: AuthStore,
  db: DB,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>()
  const startedAt = new Date()

  app.use('/v1/*', async (c, next) => {
    const allKeys = auth.getAllApiKeyValues()
    if (allKeys.length === 0) {
      c.set('apiKey', undefined as unknown as string)
      return next()
    }

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
  app.all('/v1/chat/completions', handleChatCompletions(registry, runs, bindings, db))

  app.post('/admin/bind', handleBind(bindings))
  app.post('/admin/unbind', handleUnbind(bindings))
  app.get('/admin/status', handleStatus(bindings, runs, startedAt))

  app.get('/api/auth/check', handleAuthCheck())
  app.post('/api/auth/login', handleAuthLogin(db))
  app.post('/api/auth/logout', handleAuthLogout(db))

  app.get('/api/accounts', handleAccountsList(auth))
  app.post('/api/accounts', handleAccountsAdd(auth))
  app.patch('/api/accounts/:id', handleAccountsUpdate(auth, runs))
  app.delete('/api/accounts/:id', handleAccountsDelete(auth, runs))

  app.get('/api/pools', handlePools(runs))

  app.get('/api/bindings', handleBindingsList(bindings, auth))
  app.post('/api/bindings', handleBindingsCreate(bindings))
  app.delete('/api/bindings/:key', handleBindingsDelete(bindings))

  app.get('/api/keys', handleKeysList(auth))
  app.post('/api/keys', handleKeysCreate(auth))
  app.delete('/api/keys/:key', handleKeysDelete(auth))
  app.patch('/api/keys/:key', handleKeysUpdate(auth))

  app.get('/api/usage/summary', handleUsageSummary(db))
  app.get('/api/usage/daily', handleUsageDaily(db))
  app.get('/api/usage/by-model', handleUsageByModel(db))
  app.get('/api/usage/by-account', handleUsageByAccount(db))

  app.get('/api/requests', handleRequestsList(db))

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
        position: q.sessionPosition,
        depth: q.sessionQueueDepth,
        estimated_wait_ms: q.sessionEstWaitMs,
      })),
    })
  })

  app.use('/*', serveStatic({ root: './dist-dashboard/' }))

  return app
}
