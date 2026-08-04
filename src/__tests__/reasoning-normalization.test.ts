import { describe, expect, it } from 'vitest'
import { injectUpstreamMetadata } from '../routes/chat.js'

function upstreamPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(injectUpstreamMetadata(
    payload,
    'openai/gpt-5.6-luna',
    'run-1',
    'session-1',
    'openai/gpt-5.6-luna',
    'trace-1',
  )) as Record<string, unknown>
}

describe('reasoning request normalization', () => {
  it('uses Chat Completions reasoning_effort and removes a conflicting Responses field', () => {
    const payload = upstreamPayload({
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'low',
      reasoning: { effort: 'high', summary: 'auto' },
    })

    expect(payload.reasoning_effort).toBe('low')
    expect(payload).not.toHaveProperty('reasoning')
  })

  it('converts a Responses-style effort when it is the only effort supplied', () => {
    const payload = upstreamPayload({
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'medium', summary: 'auto' },
    })

    expect(payload.reasoning_effort).toBe('medium')
    expect(payload).not.toHaveProperty('reasoning')
  })

  it('converts a dotted Responses-style effort key', () => {
    const payload = upstreamPayload({
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hello' }],
      'reasoning.effort': 'high',
    })

    expect(payload.reasoning_effort).toBe('high')
    expect(payload).not.toHaveProperty('reasoning.effort')
  })
})
