import type { Config } from './types.js'
import { loadConfig } from './config.js'
import { UpstreamClient } from './upstream.js'
import { ModelRegistry } from './model-registry.js'
import { RunManager, TokenPool } from './run-manager.js'
import { AuthStore } from './auth-store.js'
import { DB } from './db.js'
import { createHonoApp } from './server.js'
import { generateUserAgent } from './utils.js'
import { serve } from '@hono/node-server'

export interface FreebuffProxy {
  close: () => Promise<void>
  port: number
}

export async function createServer(): Promise<FreebuffProxy> {
  const cfg = loadConfig()

  const log = (...args: unknown[]) => console.log('[Freebuff2API]', ...args)

  const userAgent = generateUserAgent()
  const client = new UpstreamClient(cfg.upstreamBaseURL, cfg.requestTimeout, userAgent)

  const registry = new ModelRegistry(client, log)
  await registry.start()

  const auth = new AuthStore('data', log)
  await auth.load()

  const runs = new RunManager(cfg, client, log)

  // Load accounts from auth.json into RunManager
  const accountTokens = auth.getAccountTokens()
  for (const acct of accountTokens) {
    const pool = new TokenPool(
      acct.id,
      acct.token,
      acct.session_model,
      cfg,
      client,
      log,
    )
    runs.addPool(pool)
  }

  // Start HTTP server immediately
  const db = new DB('data', log)

  const sessionCleanupInterval = setInterval(() => {
    db.cleanExpiredSessions()
  }, 6 * 3600_000)

  const app = createHonoApp(cfg, registry, runs, auth, db, client)

  const port = parsePort(cfg.listenAddr)
  const server = serve({
    fetch: app.fetch,
    port,
  })

  log(`listening on ${cfg.listenAddr}`)

  // Prewarm sessions in background
  runs.start(registry.agentIds()).catch(err => log('prewarm error:', err))

  return {
    port,
    close: async () => {
      log('shutting down...')
      clearInterval(sessionCleanupInterval)
      server.close()
      await runs.close()
      registry.stop()
      db.close()
    },
  }
}

function parsePort(addr: string): number {
  const parts = addr.split(':')
  const portStr = parts[parts.length - 1]
  const port = parseInt(portStr, 10)
  return isNaN(port) ? 9187 : port
}
