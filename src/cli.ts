#!/usr/bin/env node

import { createServer } from './index.js'
import { loadConfig } from './config.js'
import { authenticate } from './auth.js'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

// ─── CLI Entry Point ──────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  let configPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[i + 1]
      i++
    }
  }

  // Auto-detect config.json in CWD if no flag given
  if (!configPath) {
    try {
      const { statSync } = await import('node:fs')
      statSync('config.json')
      configPath = 'config.json'
    } catch { /* no config.json, use env only */ }
  }

  const log = (...a: unknown[]) => console.log('[cli]', ...a)

  try {
    // Load config to check if AUTH_TOKENS exist
    const cfg = await loadConfig(configPath)

    // If no auth tokens configured, run the auth flow
    if (cfg.authTokens.length === 0) {
      log('no AUTH_TOKENS configured, starting login flow...')
      const token = await authenticate(log)

      // Save the token to config.json for reuse
      if (configPath) {
        await saveTokenToConfig(configPath, token, log)
      } else {
        // No config file — write one with defaults + the token
        configPath = 'config.json'
        await saveTokenToNewConfig(configPath, token, log)
      }

      // Set the token in the env so createServer picks it up
      process.env.AUTH_TOKENS = token
    }

    const server = await createServer({ configPath })
    log('server started on port', server.port)

    // Graceful shutdown
    const shutdown = async () => {
      log('shutting down...')
      await server.close()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    console.error('[cli] fatal:', err)
    process.exit(1)
  }
}

// ─── Config Persistence ───────────────────────────────────────

async function saveTokenToConfig(configPath: string, token: string, log: (...a: unknown[]) => void): Promise<void> {
  const absPath = resolve(configPath)
  const raw = await readFile(absPath, 'utf-8')
  const data = JSON.parse(raw)
  const existing: string[] = data.AUTH_TOKENS ?? []
  if (!existing.includes(token)) {
    existing.push(token)
  }
  data.AUTH_TOKENS = existing
  await writeFile(absPath, JSON.stringify(data, null, 2) + '\n')
  log('saved auth token to', absPath)
}

async function saveTokenToNewConfig(configPath: string, token: string, log: (...a: unknown[]) => void): Promise<void> {
  const absPath = resolve(configPath)
  await mkdir(dirname(absPath), { recursive: true })
  const data = {
    LISTEN_ADDR: ':9187',
    UPSTREAM_BASE_URL: 'https://www.codebuff.com',
    AUTH_TOKENS: [token],
    ROTATION_INTERVAL: '6h',
    REQUEST_TIMEOUT: '15m',
    API_KEYS: [],
    HTTP_PROXY: '',
  }
  await writeFile(absPath, JSON.stringify(data, null, 2) + '\n')
  log('created config with auth token at', absPath)
}

main().catch(err => { console.error('[cli] fatal:', err); process.exit(1) })
