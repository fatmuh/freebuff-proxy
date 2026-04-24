import { request } from 'undici'
import { randomBytes, createHash } from 'node:crypto'
import { sleep } from './utils.js'

// ─── Auth Flow ─────────────────────────────────────────────────
// Handles the CLI auth flow against freebuff.com:
// 1. Generate fingerprint → POST /api/auth/cli/code
// 2. Show login URL to user
// 3. Poll GET /api/auth/cli/status every 3s until authenticated
// 4. Return the authToken from the user object

interface AuthCodeResponse {
  fingerprintId: string
  fingerprintHash: string
  loginUrl: string
  expiresAt: number
}

interface AuthStatusUser {
  id: string
  name: string
  email: string
  authToken: string
  fingerprintId: string
  fingerprintHash: string
}

interface AuthStatusResponse {
  user: AuthStatusUser
  message: string
}

// ─── Fingerprint Generation ────────────────────────────────────
// Generate a fingerprint matching: enhanced-{base64url-random}
// The hash is SHA-256 of the fingerprintId

function generateFingerprintId(): string {
  const buf = randomBytes(32)
  const b64 = buf.toString('base64url')
  return `enhanced-${b64}`
}

function hashFingerprint(fingerprintId: string): string {
  return createHash('sha256').update(fingerprintId).digest('hex')
}

// ─── HTTP Helpers ──────────────────────────────────────────────

const AUTH_BASE = 'https://freebuff.com'
const AUTH_USER_AGENT = 'Bun/1.3.11'

async function authPost(path: string, body: unknown): Promise<{ statusCode: number; data: unknown }> {
  const url = `${AUTH_BASE}${path}`
  const { statusCode, body: respBody } = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': '*/*',
      'user-agent': AUTH_USER_AGENT,
    },
    body: JSON.stringify(body),
  } as Record<string, unknown>)
  const text = await respBody.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text }
  return { statusCode, data }
}

async function authGet(path: string): Promise<{ statusCode: number; data: unknown }> {
  const url = `${AUTH_BASE}${path}`
  const { statusCode, body: respBody } = await request(url, {
    method: 'GET',
    headers: {
      'accept': '*/*',
      'user-agent': AUTH_USER_AGENT,
    },
  } as Record<string, unknown>)
  const text = await respBody.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text }
  return { statusCode, data }
}

// ─── Main Auth Flow (CLI — blocking) ──────────────────────────

export async function authenticate(log: (...args: unknown[]) => void): Promise<string> {
  const fingerprintId = generateFingerprintId()
  const fingerprintHash = hashFingerprint(fingerprintId)

  // Step 1: POST /api/auth/cli/code → get login URL
  log('requesting login code...')
  const codeResp = await authPost('/api/auth/cli/code', { fingerprintId })

  if (codeResp.statusCode !== 200) {
    throw new Error(`auth: failed to get login code (status ${codeResp.statusCode}): ${JSON.stringify(codeResp.data)}`)
  }

  const codeData = codeResp.data as AuthCodeResponse
  const loginUrl = codeData.loginUrl
  const expiresAt = codeData.expiresAt
  const serverFingerprintHash = codeData.fingerprintHash

  if (!loginUrl) {
    throw new Error(`auth: no loginUrl in response: ${JSON.stringify(codeData)}`)
  }

  // Step 2: Show login URL to user
  log('')
  log('╔══════════════════════════════════════════════════════════════╗')
  log('║  Please log in to authenticate:                            ║')
  log('╚══════════════════════════════════════════════════════════════╝')
  log('')
  log(`  ${loginUrl}`)
  log('')
  log('  Waiting for authentication...')

  // Step 3: Poll GET /api/auth/cli/status every 3s
  const pollInterval = 3_000
  const expiresTime = expiresAt || Date.now() + 10 * 60 * 1000
  const statusPath = `/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(serverFingerprintHash)}&expiresAt=${expiresAt}`

  while (Date.now() < expiresTime) {
    await sleep(pollInterval)

    const statusResp = await authGet(statusPath)

    if (statusResp.statusCode === 200) {
      const statusData = statusResp.data as AuthStatusResponse
      if (statusData.user?.authToken) {
        log('')
        log(`auth: ✅ authenticated as ${statusData.user.name} (${statusData.user.email})`)
        return statusData.user.authToken
      }
    }

    // 401 = not yet authenticated, keep polling
    if (statusResp.statusCode !== 401) {
      log(`auth: unexpected status ${statusResp.statusCode}, retrying...`)
    }
  }

  throw new Error('auth: timed out waiting for login')
}

