// In-memory free-mode rate limit gate for the whole proxy.
// No DB / disk persistence — cleared on process restart.

export interface FreeModeBlockStatus {
  blocked: boolean
  until: string | null
  remaining_ms: number
  remaining_sec: number
  message: string
}

let blockedUntilMs = 0
let lastMessage = ''

/** Parse "Try again in N minutes/seconds" from free-mode error text. */
export function parseFreeModeRetryMs(errorBody: string): number | null {
  const text = errorBody.trim()
  if (!text) return null

  // Prefer explicit retry window: "Try again in 7 minutes."
  const tryAgain =
    text.match(/try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/i) ??
    text.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/i)
  if (tryAgain) {
    const n = Number(tryAgain[1])
    if (!Number.isFinite(n) || n <= 0) return null
    const unit = tryAgain[2].toLowerCase()
    if (unit.startsWith('m')) return Math.ceil(n * 60_000)
    return Math.ceil(n * 1000)
  }

  // Fallback: "(30 minutes limit)" when no remaining time is present.
  const windowMatch = text.match(/\((\d+(?:\.\d+)?)\s*(minutes?|mins?|min|m|seconds?|secs?|sec|s)\s+limit\)/i)
  if (windowMatch) {
    const n = Number(windowMatch[1])
    if (!Number.isFinite(n) || n <= 0) return null
    const unit = windowMatch[2].toLowerCase()
    if (unit.startsWith('m')) return Math.ceil(n * 60_000)
    return Math.ceil(n * 1000)
  }

  return null
}

/** Activate / extend global free-mode block. Memory only. */
export function blockFreeMode(durationMs: number, message?: string): FreeModeBlockStatus {
  const ms = Math.max(0, Math.floor(durationMs))
  if (ms > 0) {
    const until = Date.now() + ms
    if (until > blockedUntilMs) blockedUntilMs = until
  }
  if (message) {
    let clean = message.trim()
    try {
      const parsed = JSON.parse(clean) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message.trim()) clean = parsed.message.trim()
    } catch {
      // keep raw text
    }
    lastMessage = clean
  }
  return getFreeModeBlockStatus()
}

/** True while free-mode global block is active. */
export function isFreeModeBlocked(): boolean {
  return remainingFreeModeMs() > 0
}

export function remainingFreeModeMs(): number {
  if (blockedUntilMs <= 0) return 0
  const left = blockedUntilMs - Date.now()
  if (left <= 0) {
    blockedUntilMs = 0
    return 0
  }
  return left
}

export function getFreeModeBlockStatus(): FreeModeBlockStatus {
  const remaining_ms = remainingFreeModeMs()
  const blocked = remaining_ms > 0
  let message = ''
  if (blocked) {
    if (lastMessage) {
      message = lastMessage
    } else {
      const totalSec = Math.max(0, Math.ceil(remaining_ms / 1000))
      const m = Math.floor(totalSec / 60)
      const s = totalSec % 60
      const left = m <= 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m ${s}s`
      message = `Free mode rate limit active. Try again in ${left}.`
    }
  }
  return {
    blocked,
    until: blocked ? new Date(blockedUntilMs).toISOString() : null,
    remaining_ms,
    remaining_sec: Math.ceil(remaining_ms / 1000),
    message,
  }
}

/** Test helper — clear gate. */
export function clearFreeModeBlock(): void {
  blockedUntilMs = 0
  lastMessage = ''
}

