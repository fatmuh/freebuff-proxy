import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { handleRefreshQuota } from '../routes/accounts.js'

const account = {
  id: 'acct-1',
  name: 'Account One',
  email: 'account@example.test',
  user_id: 'user-1',
  token: 'token-1',
  auth_token: '',
  session_model: 'crof/glm-5.2',
  proxy_id: 'proxy-1',
  added_at: '2026-07-23T00:00:00.000Z',
  paused: false,
  serve_status: 'active' as const,
  account_status: 'idle' as const,
}

describe('handleRefreshQuota', () => {
  it('returns the exact upstream response even when the refresh is rejected', async () => {
    const pool = {
      name: account.id,
      token: account.token,
      proxyId: account.proxy_id,
      currentSessionInstanceId: vi.fn(() => 'session-1'),
      upstreamClient: {
        inspectSession: vi.fn().mockResolvedValue({
          statusCode: 403,
          body: '{"status":"banned"}',
        }),
      },
      captureUsageData: vi.fn(),
      rateLimit: null,
      rateLimitsByModel: null,
    }
    const auth = { getAccount: vi.fn(() => account) }
    const runs = { getPoolByName: vi.fn(() => pool) }
    const app = new Hono()
    app.post('/api/accounts/:id/refresh-quota', handleRefreshQuota(auth as never, runs as never))

    const response = await app.request('/api/accounts/acct-1/refresh-quota', { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      statusCode: 403,
      response: '{"status":"banned"}',
      rateLimit: null,
      rateLimitsByModel: null,
    })
    expect(pool.captureUsageData).not.toHaveBeenCalled()
  })

  it('captures quota data while preserving the successful raw response', async () => {
    const upstreamResponse = JSON.stringify({
      status: 'active',
      rateLimit: { model: 'crof/glm-5.2', limit: 100, recentCount: 7, resetAt: '2026-07-24T00:00:00.000Z' },
    })
    const pool = {
      name: account.id,
      token: account.token,
      proxyId: account.proxy_id,
      currentSessionInstanceId: vi.fn(() => 'session-1'),
      upstreamClient: {
        inspectSession: vi.fn().mockResolvedValue({ statusCode: 200, body: upstreamResponse }),
      },
      captureUsageData: vi.fn(),
      rateLimit: null,
      rateLimitsByModel: null,
    }
    const auth = { getAccount: vi.fn(() => account) }
    const runs = { getPoolByName: vi.fn(() => pool) }
    const app = new Hono()
    app.post('/api/accounts/:id/refresh-quota', handleRefreshQuota(auth as never, runs as never))

    const response = await app.request('/api/accounts/acct-1/refresh-quota', { method: 'POST' })

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      statusCode: 200,
      response: upstreamResponse,
    })
    expect(pool.captureUsageData).toHaveBeenCalledWith(JSON.parse(upstreamResponse))
  })
})
