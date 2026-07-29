import { request, Agent, ProxyAgent, interceptors } from 'undici'
import type { Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import tls from 'node:tls'
import type { ConnectionOptions } from 'node:tls'
import type { Socket } from 'node:net'
import type { FreeSessionResponse } from './types.js'
import { BUN_USER_AGENT_FALLBACK, CHAT_USER_AGENT_FALLBACK } from './utils.js'
import type { ProxyEntry } from './proxy-store.js'

type ReqOpts = Parameters<typeof request>[1]

// SOCKS5 via custom undici connect (per destination).
// undici's built-in Socks5ProxyAgent pins one Pool to the first origin and
// poisons multi-host use (e.g. Test → httpbin then Freebuff → 503 HTML).
function createSocksAgent(proxy: ProxyEntry, requestTimeout: number): Dispatcher {
  const connectTimeout = Math.min(requestTimeout / 2, 15_000)
  const socksProxy = {
    host: proxy.host,
    port: proxy.port,
    type: 5 as const,
    ...(proxy.username && { userId: proxy.username }),
    ...(proxy.password && { password: proxy.password }),
  }

  // undici replaces full TCP+TLS with this connect fn. Returned socket must
  // already be TLS-wrapped for https destinations.
  const connectFn = (
    opts: { hostname: string; port: string | number; protocol: string },
    cb: (err: Error | null, socket: Socket | null) => void,
  ) => {
    SocksClient.createConnection({
      proxy: socksProxy,
      command: 'connect',
      destination: {
        host: opts.hostname,
        port: Number(opts.port) || 443,
      },
      timeout: connectTimeout,
    })
      .then((info) => {
        const raw = info.socket
        if (opts.protocol === 'https:') {
          const tlsSocket = tls.connect({
            socket: raw,
            host: opts.hostname,
            servername: opts.hostname,
            ALPNProtocols: ['http/1.1'],
            rejectUnauthorized: true,
          } as ConnectionOptions)
          tlsSocket.once('secureConnect', () => cb(null, tlsSocket))
          tlsSocket.once('error', (err) => cb(err, null))
        } else {
          cb(null, raw)
        }
      })
      .catch((err: Error) => cb(err, null))
  }

  return new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    headersTimeout: requestTimeout,
    bodyTimeout: requestTimeout,
    connect: connectFn as Agent.Options['connect'],
  })
}

// Build the right undici dispatcher for a proxy entry
function createProxyDispatcher(proxy: ProxyEntry, requestTimeout: number): Dispatcher {
  if (proxy.type === 'socks5') {
    return createSocksAgent(proxy, requestTimeout)
  }

  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : ''
  const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`

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
  private getSessionUserAgent: () => string
  private getChatUserAgent: () => string
  private defaultDispatcher: Dispatcher
  private proxyDispatchers = new Map<string, Dispatcher>()
  private requestTimeout: number

  constructor(baseURL: string, requestTimeout: number, sessionUserAgent = BUN_USER_AGENT_FALLBACK) {
    this.baseURL = baseURL
    this.getSessionUserAgent = () => sessionUserAgent
    this.getChatUserAgent = () => CHAT_USER_AGENT_FALLBACK
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

  /** Wire live Freebuff CLI UAs after GitHub version fetch. */
  setUserAgents(opts: {
    sessionUserAgent?: () => string
    chatUserAgent?: () => string
  }): void {
    if (opts.sessionUserAgent) this.getSessionUserAgent = opts.sessionUserAgent
    if (opts.chatUserAgent) this.getChatUserAgent = opts.chatUserAgent
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
    const body = JSON.stringify({ action: 'START', agentId, ancestorRunIds: [] })
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

  async finishRun(
    authToken: string,
    runId: string,
    status: string,
    totalSteps: number,
    directCredits: number,
    totalCredits: number,
    errorMessage?: string,
    proxyId?: string,
  ): Promise<void> {
    const body = JSON.stringify({
      action: 'FINISH', runId, status,
      totalSteps, directCredits, totalCredits,
      ...(errorMessage !== undefined && { errorMessage: errorMessage.slice(0, 5000) }),
    })
    const { statusCode, body: respBody } = await this.doPost(authToken, '/api/v1/agent-runs', body, proxyId)
    const text = await respBody.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`finish run failed: ${statusCode} ${text.trim()}`)
    }
  }

  async addAgentStep(
    authToken: string,
    runId: string,
    stepNumber: number,
    credits: number,
    childRunIds: string[],
    messageId: string | null,
    status: string,
    startTime: string | null,
    proxyId?: string,
  ): Promise<void> {
    const body = JSON.stringify({
      stepNumber,
      credits,
      childRunIds,
      messageId,
      status,
      ...(startTime !== null && { startTime }),
    })
    const { statusCode, body: respBody } = await this.doPost(authToken, `/api/v1/agent-runs/${runId}/steps`, body, proxyId)
    const text = await respBody.text()
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`addAgentStep failed: ${statusCode} ${text.trim()}`)
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
        'user-agent': this.getChatUserAgent(),
        'connection': 'keep-alive',
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
        'accept': '*/*',
        'user-agent': this.getSessionUserAgent(),
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
        'accept': '*/*',
        'user-agent': this.getSessionUserAgent(),
        'x-freebuff-instance-id': instanceId,
      },
    } as ReqOpts)
    return this.parseSessionResponse(statusCode, body)
  }

  /** Read the raw upstream session response for dashboard diagnostics. */
  async inspectSession(authToken: string, instanceId: string, proxyId?: string): Promise<{ statusCode: number; body: string }> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(proxyId),
      method: 'GET',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'accept': '*/*',
        'user-agent': this.getSessionUserAgent(),
        'x-freebuff-instance-id': instanceId,
      },
    } as ReqOpts)
    return { statusCode, body: await body.text() }
  }

  async endSession(authToken: string, proxyId?: string): Promise<void> {
    const url = this.buildURL('/api/v1/freebuff/session')
    const { statusCode, body } = await request(url, {
      ...this.baseOpts(proxyId),
      method: 'DELETE',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'accept': '*/*',
        'user-agent': this.getSessionUserAgent(),
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
        'accept': '*/*',
        'user-agent': this.getSessionUserAgent(),
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

    // Terminal Freebuff account rejects — return status instead of throw so
    // TokenPool can mark the account inactive and stop retrying.
    if (statusCode === 403) {
      try {
        const parsed = JSON.parse(text) as { status?: unknown; message?: unknown }
        const s = typeof parsed.status === 'string' ? parsed.status.trim() : ''
        if (s === 'banned' || s === 'country_blocked') {
          return {
            status: s,
            message: typeof parsed.message === 'string' ? parsed.message : s,
          } as FreeSessionResponse
        }
      } catch { /* fall through to throw */ }
    }

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
