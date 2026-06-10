import { randomBytes } from 'node:crypto'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import type { Dispatcher } from 'undici'

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
  return 'ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser'
}

export const BUN_USER_AGENT = 'Bun/1.3.11'

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

// ─── Upstream Body Decompression ─────────────────────────────────
// undici auto-decompresses 2xx responses, but error bodies (4xx/5xx)
// may arrive as raw compressed bytes if Content-Encoding is set.
// These functions manually decompress so we can read the real error text.

/** Decompress a Buffer based on Content-Encoding header value. */
export function decompressBody(raw: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding) return raw
  const enc = contentEncoding.trim().toLowerCase()
  if (enc === 'gzip' || enc === 'x-gzip') {
    return gunzipSync(raw)
  } else if (enc === 'deflate' || enc === 'x-deflate') {
    return inflateSync(raw)
  } else if (enc === 'br') {
    return brotliDecompressSync(raw)
  }
  // unknown encoding — return as-is
  return raw
}

/**
 * Read an undici response body as decompressed text.
 * Handles Content-Encoding: gzip, deflate, br automatically.
 */
export async function readDecompressedBody(
  body: Dispatcher.ResponseData['body'],
  headers: Record<string, string | string[] | undefined>,
): Promise<string> {
  const contentEncoding = typeof headers['content-encoding'] === 'string'
    ? headers['content-encoding']
    : Array.isArray(headers['content-encoding'])
      ? headers['content-encoding'][0]
      : undefined

  const raw = Buffer.from(await body.arrayBuffer())
  const decompressed = decompressBody(raw, contentEncoding)
  return decompressed.toString('utf-8')
}

// ─── Binary / Garbled Body Detection ────────────────────────────
// If undici can't decompress the response (e.g. unsupported encoding),
// body.text() returns raw compressed bytes decoded as Latin-1/UTF-8.
// Real API error responses are >95% ASCII — a high proportion of high-byte
// chars (0x80+) and especially U+FFFD (replacement char) means garbage.

const BINARY_THRESHOLD = 0.15  // >15% high-byte chars → treat as binary

export function sanitizeBodyText(raw: string): string {
  if (!raw) return raw
  let suspicious = 0
  const len = raw.length
  for (let i = 0; i < len; i++) {
    const c = raw.charCodeAt(i)
    // Control chars (exclude common whitespace)
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) { suspicious++; continue }
    // DEL
    if (c === 0x7f) { suspicious++; continue }
    // U+FFFD replacement character — strongest signal of binary-as-text decoding
    if (c === 0xfffd) { suspicious++; continue }
    // ANY high-byte char (0x80+) — real API errors are overwhelmingly ASCII.
    // Latin-1 extended chars / garbled UTF-8 sequences land here.
    if (c >= 0x80) { suspicious++; continue }
  }
  if (suspicious / len > BINARY_THRESHOLD) {
    return `(binary body, ${raw.length} bytes — content-encoding mismatch)`
  }
  return raw
}
