#!/usr/bin/env node

import { createServer } from './index.js'

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

  try {
    const server = await createServer({ configPath })
    console.log('[cli] server started on port', server.port)

    // Graceful shutdown
    const shutdown = async () => {
      console.log('[cli] shutting down...')
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

main().catch(err => { console.error('[cli] fatal:', err); process.exit(1) })
