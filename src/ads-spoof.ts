import { request } from 'undici'
import type { UpstreamClient } from './upstream.js'
import { FREEBUFF_CLI_USER_AGENT_FALLBACK } from './utils.js'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'

// ─── Background Freebuff ads spoof ─────────────────────────────
// Fire-and-forget POST /api/v1/ads (+ impression if ads returned).
// Never blocks chat. No UI. Kill with ADS_SPOOF=0.

const ADS_BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000

export interface AdsSpoofOptions {
  enabled?: boolean
  minIntervalMs?: number
  /** Live Freebuff-CLI/<version> UA; falls back if missing. */
  getCliUserAgent?: () => string
}

export class AdsSpoof {
  private baseURL: string
  private client: UpstreamClient
  private log: (...args: unknown[]) => void
  private enabled: boolean
  private minIntervalMs: number
  private lastByAccount = new Map<string, number>()
  private getCliUserAgent: () => string

  private sessionIdByAccount = new Map<string, string>()

  constructor(
    baseURL: string,
    client: UpstreamClient,
    log: (...args: unknown[]) => void,
    opts: AdsSpoofOptions = {},
  ) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.client = client
    this.log = log
    const envOff = process.env.ADS_SPOOF === '0' || process.env.ADS_SPOOF === 'false'
    this.enabled = opts.enabled ?? !envOff
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.getCliUserAgent = opts.getCliUserAgent ?? (() => FREEBUFF_CLI_USER_AGENT_FALLBACK)
  }

  /** Non-blocking. Safe to call from session create / chat paths. */
  maybeFire(accountId: string, authToken: string, proxyId?: string): void {
    if (!this.enabled) return
    if (!accountId || !authToken) return

    const now = Date.now()
    const last = this.lastByAccount.get(accountId) ?? 0
    if (now - last < this.minIntervalMs) return
    this.lastByAccount.set(accountId, now)

    void this.run(accountId, authToken, proxyId).catch(err => {
      this.log(`[ads] ${accountId}: silent fail:`, err)
    })
  }

  private sessionId(accountId: string): string {
    let id = this.sessionIdByAccount.get(accountId)
    if (!id) {
      id = randomUUID()
      this.sessionIdByAccount.set(accountId, id)
    }
    return id
  }

  private async run(accountId: string, authToken: string, proxyId?: string): Promise<void> {
    const url = `${this.baseURL}/api/v1/ads`
    const body = JSON.stringify({
      provider: 'gravity',
      messages: [],
      sessionId: this.sessionId(accountId),
      device: {
        os: platform(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        locale: 'en-US',
      },
      surface: 'waiting_room',
      userAgent: ADS_BROWSER_UA,
    })

    const dispatcher = this.client.getDispatcher(proxyId)
    const resp = await request(url, {
      method: 'POST',
      dispatcher,
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        accept: '*/*',
        'user-agent': this.getCliUserAgent(),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    })

    const text = await resp.body.text()
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      this.log(`[ads] ${accountId}: fetch ${resp.statusCode}`)
      return
    }

    let impUrl = ''
    try {
      const parsed = JSON.parse(text) as { ads?: Array<{ impUrl?: string }> }
      impUrl = (parsed.ads?.[0]?.impUrl ?? '').trim()
    } catch {
      return
    }

    if (!impUrl) {
      this.log(`[ads] ${accountId}: fetch ok, no ad`)
      return
    }

    // Impression only with real impUrl from response
    const impUrlEndpoint = `${this.baseURL}/api/v1/ads/impression`
    const impResp = await request(impUrlEndpoint, {
      method: 'POST',
      dispatcher,
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        accept: '*/*',
        'user-agent': this.getCliUserAgent(),
      },
      body: JSON.stringify({ impUrl, mode: 'LITE' }),
      signal: AbortSignal.timeout(15_000),
    })
    await impResp.body.text().catch(() => '')
    this.log(`[ads] ${accountId}: impression ${impResp.statusCode}`)
  }
}
