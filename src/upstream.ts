import { request, Agent, ProxyAgent, Socks5ProxyAgent, interceptors } from 'undici'
import type { Dispatcher } from 'undici'
import type { FreeSessionResponse } from './types.js'
import type { ProxyEntry } from './proxy-store.js'

type ReqOpts = Parameters<typeof request>[1]

// Build the right undici dispatcher for a proxy entry
function createProxyDispatcher(proxy: ProxyEntry, requestTimeout: number): Dispatcher {
  const scheme = proxy.type === 'socks5' ? 'socks5' : 'http'
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : ''
  const proxyUrl = `${scheme}://${auth}${proxy.host}:${proxy.port}`

  if (proxy.type === 'socks5') {
    return new Socks5ProxyAgent(proxyUrl, {
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      headersTimeout: requestTimeout,
      bodyTimeout: requestTimeout,
    } as Socks5ProxyAgent.Options)
  }

  return new ProxyAgent({
    uri: proxyUrl,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    headersTimeout: requestTimeout,
    bodyTimeout: requestTimeout,
  } as ProxyAgent.Options)
}

export class UpstreamClient {
  private baseURL: string
  private userAgent: string
  private defaultDispatcher: Dispatcher
  private proxyDispatchers = new Map<string, Dispatcher>()
  private requestTimeout: number

  constructor(baseURL: string, requestTimeout: number, userAgent: string) {
    this.baseURL = baseURL
    this.userAgent = userAgent
    this.requestTimeout = requestTimeout

    const agent = new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      connect: {
        timeout: Math.min(requestTimeout / 2, 15_000),
        ALPNProtocols: ['http/1.1'],
      },
      headersTimeout: requestTimeout,
      bodyTimeout: requestTimeout,
      interceptors: {
        Network: [interceptors.redirect({ maxRedirections: 5 })],
      } as unknown as undefined,
    })

    // @ts-expect-error undici Agent emits connectionError but types don't declare it
    agent.on('connectionError', (err: Error) => {
      console.log('[upstream] connection error (handled):', err.message)
    })

    this.defaultDispatcher = agent
  }

  // Register or update a proxy dispatcher for a proxy entry
  registerProxy(proxy: ProxyEntry): void {
    const existing = this.proxyDispatchers.get(proxy.id)
    if (existing) {
      try { existing.close() } catch { /* ignore */ }
    }
    this.proxyDispatchers.set(proxy.id, createProxyDispatcher(proxy, this.requestTimeout))
  }

  // Remove a proxy dispatcher
  unregisterProxy(proxyId: string): void {
    const existing = this.proxyDispatchers.get(proxyId)
    if (existing) {
      try { existing.close() } catch { /* ignore */ }
      this.proxyDispatchers.delete(proxyId)
    }
  }

  // Get dispatcher for an account's bound proxy (or default if none)
  getDispatcher(proxyId?: string): Dispatcher {
    if (proxyId && this.proxyDispatchers.has(proxyId)) {
      return this.proxyDispatchers.get(proxyId)!
    }
    return this.defaultDispatcher
  }

  // ─── Run Management ──────────────────────────────────────────

  async startRun(authToken: string, agentId: string, proxyId?: string): Promise<string> {
    const body = JSON.stringify({ action: 'START', agentId })
    const { statusCode, body: respBody } = await this.doPost(authToken, '/api/v1/agent-runs', body, proxyId)

    const text = await respBody.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`start run failed: ${statusCode} ${text.trim()}`)
    }

    const parsed = JSON.parse(text)
    const runId = (parsed.runId ?? '').trim()
    if (!runId) throw new Error(`start run missing runId: ${text}`)
    return runId
  }

  async finishRun(authToken: string, runId: string, totalSteps: number, proxyId?: string): Promise<void> {
    const body = JSON.stringify({
      action: 'FINISH', runId, status: 'completed',
      totalSteps, directCredits: 0, totalCredits: 0,
    })
    const { statusCode, body: respBody } = await this.doPost(authToken, '/api/v1/agent-runs', body, proxyId)
    const text = await respBody.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`finish run failed: ${statusCode} ${text.trim()}`)
    }
  }

  // ─── Chat Completions ────────────────────────────────────────

  async chatCompletions(authToken: string, body: string, proxyId?: string): Promise<Dispatcher.ResponseData> {
    const url = this.buildURL('/api/v1/chat/completions')
    return request(url, {
      ...this.baseOpts(proxyId),
      method: 'POST',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'content-type': 'application/json',
        'accept': '*/*',
        'user-agent': this.userAgent,
        'connection': 'keep-alive',
        'accept-encoding': 'gzip, deflate, br, zstd',
      },
      body,
    } as ReqOpts) as Promise<Dispatcher.ResponseData>
  }

  // ─── Session Management ──────────────────────────────────────

  async createSession(authToken: string, model: string, proxyId?: string): Promise<FreeSessionResponse> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(proxyId),
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

  async getSession(authToken: string, instanceId: string, proxyId?: string): Promise<FreeSessionResponse> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(proxyId),
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

  async endSession(authToken: string, proxyId?: string): Promise<void> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(proxyId),
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

  private baseOpts(proxyId?: string): Record<string, unknown> {
    return { dispatcher: this.getDispatcher(proxyId) }
  }

  private async doPost(
    authToken: string,
    path: string,
    body: string,
    proxyId?: string,
  ): Promise<{ statusCode: number; body: Dispatcher.ResponseData['body'] }> {
    const url = this.buildURL(path)
    const result = await request(url, {
      ...this.baseOpts(proxyId),
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
