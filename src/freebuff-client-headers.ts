import { UpstreamClient } from './upstream.js'
import {
  BUN_USER_AGENT_FALLBACK,
  CHAT_USER_AGENT_FALLBACK,
  FREEBUFF_CLI_USER_AGENT_FALLBACK,
} from './utils.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// ─── Live Freebuff CLI header User-Agents ──────────────────────
// Mimic Freebuff CLI headers and refresh versions from their GitHub.
//
//   ads     Freebuff-CLI/<cli>          ← freebuff/cli/release/package.json
//   chat    ai-sdk/.../provider-utils/X ← root package.json overrides
//   session Bun/<bun>                   ← root packageManager / engines.bun
//
// Fallback chain: remote → disk cache → hardcoded (from mitm/real CLI).

const FREEBUFF_CLI_PACKAGE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/freebuff/cli/release/package.json'
const CODEBUFF_ROOT_PACKAGE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/package.json'

const REFRESH_INTERVAL = 6 * 3600_000 // 6h
const DEFAULT_CACHE_PATH = resolve('data', 'freebuff-client-headers-cache.json')

interface HeadersCacheFile {
  savedAt: string
  source: 'remote' | 'fallback'
  freebuffCliVersion: string
  providerUtilsVersion: string
  bunVersion: string
}

export class FreebuffClientHeaders {
  private client: UpstreamClient
  private log: (...args: unknown[]) => void
  private cachePath: string

