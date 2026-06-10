import { createSignal, onCleanup, createResource, Show, For } from 'solid-js'
import { apiGet } from '../lib/api'

interface UsageSummary {
  today: { requests: number; tokens_in: number; tokens_out: number; avg_latency_ms: number }
}

interface Pool {
  name: string
  sessionModel: string
  switching: boolean
  sessionStatus: string
  sessionInstanceId: string
  sessionExpiresAt: string | null
  sessionAdmittedAt: string | null
  sessionRemainingMs: number
  sessionPosition: number
  sessionQueueDepth: number
  sessionEstWaitMs: number
  cooldownUntil: string | null
  lastError: string
  paused: boolean
}

interface ModelUsage {
  model: string
  requests: number
  tokens_in: number
  tokens_out: number
}

interface HourlyUsage {
  hour: string
  requests: number
}

interface RecentRequest {
  id: number
  created_at: string
  model: string
  status_code: number
  latency_ms: number | null
}

interface StatusData {
  running: boolean
  uptime_sec: number
  total_accounts: number
  active_accounts: number
  queued_accounts: number
  active_by_model: Record<string, number>
}

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export default function HomePage() {
  const [usage] = createResource(() => apiGet<UsageSummary>('/api/usage/summary'))
  const [pools, setPools] = createSignal<Pool[]>([])
  const [status, setStatus] = createSignal<StatusData | null>(null)
  const [modelBreakdown] = createResource(() => apiGet<ModelUsage[]>('/api/usage/by-model?days=1'))
  const [hourlyData] = createResource(() => apiGet<HourlyUsage[]>('/api/usage/hourly'))
  const [recentRequests, setRecentRequests] = createSignal<RecentRequest[]>([])

  const poll = async () => {
    try {
      const [poolsData, reqsData, statusData] = await Promise.all([
        apiGet<{ pools: Pool[] }>('/api/pools'),
        apiGet<{ rows: RecentRequest[] }>('/api/requests?limit=5'),
        apiGet<StatusData>('/api/status'),
      ])
      setPools(poolsData.pools)
      setRecentRequests(reqsData.rows)
      setStatus(statusData)
    } catch {}
  }

  poll()
  const interval = setInterval(poll, 3000)
  onCleanup(() => clearInterval(interval))

  const formatDuration = (ms: number) => {
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${h}h ${m}m ${s}s`
  }

  const statusBadge = (pool: Pool) => {
    if (pool.paused) return <span class="badge badge-paused">Paused</span>
    if (pool.switching) return <span class="badge badge-queued">Switching...</span>
    if (pool.sessionStatus === 'active') {
      const remaining = pool.sessionExpiresAt ? Math.max(0, new Date(pool.sessionExpiresAt).getTime() - Date.now()) : 0
      return <span class="badge badge-active">Active ({formatDuration(remaining)})</span>
    }
    if (pool.sessionStatus === 'queued') {
      const wait = pool.sessionEstWaitMs > 0 ? ` (~${formatDuration(pool.sessionEstWaitMs)})` : ''
      return <span class="badge badge-queued">Queued #{pool.sessionPosition}/{pool.sessionQueueDepth}{wait}</span>
    }
    if (pool.cooldownUntil) return <span class="badge badge-cooldown">Cooldown</span>
    return <span class="badge badge-none">{pool.sessionStatus || 'None'}</span>
  }

  // Build hourly bar chart data (24 bars, 0-23h)
  const hourlyBarData = () => {
    const h = hourlyData()
    if (!h || h.length === 0) return null
    const byHour = new Map<number, number>()
    for (const item of h) {
      byHour.set(parseInt(item.hour, 10), item.requests)
    }
    const maxReq = Math.max(...byHour.values(), 1)
    const bars: { hour: number; count: number; pct: number }[] = []
    for (let i = 0; i < 24; i++) {
      const count = byHour.get(i) ?? 0
      bars.push({ hour: i, count, pct: (count / maxReq) * 100 })
    }
    return bars
  }

  const totalHourlyRequests = () => {
    const h = hourlyData()
    if (!h) return 0
    return h.reduce((sum, x) => sum + x.requests, 0)
  }

  const peakHour = () => {
    const h = hourlyData()
    if (!h || h.length === 0) return null
    let best = h[0]
    for (const x of h) if (x.requests > best.requests) best = x
    return { hour: parseInt(best.hour, 10), count: best.requests }
  }

  return (
    <div class="page">
      <h1 class="page-title">Dashboard</h1>

      {/* ── Stat Cards ── */}
      <div class="home-stats-grid">
        <div class="home-stat-card" title="Total requests received today (UTC midnight onwards)">
          <div class="home-stat-icon" style={{ background: 'rgba(137,180,250,0.15)', color: 'var(--primary)' }}>⬡</div>
          <div>
            <div class="home-stat-label">TODAY REQUESTS</div>
            <div class="home-stat-value">{usage()?.today?.requests ?? '-'}</div>
          </div>
        </div>
        <div class="home-stat-card" title="Total prompt-side (input) tokens consumed today">
          <div class="home-stat-icon" style={{ background: 'rgba(166,227,161,0.15)', color: 'var(--accent-green)' }}>↓</div>
          <div>
            <div class="home-stat-label">TOKENS IN</div>
            <div class="home-stat-value">{usage()?.today?.tokens_in ? formatCompactNumber(usage()!.today.tokens_in) : '-'}</div>
          </div>
        </div>
        <div class="home-stat-card" title="Total completion-side (output) tokens generated today">
          <div class="home-stat-icon" style={{ background: 'rgba(203,166,247,0.15)', color: 'var(--accent-mauve)' }}>↑</div>
          <div>
            <div class="home-stat-label">TOKENS OUT</div>
            <div class="home-stat-value">{usage()?.today?.tokens_out ? formatCompactNumber(usage()!.today.tokens_out) : '-'}</div>
          </div>
        </div>
        <div class="home-stat-card" title="Average response latency across all requests today">
          <div class="home-stat-icon" style={{ background: 'rgba(249,226,175,0.15)', color: '#f9e2af' }}>⏱</div>
          <div>
            <div class="home-stat-label">AVG LATENCY</div>
            <div class="home-stat-value">{usage()?.today?.avg_latency_ms ? Math.round(usage()!.today.avg_latency_ms) + 'ms' : '-'}</div>
          </div>
        </div>
      </div>

      {/* ── Per-Model Active Sessions ── */}
      <Show when={status()?.active_by_model && Object.keys(status()!.active_by_model).length > 0}>
        <div class="card" title="Number of active sessions per model group">
          <h2 class="card-title">ACTIVE SESSIONS BY MODEL</h2>
          <div class="model-breakdown">
            <For each={Object.entries(status()!.active_by_model)}>
              {([model, count]) => (
                <div class="model-badge">
                  <span class="model-name">{model}</span>
                  <span class="model-count mono">{count} active</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ── Hourly Activity Chart ── */}
      <Show when={hourlyBarData()}>
        <div class="card home-hourly-card" title="Request volume per hour today. Hover each bar for details.">
          <div class="home-hourly-header">
            <div>
              <h2 class="card-title">HOURLY ACTIVITY</h2>
              <p class="text-muted" style={{ 'font-size': '0.72rem' }}>Request volume per hour today</p>
            </div>
            <div class="home-hourly-stats">
              <span class="home-hourly-stat" title="Total requests today">
                <span class="home-hourly-stat-val mono">{totalHourlyRequests()}</span>
                <span class="home-hourly-stat-lbl">total</span>
              </span>
              <Show when={peakHour()}>
                <span class="home-hourly-stat" title="Busiest hour and its request count">
                  <span class="home-hourly-stat-val mono">{String(peakHour()!.hour).padStart(2, '0')}:00</span>
                  <span class="home-hourly-stat-lbl">peak ({peakHour()!.count})</span>
                </span>
              </Show>
            </div>
          </div>
          <div class="home-hourly-bars">
            <For each={hourlyBarData()!}>
              {(bar) => (
                <div class="home-hourly-bar-wrap">
                  <div class="chart-tooltip">
                    <span class="chart-tooltip-title">{String(bar.hour).padStart(2, '0')}:00</span>
                    <span class="chart-tooltip-value">{bar.count} requests</span>
                  </div>
                  <div
                    class="home-hourly-bar"
                    style={{
                      height: `${Math.max(bar.pct, 2)}%`,
                      background: bar.count > 0
                        ? `linear-gradient(to top, var(--primary), rgba(137,180,250,0.6))`
                        : 'var(--border-color)',
                    }}
                  />
                  <span class="home-hourly-label">{bar.hour % 3 === 0 ? `${String(bar.hour).padStart(2, '0')}` : ''}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ── Model Breakdown ── */}
      <Show when={modelBreakdown() && modelBreakdown()!.length > 0}>
        <div class="card">
          <h2 class="card-title">MODEL BREAKDOWN (TODAY)</h2>
          <div class="model-breakdown">
            <For each={modelBreakdown()}>
              {(m) => (
                <div class="model-badge" title={`${m.model} — ${m.requests} requests, ${formatCompactNumber(m.tokens_in)} tokens in, ${formatCompactNumber(m.tokens_out)} tokens out`}>
                  <span class="model-name">{m.model}</span>
                  <span class="model-count mono">{m.requests} req</span>
                  <span class="model-tokens mono">{formatCompactNumber(m.tokens_in + m.tokens_out)} tok</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ── Account Status ── */}
      <div class="card">
        <h2 class="card-title">ACCOUNT STATUS</h2>
        <div class="account-strip">
          <Show when={pools().length > 0} fallback={<div class="text-muted">No accounts configured</div>}>
            <For each={pools()}>
              {(pool) => (
                <div class="account-chip">
                  <span class="account-name">{pool.name}</span>
                  <span class="account-model">{pool.sessionModel}</span>
                  {statusBadge(pool)}
                  <Show when={pool.sessionStatus === 'queued'}>
                    <div class="queue-detail">
                      <span class="mono">Position: {pool.sessionPosition}/{pool.sessionQueueDepth}</span>
                      <Show when={pool.sessionEstWaitMs > 0}>
                        <span class="mono"> ~{formatDuration(pool.sessionEstWaitMs)} wait</span>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* ── Recent Requests ── */}
      <Show when={recentRequests().length > 0}>
        <div class="card">
          <h2 class="card-title">RECENT REQUESTS</h2>
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>MODEL</th>
                  <th>STATUS</th>
                  <th>LATENCY</th>
                </tr>
              </thead>
              <tbody>
                <For each={recentRequests()}>
                  {(r) => (
                    <tr>
                      <td class="mono">{new Date(r.created_at).toLocaleTimeString()}</td>
                      <td>{r.model}</td>
                      <td>{r.status_code}</td>
                      <td class="mono">{r.latency_ms ? r.latency_ms + 'ms' : '-'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </Show>
    </div>
  )
}
