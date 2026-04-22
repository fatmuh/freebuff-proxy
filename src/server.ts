import { Hono } from 'hono'
import type { Config } from './types.js'
import type { ModelRegistry } from './model-registry.js'
import type { RunManager } from './run-manager.js'
import type { BindingStore } from './binding-store.js'
import { handleModels } from './routes/models.js'
import { handleChatCompletions } from './routes/chat.js'
import { handleBind, handleUnbind, handleStatus } from './routes/admin.js'
import { openAIError, containsString } from './utils.js'

// ─── Create Hono App ──────────────────────────────────────────

export function createHonoApp(
  cfg: Config,
  registry: ModelRegistry,
  runs: RunManager,
  bindings: BindingStore,
): Hono<{ Variables: { apiKey: string } }> {
  const app = new Hono<{ Variables: { apiKey: string } }>()
  const startedAt = new Date()

  // ─── Auth Middleware ─────────────────────────────────────────
  app.use('*', async (c, next) => {
    if (cfg.apiKeys.length === 0) {
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
    if (!containsString(cfg.apiKeys, apiKey)) {
      return openAIError(401, 'invalid proxy api key', 'authentication_error')
    }

    c.set('apiKey', apiKey)
    return next()
  })

  // ─── Routes ──────────────────────────────────────────────────

  // OpenAI-compatible endpoints
  app.get('/v1/models', handleModels(registry, startedAt))
  app.all('/v1/chat/completions', handleChatCompletions(registry, runs, bindings))

  // Admin endpoints
  app.post('/admin/bind', handleBind(bindings, runs))
  app.post('/admin/unbind', handleUnbind(bindings))
  app.get('/admin/status', handleStatus(bindings, runs, startedAt))

  return app
}
