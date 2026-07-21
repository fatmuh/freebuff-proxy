import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blockFreeMode,
  clearFreeModeBlock,
  getFreeModeBlockStatus,
  isFreeModeBlocked,
  parseFreeModeRetryMs,
  remainingFreeModeMs,
} from '../free-mode-gate.js'

afterEach(() => {
  clearFreeModeBlock()
  vi.useRealTimers()
})

describe('parseFreeModeRetryMs', () => {
  it('parses Try again in N minutes', () => {
    const body =
      '{"error":"free_mode_rate_limited","message":"Free mode rate limit exceeded (30 minutes limit). Try again in 7 minutes."}'
    expect(parseFreeModeRetryMs(body)).toBe(7 * 60_000)
  })

  it('parses seconds unit', () => {
    expect(parseFreeModeRetryMs('Try again in 45 seconds.')).toBe(45_000)
  })

  it('falls back to window limit when no remaining time', () => {
    expect(parseFreeModeRetryMs('Free mode rate limit exceeded (30 minutes limit).')).toBe(30 * 60_000)
  })

  it('returns null when no duration found', () => {
    expect(parseFreeModeRetryMs('free_mode_rate_limited')).toBeNull()
  })
})

describe('free mode memory block', () => {
  it('blocks for parsed duration and expires', () => {
    vi.useFakeTimers()
    const status = blockFreeMode(80, 'try again in a moment')
    expect(status.blocked).toBe(true)
    expect(isFreeModeBlocked()).toBe(true)
    expect(remainingFreeModeMs()).toBeGreaterThan(0)
    expect(getFreeModeBlockStatus().message).toContain('try again')

    vi.advanceTimersByTime(100)
    expect(isFreeModeBlocked()).toBe(false)
    expect(getFreeModeBlockStatus().blocked).toBe(false)
  })

  it('extends only when later until is longer', () => {
    vi.useFakeTimers()
    blockFreeMode(1_000, 'first')
    const firstUntil = getFreeModeBlockStatus().until
    blockFreeMode(100, 'shorter')
    expect(getFreeModeBlockStatus().until).toBe(firstUntil)
    blockFreeMode(5_000, 'longer')
    const laterUntil = getFreeModeBlockStatus().until
    expect(laterUntil).not.toBe(firstUntil)
    expect(new Date(laterUntil!).getTime()).toBeGreaterThan(new Date(firstUntil!).getTime())
  })
})
