import type { Config } from './types.js'
import { loadConfig } from './config.js'
import { UpstreamClient } from './upstream.js'
import { ModelRegistry } from './model-registry.js'
import { RunManager, TokenPool } from './run-manager.js'
import { ModelPoolManager } from './model-pool-manager.js'
import { AuthStore } from './auth-store.js'
import { ProxyStore } from './proxy-store.js'
import { DB } from './db.js'
import { createHonoApp } from './server.js'
import { AdsSpoof } from './ads-spoof.js'
import { FreebuffClientHeaders } from './freebuff-client-headers.js'
import { BUN_USER_AGENT_FALLBACK } from './utils.js'
import { serve } from '@hono/node-server'

export interface FreebuffProxy {
  close: () => Promise<void>
  port: number
}

export async function createServer(): Promise<FreebuffProxy> {
  const cfg = loadConfig()

  const log = (...args: unknown[]) => console.log('[Freebuff2API]', ...args)

  const client = new UpstreamClient(cfg.upstreamBaseURL, cfg.requestTimeout, BUN_USER_AGENT_FALLBACK)

  const clientHeaders = new FreebuffClientHeaders(client, log)
  await clientHeaders.start()
  client.setUserAgents({
    sessionUserAgent: () => clientHeaders.sessionUserAgent(),
    chatUserAgent: () => clientHeaders.chatUserAgent(),
  })

  const registry = new ModelRegistry(client, log)
  await registry.start()


  const auth = new AuthStore('data', log)
  await auth.load()

  const proxyStore = new ProxyStore('data', log)
  await proxyStore.load()

  // Auto-import HTTP_PROXY env var into ProxyStore if set and not already imported
  if (cfg.httpProxy && !proxyStore.getProxy('env-default')) {
    const envUrl = new URL(cfg.httpProxy)
    const entry = {
      id: 'env-default',
      name: 'Env HTTP_PROXY',
      type: 'http' as const,
      host: envUrl.hostname,
      port: parseInt(envUrl.port, 10) || 8080,
      username: decodeURIComponent(envUrl.username || ''),
      password: decodeURIComponent(envUrl.password || ''),
      created_at: new Date().toISOString(),
    }
    proxyStore.addProxy(entry)
    log('auto-imported HTTP_PROXY env var as proxy', entry.id)
  }

  // Register all proxy dispatchers with upstream client
  for (const proxy of proxyStore.listProxies()) {
    client.registerProxy(proxy)
  }

  const runs = new RunManager(cfg, client, log)
  const poolManager = new ModelPoolManager(cfg, client, log)
  const adsSpoof = new AdsSpoof(cfg.upstreamBaseURL, client, log, {
    getCliUserAgent: () => clientHeaders.adsUserAgent(),
  })
  runs.setAdsSpoof(adsSpoof)
  runs.setOnAccountBanned((poolName, reason) => {
    auth.markAccountBanned(poolName, reason)
  })

  // Load accounts from auth.json into RunManager and ModelPoolManager
  const accountTokens = auth.getAccountTokens()
  for (const acct of accountTokens) {
    const pool = new TokenPool(
      acct.id,
      acct.token,
      acct.session_model,
      cfg,
      client,
      log,
      'data/session-state.json',
      acct.proxy_id,
    )
    // Persist ban across restarts: serve_status inactive from prior ban.
    const fullAcct = auth.getAccount(acct.id)
    if (fullAcct?.serve_status === 'inactive') {
      pool.markBanned('banned')
    }
    if (fullAcct?.paused) {
      pool.setPaused(true)
    }
    runs.addPool(pool)
    if (fullAcct) poolManager.addPool(fullAcct, pool)
  }

  // Start HTTP server immediately
  const db = new DB('data', log)

  const sessionCleanupInterval = setInterval(() => {
    db.cleanExpiredSessions()
  }, 6 * 3600_000)

  const app = createHonoApp(cfg, registry, runs, poolManager, auth, db, client, proxyStore)

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
      clientHeaders.stop()
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
