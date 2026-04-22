import type { Config } from './types.js'

// ─── Duration Parsing ─────────────────────────────────────────
// Parses human-readable duration strings like "6h", "15m", "30s"

export function parseDuration(raw: string): number {
  const s = raw.trim()
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(s)
  if (!match) throw new Error(`invalid duration: ${s}`)

  const value = parseFloat(match[1])
  const unit = match[2]

  switch (unit) {
    case 'ms': return value
    case 's':  return value * 1000
    case 'm':  return value * 60_000
    case 'h':  return value * 3_600_000
    default:   throw new Error(`unknown duration unit: ${unit}`)
  }
}

// ─── Config Loading ───────────────────────────────────────────
// Loads from config.json + env var overrides. Same keys as Go version.

interface RawConfig {
  LISTEN_ADDR: string
  UPSTREAM_BASE_URL: string
  AUTH_TOKENS: string[]
  TOKEN_MODELS: string[]
  ROTATION_INTERVAL: string
  REQUEST_TIMEOUT: string
  API_KEYS: string[]
  HTTP_PROXY: string
}

const DEFAULTS: RawConfig = {
  LISTEN_ADDR: ':9187',
  UPSTREAM_BASE_URL: 'https://www.codebuff.com',
  AUTH_TOKENS: [],
  TOKEN_MODELS: [],
  ROTATION_INTERVAL: '6h',
  REQUEST_TIMEOUT: '15m',
  API_KEYS: [],
  HTTP_PROXY: '',
}

export async function loadConfig(configPath?: string): Promise<Config> {
  let raw: RawConfig = { ...DEFAULTS }

  // Load JSON file if provided or auto-detected
  if (configPath) {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const absPath = resolve(configPath)
    const data = await readFile(absPath, 'utf-8')
    const parsed = JSON.parse(data)
    raw = { ...DEFAULTS, ...parsed }
  }

  // Env var overrides (same keys, comma-separated for arrays)
  overrideString(raw, 'LISTEN_ADDR')
  overrideString(raw, 'UPSTREAM_BASE_URL')
  overrideString(raw, 'ROTATION_INTERVAL')
  overrideString(raw, 'REQUEST_TIMEOUT')
  overrideString(raw, 'HTTP_PROXY')
  overrideCSV(raw, 'AUTH_TOKENS')
  overrideCSV(raw, 'TOKEN_MODELS')
  overrideCSV(raw, 'API_KEYS')

  // Parse durations
  const rotationInterval = parseDuration(raw.ROTATION_INTERVAL)
  const requestTimeout = parseDuration(raw.REQUEST_TIMEOUT)

  // Build final config
  const cfg: Config = {
    listenAddr: raw.LISTEN_ADDR.trim(),
    upstreamBaseURL: raw.UPSTREAM_BASE_URL.trim().replace(/\/+$/, ''),
    authTokens: dedupeStrings(raw.AUTH_TOKENS),
    tokenModels: raw.TOKEN_MODELS.map(s => s.trim()).filter(Boolean),
    rotationInterval,
    requestTimeout,
    apiKeys: dedupeStrings(raw.API_KEYS),
    httpProxy: raw.HTTP_PROXY.trim(),
  }

  // Validate
  if (!cfg.listenAddr) throw new Error('LISTEN_ADDR cannot be empty')
  if (!cfg.upstreamBaseURL) throw new Error('UPSTREAM_BASE_URL cannot be empty')
  if (cfg.authTokens.length === 0) throw new Error('at least one AUTH_TOKENS is required')
  if (cfg.rotationInterval <= 0) throw new Error('ROTATION_INTERVAL must be greater than zero')
  if (cfg.requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero')

  // Pad tokenModels to match authTokens length (default to minimax)
  while (cfg.tokenModels.length < cfg.authTokens.length) {
    cfg.tokenModels.push('minimax/minimax-m2.7')
  }

  return cfg
}

// ─── Helpers ──────────────────────────────────────────────────

function overrideString(raw: RawConfig, key: string): void {
  const envVal = process.env[key]?.trim()
  if (envVal) (raw as unknown as Record<string, unknown>)[key] = envVal
}

function overrideCSV(raw: RawConfig, key: string): void {
  const envVal = process.env[key]?.trim()
  if (envVal) {
    (raw as unknown as Record<string, unknown>)[key] = envVal
      .split(/[,\n\r]+/)
      .map((s: string) => s.trim())
      .filter(Boolean)
  }
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter(v => {
    v = v.trim()
    if (!v || seen.has(v)) return false
    seen.add(v)
    return true
  })
}
