import { describe, expect, it, vi } from 'vitest'
import { handleChatCompletions } from '../routes/chat.js'
import type { RunLease, TokenPool } from '../run-manager.js'

function responseBody(value: unknown) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  return { arrayBuffer: vi.fn(async () => bytes) }
}

function lease(account: string, upstreamResponse: { statusCode: number; body: unknown }): RunLease {
  const pool = {
    name: account,
    sessionModel: 'model-a',
    traceSessionId: 'trace-1',
    token: `token-${account}`,
    proxyId: '',
    upstreamClient: {
      chatCompletions: vi.fn(async () => ({
        statusCode: upstreamResponse.statusCode,
        headers: { 'content-type': 'application/json' },
        body: responseBody(upstreamResponse.body),
      })),
    },
    currentSessionInstanceId: vi.fn(() => `session-${account}`),
    signalSuccess: vi.fn(),
    failRun: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
  } as unknown as TokenPool

  return {
    pool,
    run: {
      id: `run-${account}`,
      agentId: 'agent-a',
      startedAt: new Date(),
      inflight: 1,
      requestCount: 1,
      finishing: false,
    },
    model: 'model-a',
  }
}

describe('chat account failover on upstream rate limit', () => {
  it('cools the limited account and retries the same model on another account', async () => {
    const limited = lease('account-1', {
      statusCode: 429,
      body: { error: 'free_mode_rate_limited', message: 'Try again in 1 minute.' },
    })
    const healthy = lease('account-2', {
      statusCode: 200,
      body: {
        id: 'message-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    })

    const acquire = vi.fn()
      .mockResolvedValueOnce({ lease: limited, reason: '' })
      .mockResolvedValueOnce({ lease: healthy, reason: '' })
    const poolManager = {
      acquire,
      cooldown: vi.fn(),
      release: vi.fn(),
    }
    const db = { insertRequestLog: vi.fn() }
    const registry = { agentForModel: vi.fn(() => 'agent-a') }
    const adsSpoof = { maybeFireChat: vi.fn() }
    const context = {
      req: {
        method: 'POST',
        json: vi.fn(async () => ({
          model: 'model-a',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        })),
      },
      get: vi.fn(() => undefined),
    }

    const handler = handleChatCompletions(
      registry as never,
      poolManager as never,
      db as never,
      () => null,
      adsSpoof as never,
    )
    const response = await handler(context as never)

    expect(response.status).toBe(200)
    expect(poolManager.cooldown).toHaveBeenCalledWith(
      limited,
      60_000,
      expect.stringContaining('Try again in 1 minute'),
    )
    expect(acquire).toHaveBeenNthCalledWith(2, 'model-a', 'agent-a', 'model-a', new Set(['account-1']))
    expect(healthy.pool.upstreamClient.chatCompletions).toHaveBeenCalledTimes(1)
    expect(limited.pool.signalSuccess).not.toHaveBeenCalled()
    expect(healthy.pool.signalSuccess).toHaveBeenCalledTimes(1)
  })
})
