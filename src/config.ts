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
// Env-only with hardcoded defaults. No config.json needed.

const DEFAULTS = {
  LISTEN_ADDR: '0.0.0.0:9187',
  UPSTREAM_BASE_URL: 'https://www.codebuff.com',
  ROTATION_INTERVAL: '6h',
  REQUEST_TIMEOUT: '15m',
  HTTP_PROXY: '',
  SESSION_IDLE_TIMEOUT: '10m',
}

export function loadConfig(): Config {
  const listenAddr = process.env.LISTEN_ADDR?.trim() || DEFAULTS.LISTEN_ADDR
  const upstreamBaseURL = process.env.UPSTREAM_BASE_URL?.trim() || DEFAULTS.UPSTREAM_BASE_URL
  const rotationInterval = parseDuration(process.env.ROTATION_INTERVAL?.trim() || DEFAULTS.ROTATION_INTERVAL)
  const requestTimeout = parseDuration(process.env.REQUEST_TIMEOUT?.trim() || DEFAULTS.REQUEST_TIMEOUT)
  const httpProxy = process.env.HTTP_PROXY?.trim() || DEFAULTS.HTTP_PROXY
  const sessionIdleTimeout = parseDuration(process.env.SESSION_IDLE_TIMEOUT?.trim() || DEFAULTS.SESSION_IDLE_TIMEOUT)

  const cfg: Config = {
    listenAddr,
    upstreamBaseURL: upstreamBaseURL.replace(/\/+$/, ''),
    rotationInterval,
    requestTimeout,
    httpProxy,
    sessionIdleTimeout,
  }

  if (!cfg.listenAddr) throw new Error('LISTEN_ADDR cannot be empty')
  if (!cfg.upstreamBaseURL) throw new Error('UPSTREAM_BASE_URL cannot be empty')
  if (cfg.rotationInterval <= 0) throw new Error('ROTATION_INTERVAL must be greater than zero')
  if (cfg.requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero')

  return cfg
}
