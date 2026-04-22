import type { Config } from './types.js'
import { loadConfig } from './config.js'
import { UpstreamClient } from './upstream.js'
import { ModelRegistry } from './model-registry.js'
import { RunManager } from './run-manager.js'
import { BindingStore } from './binding-store.js'
import { createHonoApp } from './server.js'
import { generateUserAgent } from './utils.js'
import { serve } from '@hono/node-server'
import { statSync } from 'node:fs'

export interface FreebuffProxy {
  close: () => Promise<void>
  port: number
}

// ─── Create Server ─────────────────────────────────────────────
// Orchestrates all components and starts the HTTP server.

export async function createServer(configOverrides?: Partial<Config> & { configPath?: string }): Promise<FreebuffProxy> {
  // Load config
  const configPath = configOverrides?.configPath ?? autoDetectConfig()
  const cfg = configPath
    ? await loadConfig(configPath)
    : await loadConfig() // env-only

  // Apply overrides
  if (configOverrides?.listenAddr) cfg.listenAddr = configOverrides.listenAddr

  const log = (...args: unknown[]) => console.log('[Freebuff2API]', ...args)

  // Create upstream client
  const userAgent = generateUserAgent()
  const client = new UpstreamClient(cfg.upstreamBaseURL, cfg.requestTimeout, userAgent)

  // Start model registry
  const registry = new ModelRegistry(client, log)
  await registry.start()

  // Create run manager + prewarm
  const runs = new RunManager(cfg, client, log)
  await runs.start(registry.agentIds())

  // Load binding store
  const bindings = new BindingStore('data', log)
  await bindings.load()

  // Create Hono app
  const app = createHonoApp(cfg, registry, runs, bindings)

  // Start HTTP server using hono's node-server adapter
  const port = parsePort(cfg.listenAddr)
  const server = serve({
    fetch: app.fetch,
    port,
  })

  log(`listening on ${cfg.listenAddr}`)

  return {
    port,
    close: async () => {
      log('shutting down...')
      server.close()
      await runs.close()
      registry.stop()
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function autoDetectConfig(): string | undefined {
  try {
    statSync('config.json')
    return 'config.json'
  } catch {
    return undefined
  }
}

function parsePort(addr: string): number {
  const parts = addr.split(':')
  const portStr = parts[parts.length - 1]
  const port = parseInt(portStr, 10)
  return isNaN(port) ? 9187 : port
}