// ─── Web Auth Flow (non-blocking — returns loginUrl, polls in background) ──

export interface WebAuthFlowResult {
  flowId: string
  loginUrl: string
}

export interface WebAuthFlowState {
  flowId: string
  loginUrl: string
  status: 'pending' | 'authenticated' | 'failed'
  authToken: string | null
  user: { name: string; email: string; id: string } | null
  error: string | null
}

const activeFlows = new Map<string, WebAuthFlowState>()

export function startWebAuthFlow(log: (...args: unknown[]) => void): Promise<WebAuthFlowResult> {
  const fingerprintId = generateFingerprintId()
  const fingerprintHash = hashFingerprint(fingerprintId)
  const flowId = `flow-${randomBytes(8).toString('hex')}`

  return (async () => {
    const codeResp = await authPost('/api/auth/cli/code', { fingerprintId })

    if (codeResp.statusCode !== 200) {
      throw new Error(`auth: failed to get login code (status ${codeResp.statusCode}): ${JSON.stringify(codeResp.data)}`)
    }

    const codeData = codeResp.data as AuthCodeResponse
    const loginUrl = codeData.loginUrl
    const expiresAt = codeData.expiresAt
    const serverFingerprintHash = codeData.fingerprintHash

    if (!loginUrl) {
      throw new Error(`auth: no loginUrl in response: ${JSON.stringify(codeData)}`)
    }

    const state: WebAuthFlowState = {
      flowId,
      loginUrl,
      status: 'pending',
      authToken: null,
      user: null,
      error: null,
    }
    activeFlows.set(flowId, state)

    // Background poll
    const pollInterval = 3_000
    const expiresTime = expiresAt || Date.now() + 10 * 60 * 1000
    const statusPath = `/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(serverFingerprintHash)}&expiresAt=${expiresAt}`

    const poll = async () => {
      while (Date.now() < expiresTime) {
        await sleep(pollInterval)
        if (state.status !== 'pending') return

        try {
          const statusResp = await authGet(statusPath)
          log(`auth flow ${flowId}: poll status ${statusResp.statusCode}`)
          if (statusResp.statusCode === 200) {
            const statusData = statusResp.data as AuthStatusResponse
            if (statusData.user?.authToken) {
              state.status = 'authenticated'
              state.authToken = statusData.user.authToken
              state.user = { name: statusData.user.name, email: statusData.user.email, id: statusData.user.id }
              log(`auth flow ${flowId}: ✅ authenticated as ${statusData.user.name}`)
              return
            }
          }
          if (statusResp.statusCode === 307) {
            log(`auth flow ${flowId}: got 307 redirect — AUTH_BASE may still point to www.freebuff.com`)
          }
        } catch (err) {
          log(`auth flow ${flowId}: poll error: ${err}`)
        }
      }
      state.status = 'failed'
      state.error = 'timed out waiting for login'
    }

    void poll()

    return { flowId, loginUrl }
  })()
}

export function getAuthFlowState(flowId: string): WebAuthFlowState | undefined {
  return activeFlows.get(flowId)
}

export function removeAuthFlow(flowId: string): void {
  activeFlows.delete(flowId)
}

export function cancelAuthFlow(flowId: string): boolean {
  const state = activeFlows.get(flowId)
  if (!state) return false
  state.status = 'failed'
  state.error = 'cancelled by user'
  activeFlows.delete(flowId)
  return true
}
