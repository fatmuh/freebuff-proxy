import { randomBytes } from 'node:crypto'

// ─── ID Generators ─────────────────────────────────────────────

// Matches the official SDK: Math.random().toString(36).substring(2, 15)
// → ~13-char base-36 alphanumeric string
export function generateClientSessionId(): string {
  const buf = randomBytes(10)
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const out: string[] = []
  for (let i = 0; i < 13; i++) {
    out.push(alphabet[buf[i % buf.length] % 36])
  }
  return out.join('')
}

export function generateUserAgent(): string {
  return 'ai-sdk/openai-compatible/1.0.25/codebuff'
}

// ─── Sleep ─────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── String Helpers ────────────────────────────────────────────

export function containsString(values: string[], needle: string): boolean {
  return values.includes(needle)
}

// ─── OpenAI Error Formatting ───────────────────────────────────
// Returns standard OpenAI-style error JSON

export function openAIError(
  statusCode: number,
  message: string,
  errorType: string,
  code?: string,
): Response {
  if (!message) message = statusText(statusCode)
  const error: Record<string, string> = { message, type: errorType }
  if (code) error.code = code

  return Response.json({ error }, { status: statusCode })
}

export function statusText(code: number): string {
  const texts: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  }
  return texts[code] || 'Error'
}

// ─── Session Error Detection ──────────────────────────────────
// Same strings as Go version

const SESSION_INVALID_ERRORS = new Set([
  'freebuff_update_required',
  'waiting_room_required',
  'waiting_room_queued',
  'session_superseded',
  'session_expired',
  'session_model_mismatch',
])

export function isSessionInvalid(statusCode: number, errorBody: string): boolean {
  if (statusCode < 400) return false
  try {
    const parsed = JSON.parse(errorBody)
    const err = parsed.error ?? parsed.Error
    if (typeof err === 'string') return SESSION_INVALID_ERRORS.has(err.trim())
  } catch { /* not JSON */ }
  return false
}

export function isRunInvalid(statusCode: number, errorBody: string): boolean {
  if (statusCode !== 400) return false
  const lower = errorBody.toLowerCase()
  return lower.includes('runid not found') || lower.includes('runid not running')
}

// ─── Upstream Error Extraction ─────────────────────────────────

export interface UpstreamError {
  message: string
  type: string
  code: string
}

export function extractUpstreamError(body: string): UpstreamError {
  let message = body.trim()
  let errorType = 'upstream_error'
  let code = ''

  try {
    const parsed = JSON.parse(body)
    const rawError = parsed.error
    if (typeof rawError === 'string') {
      code = rawError
    } else if (rawError && typeof rawError === 'object') {
      if (rawError.message) message = rawError.message
      if (rawError.type) errorType = rawError.type
      if (rawError.code) code = rawError.code
    }
    if (parsed.message && typeof parsed.message === 'string') message = parsed.message
  } catch { /* not JSON */ }

  return { message, type: errorType, code }
}

// ─── Deep Clone for Plain Objects ──────────────────────────────

export function cloneMap(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input))
}

export function cloneArray(input: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(input))
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '****'
  return token.slice(0, 4) + '...' + token.slice(-4)
}
