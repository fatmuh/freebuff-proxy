import { request } from 'undici'
import type { UpstreamClient } from './upstream.js'
import { FREEBUFF_CLI_USER_AGENT_FALLBACK } from './utils.js'
import { randomUUID } from 'node:crypto'
import { getFakeConversation } from './fake-conversations.js'
import { generateSyntheticFingerprint } from './synthetic-fingerprint.js'

// Browser-like UA for the ads API body (matches real CLI's getAdUserAgent).
// The ad network needs a browser UA for targeting — a CLI UA looks bot-like.
const AD_CHROME_VERSION = '124.0.0.0'
const AD_BROWSER_UAS: Record<string, string> = {
  macos: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
  windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
}
// ─── Background Freebuff ads fetch-and-discard ─────────────────
// Fetches ads with the REAL CLI shape (cli_chat surface, real
// conversation messages, device details) but:
//   - Uses fake conversation messages (privacy-preserving)
//   - Uses synthetic device profile (os/timezone/locale)
//   - Discards the ad response (no rendering)
//   - Sends NO impression/click/ZeroClick (nothing rendered)
//
// Kill with ADS_SPOOF=0.

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
  private deviceInfoByAccount = new Map<string, { os: string; timezone: string; locale: string }>()

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

  /** Fire-and-forget per-prompt ads fetch (cli_chat surface).
   *  Called from chat route after a successful completion. */
  maybeFireChat(accountId: string, authToken: string, proxyId?: string): void {
    if (!this.enabled) return
    if (!accountId || !authToken) return

    void this.runChat(accountId, authToken, proxyId).catch(err => {
      this.log(`[ads] ${accountId}: chat fetch silent fail:`, err)
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

  private deviceInfo(accountId: string): { os: string; timezone: string; locale: string } {
    let info = this.deviceInfoByAccount.get(accountId)
    if (!info) {
      const fp = generateSyntheticFingerprint(accountId)
      info = fp.deviceInfo
      this.deviceInfoByAccount.set(accountId, info)
    }
    return info
  }

  /** Waiting-room style fetch (session-admit). Empty messages. */
  private async run(accountId: string, authToken: string, proxyId?: string): Promise<void> {
    const url = `${this.baseURL}/api/v1/ads`
    const body = JSON.stringify({
      provider: 'gravity',
      messages: [],
      sessionId: this.sessionId(accountId),
      device: this.deviceInfo(accountId),
      surface: 'waiting_room',
      userAgent: AD_BROWSER_UAS[this.deviceInfo(accountId).os] ?? AD_BROWSER_UAS.linux,
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

    const text = await resp.body.text().catch(() => '')
    const preview = adPreview(text)
    this.log(`[ads] ${accountId}: waiting_room ${resp.statusCode} — ${preview}`)
  }

  /** Per-chat-prompt fetch (cli_chat surface). Real fake conversation. */
  private async runChat(accountId: string, authToken: string, proxyId?: string): Promise<void> {
    const url = `${this.baseURL}/api/v1/ads`
    const convo = getFakeConversation()

    const body = JSON.stringify({
      provider: 'gravity',
      messages: convo.messages,
      sessionId: this.sessionId(accountId),
      device: this.deviceInfo(accountId),
      surface: 'cli_chat',
      userAgent: AD_BROWSER_UAS[this.deviceInfo(accountId).os] ?? AD_BROWSER_UAS.linux,
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

    const text = await resp.body.text().catch(() => '')
    const preview = adPreview(text)
    this.log(`[ads] ${accountId}: cli_chat ${resp.statusCode} — ${preview} (sent ${convo.messages.length} fake msgs)`)
  }
}

function adPreview(body: string): string {
  try {
    const parsed = JSON.parse(body)
    const ads = parsed.ads
    if (!Array.isArray(ads) || ads.length === 0) return 'no ads'
    const ad = ads[0]
    const text = ad.title || ad.adText || ad.description || ''
    if (!text) return `${ads.length} ad(s), no text`
    const words = text.split(/\s+/).slice(0, 10).join(' ')
    return `${ads.length} ad(s): "${words}..."`
  } catch {
    return 'parse error'
  }
}
