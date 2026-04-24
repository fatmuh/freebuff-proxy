#!/usr/bin/env node

import 'dotenv/config'
import { createServer } from './index.js'
import { authenticate } from './auth.js'
import { AuthStore } from './auth-store.js'
import { resolveModelId } from './types.js'

// ─── CLI Entry Point ──────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[cli] uncaught exception (non-fatal):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[cli] unhandled rejection (non-fatal):', reason)
})

async function main() {
  const log = (...a: unknown[]) => console.log('[cli]', ...a)

  try {
    // Load auth store early to check if accounts exist
    const auth = new AuthStore('data', log)
    await auth.load()

    // If no accounts, run the CLI auth flow and save to auth.json
    if (auth.listAccountsFull().length === 0) {
      log('no accounts configured, starting login flow...')
      const token = await authenticate(log)

      const id = `acct-${auth.nextId()}`
      auth.addAccount({
        id,
        name: id,
        email: '',
        user_id: '',
        token,
        auth_token: '',
        session_model: resolveModelId('minimax-m2.7'),
        added_at: new Date().toISOString(),
        paused: false,
      })
    }

    const server = await createServer()
    log('server started on port', server.port)

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

main().catch(err => { console.error('[cli] fatal:', err); process.exit(1) })
