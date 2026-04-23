import { request, Agent, interceptors } from 'undici'
import type { Dispatcher } from 'undici'
import type { FreeSessionResponse } from './types.js'

type ReqOpts = Parameters<typeof request>[1]

export class UpstreamClient {
  private baseURL: string
  private userAgent: string
  private dispatcher: Dispatcher

  constructor(baseURL: string, requestTimeout: number, userAgent: string) {
    this.baseURL = baseURL
    this.userAgent = userAgent
    // Agent with redirect interceptor composed in (undici v7 style)
    const agent = new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      connect: { timeout: Math.min(requestTimeout / 2, 15_000) },
      headersTimeout: requestTimeout,
      bodyTimeout: requestTimeout,
      interceptors: {
        Network: [interceptors.redirect({ maxRedirections: 5 })],
      } as unknown as undefined,
    })

    // Prevent unhandled socket errors (e.g. "other side closed") from crashing
    agent.on('connectionError', (err: Error) => {
      console.log('[upstream] connection error (handled):', err.message)
    })

    this.dispatcher = agent
  }

  // ─── Run Management ──────────────────────────────────────────

  async startRun(authToken: string, agentId: string): Promise<string> {
    const body = JSON.stringify({ action: 'START', agentId })
    const { statusCode, body: respBody } = await this.doPost(authToken, '/api/v1/agent-runs', body)

    const text = await respBody.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`start run failed: ${statusCode} ${text.trim()}`)
    }

    const parsed = JSON.parse(text)
    const runId = (parsed.runId ?? '').trim()
    if (!runId) throw new Error(`start run missing runId: ${text}`)
    return runId
  }

  async finishRun(authToken: string, runId: string, totalSteps: number): Promise<void> {
    const body = JSON.stringify({
      action: 'FINISH', runId, status: 'completed',
      totalSteps, directCredits: 0, totalCredits: 0,
    })
    const { statusCode, body: respBody } = await this.doPost(authToken, '/api/v1/agent-runs', body)
    const text = await respBody.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`finish run failed: ${statusCode} ${text.trim()}`)
    }
  }

  // ─── Chat Completions ────────────────────────────────────────

  async chatCompletions(authToken: string, body: string): Promise<Dispatcher.ResponseData> {
    const url = this.buildURL('/api/v1/chat/completions')
    return request(url, {
      ...this.baseOpts(),
      method: 'POST',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'user-agent': this.userAgent,
      },
      body,
    } as ReqOpts) as Promise<Dispatcher.ResponseData>
  }

  // ─── Session Management ──────────────────────────────────────

  async createSession(authToken: string, model: string): Promise<FreeSessionResponse> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(),
      method: 'POST',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'accept': 'application/json',
        'user-agent': this.userAgent,
        'x-freebuff-model': model,
      },
    } as ReqOpts)
    return this.parseSessionResponse(statusCode, body)
  }

  async getSession(authToken: string, instanceId: string): Promise<FreeSessionResponse> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(),
      method: 'GET',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'accept': 'application/json',
        'user-agent': this.userAgent,
        'x-freebuff-instance-id': instanceId,
      },
    } as ReqOpts)
    return this.parseSessionResponse(statusCode, body)
  }

  async endSession(authToken: string): Promise<void> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(),
      method: 'DELETE',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'accept': 'application/json',
        'user-agent': this.userAgent,
      },
    } as ReqOpts)
    if (statusCode === 404) return
    const text = await body.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`end session failed: ${statusCode} ${text.trim()}`)
    }
  }

  // ─── Raw HTTP for model registry ─────────────────────────────

  async fetchText(url: string, timeout: number): Promise<string> {
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(),
      method: 'GET',
      headers: { 'accept': 'text/plain' },
      signal: AbortSignal.timeout(timeout),
    } as ReqOpts)
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`fetch ${url} failed: ${statusCode}`)
    }
    return body.text()
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private buildURL(path: string): string {
    return `${this.baseURL}${path}`
  }

  private baseOpts(): Record<string, unknown> {
    return { dispatcher: this.dispatcher }
  }

  private async doPost(
    authToken: string,
    path: string,
    body: string,
  ): Promise<{ statusCode: number; body: Dispatcher.ResponseData['body'] }> {
    const url = this.buildURL(path)
    const result = await request(url, {
      ...this.baseOpts(),
      method: 'POST',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': this.userAgent,
      },
      body,
    } as ReqOpts)
    return { statusCode: result.statusCode, body: result.body }
  }

  private async parseSessionResponse(
    statusCode: number,
    body: Dispatcher.ResponseData['body'],
  ): Promise<FreeSessionResponse> {
    if (statusCode === 404) return { status: 'disabled' } as FreeSessionResponse

    const text = await body.text()

    if (statusCode === 409) {
      try {
        const parsed = JSON.parse(text)
        if (parsed.status === 'model_locked') {
          return {
            status: 'model_locked',
            currentModel: parsed.currentModel ?? '',
            requestedModel: parsed.requestedModel ?? '',
          } as FreeSessionResponse
        }
      } catch { /* fall through */ }
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`session request failed: ${statusCode} ${text.trim()}`)
    }

    const parsed = JSON.parse(text)
    if (!parsed.status?.trim()) throw new Error('session response missing status')
    return parsed as FreeSessionResponse
  }
}