  private freebuffCliVersion: string | null = null
  private providerUtilsVersion: string | null = null
  private bunVersion: string | null = null

  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    client: UpstreamClient,
    log: (...args: unknown[]) => void,
    cachePath = DEFAULT_CACHE_PATH,
  ) {
    this.client = client
    this.log = log
    this.cachePath = cachePath
  }

  async start(): Promise<void> {
    try {
      await this.refresh()
    } catch (err) {
      this.log('freebuff headers: initial fetch failed:', err)
      if (!(await this.loadDiskCache())) {
        this.loadFallback()
      }
    }

    this.refreshTimer = setInterval(() => {
      if (this.stopped) return
      this.refresh().catch(err => {
        this.log('freebuff headers: refresh failed (keeping previous):', err)
      })
    }, REFRESH_INTERVAL)
  }

  stop(): void {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /** Ads: Freebuff-CLI/<version> */
  adsUserAgent(): string {
    const v = this.freebuffCliVersion
    if (!v) return FREEBUFF_CLI_USER_AGENT_FALLBACK
    return `Freebuff-CLI/${v}`
  }

  /** Chat completions: full AI SDK UA (mitm-matched shape). */
  chatUserAgent(): string {
    const v = this.providerUtilsVersion ?? parseProviderUtilsFromFallback()
    return `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/${v} runtime/browser`
  }

  /** Session / agent-runs / most Bun fetch calls. */
  sessionUserAgent(): string {
    const v = this.bunVersion
    if (!v) return BUN_USER_AGENT_FALLBACK
    return `Bun/${v}`
  }

  private async refresh(): Promise<void> {
    const [cliRaw, rootRaw] = await Promise.all([
      this.client.fetchText(FREEBUFF_CLI_PACKAGE_URL, 15_000),
      this.client.fetchText(CODEBUFF_ROOT_PACKAGE_URL, 15_000),
    ])

    const cliPkg = JSON.parse(cliRaw) as { version?: unknown }
    const rootPkg = JSON.parse(rootRaw) as {
      packageManager?: unknown
      engines?: { bun?: unknown }
      overrides?: Record<string, unknown>
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }

    const freebuffCliVersion = asSemver(cliPkg.version)
    if (!freebuffCliVersion) {
      throw new Error(`invalid freebuff cli version: ${JSON.stringify(cliPkg.version)}`)
    }

    const providerUtilsVersion =
      asSemver(rootPkg.overrides?.['@ai-sdk/provider-utils']) ||
      asSemver(rootPkg.dependencies?.['@ai-sdk/provider-utils']) ||
      asSemver(rootPkg.devDependencies?.['@ai-sdk/provider-utils'])
    if (!providerUtilsVersion) {
      throw new Error('missing @ai-sdk/provider-utils version in root package.json')
    }

    const bunVersion =
      parseBunVersion(rootPkg.packageManager) ||
      asSemver(rootPkg.engines?.bun)
    if (!bunVersion) {
      throw new Error('missing bun version in root package.json')
    }

    this.freebuffCliVersion = freebuffCliVersion
    this.providerUtilsVersion = providerUtilsVersion
    this.bunVersion = bunVersion

    await this.saveDiskCache('remote')
    this.log(
      'freebuff headers: updated',
      'ads=', this.adsUserAgent(),
      'chat=', this.chatUserAgent(),
      'session=', this.sessionUserAgent(),
    )
  }

  private async loadDiskCache(): Promise<boolean> {
    try {
      const raw = await readFile(this.cachePath, 'utf-8')
      const data = JSON.parse(raw) as HeadersCacheFile
      const freebuffCliVersion = asSemver(data?.freebuffCliVersion)
      const providerUtilsVersion = asSemver(data?.providerUtilsVersion)
      const bunVersion = asSemver(data?.bunVersion)
      if (!freebuffCliVersion || !providerUtilsVersion || !bunVersion) return false

      this.freebuffCliVersion = freebuffCliVersion
      this.providerUtilsVersion = providerUtilsVersion
      this.bunVersion = bunVersion
      this.log(
        'freebuff headers: loaded disk cache from',
        data.savedAt,
        `cli=${freebuffCliVersion}`,
        `provider-utils=${providerUtilsVersion}`,
        `bun=${bunVersion}`,
      )
      return true
    } catch {
      return false
    }
  }

  private async saveDiskCache(source: 'remote' | 'fallback'): Promise<void> {
    if (!this.freebuffCliVersion || !this.providerUtilsVersion || !this.bunVersion) return
    try {
      const payload: HeadersCacheFile = {
        savedAt: new Date().toISOString(),
        source,
        freebuffCliVersion: this.freebuffCliVersion,
        providerUtilsVersion: this.providerUtilsVersion,
        bunVersion: this.bunVersion,
      }
      await mkdir(dirname(this.cachePath), { recursive: true })
      await writeFile(this.cachePath, JSON.stringify(payload, null, 2))
    } catch (err) {
      this.log('freebuff headers: disk cache write failed:', err)
    }
  }

  private loadFallback(): void {
    this.freebuffCliVersion =
      asSemver(FREEBUFF_CLI_USER_AGENT_FALLBACK.match(/^Freebuff-CLI\/(.+)$/)?.[1]) ?? '0.0.122'
    this.providerUtilsVersion = parseProviderUtilsFromFallback()
    this.bunVersion =
      asSemver(BUN_USER_AGENT_FALLBACK.match(/^Bun\/(.+)$/)?.[1]) ?? '1.3.14'
    void this.saveDiskCache('fallback')
    this.log(
      'freebuff headers: loaded hardcoded fallback',
      'ads=', this.adsUserAgent(),
      'chat=', this.chatUserAgent(),
      'session=', this.sessionUserAgent(),
    )
  }
}

function asSemver(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // plain "3.0.20", "^3.0.17", "bun@1.3.14" → first x.y.z
  const m = value.trim().match(/(\d+\.\d+\.\d+)/)
  return m?.[1] ?? null
}

function parseBunVersion(packageManager: unknown): string | null {
  if (typeof packageManager !== 'string') return null
  // "bun@1.3.14"
  const m = packageManager.trim().match(/^bun@(\d+\.\d+\.\d+)/i)
  return m?.[1] ?? null
}

function parseProviderUtilsFromFallback(): string {
  const m = CHAT_USER_AGENT_FALLBACK.match(/provider-utils\/(\d+\.\d+\.\d+)/)
  return m?.[1] ?? '3.0.20'
}
