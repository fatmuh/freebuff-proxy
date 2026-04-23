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

export default function HomePage() {
  const [usage] = createResource(() => apiGet<UsageSummary>('/api/usage/summary'))
  const [pools, setPools] = createSignal<Pool[]>([])
  const [modelBreakdown] = createResource(() => apiGet<ModelUsage[]>('/api/usage/by-model?days=1'))
  const [hourlyData] = createResource(() => apiGet<HourlyUsage[]>('/api/usage/hourly'))
  const [recentRequests, setRecentRequests] = createSignal<RecentRequest[]>([])

  const poll = async () => {
    try {
      const [poolsData, reqsData] = await Promise.all([
        apiGet<{ pools: Pool[] }>('/api/pools'),
        apiGet<{ rows: RecentRequest[] }>('/api/requests?limit=5'),
      ])
      setPools(poolsData.pools)
      setRecentRequests(reqsData.rows)
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

  const sparklinePoints = () => {
    const h = hourlyData()
    if (!h || h.length === 0) return ''
    // Build 24 data points (hours 0-23), fill missing with 0
    const byHour = new Map<number, number>()
    for (const item of h) {
      byHour.set(parseInt(item.hour, 10), item.requests)
    }
    const maxReq = Math.max(...byHour.values(), 1)
    const points: string[] = []
    const width = 240
    const height = 40
    for (let i = 0; i < 24; i++) {
      const x = (i / 23) * width
      const val = byHour.get(i) ?? 0
      const y = height - (val / maxReq) * height
      points.push(`${x},${y}`)
    }
    return points.join(' ')
  }

  return (
    <div class="page">
      <h1 class="page-title">Dashboard</h1>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">TODAY REQUESTS</div>
          <div class="stat-value">{usage()?.today?.requests ?? '-'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">TOKENS IN</div>
          <div class="stat-value">{usage()?.today?.tokens_in?.toLocaleString() ?? '-'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">TOKENS OUT</div>
          <div class="stat-value">{usage()?.today?.tokens_out?.toLocaleString() ?? '-'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">AVG LATENCY</div>
          <div class="stat-value">{usage()?.today?.avg_latency_ms ? Math.round(usage()!.today.avg_latency_ms) + 'ms' : '-'}</div>
        </div>
      </div>

      <Show when={modelBreakdown() && modelBreakdown()!.length > 0}>
        <div class="card">
          <h2 class="card-title">MODEL BREAKDOWN (TODAY)</h2>
          <div class="model-breakdown">
            <For each={modelBreakdown()}>
              {(m) => (
                <div class="model-badge">
                  <span class="model-name">{m.model}</span>
                  <span class="model-count mono">{m.requests} requests</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={sparklinePoints()}>
        <div class="card">
          <h2 class="card-title">REQUESTS / HOUR TODAY</h2>
          <svg viewBox="0 0 240 40" class="sparkline" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--primary, #89b4fa)"
              stroke-width="1.5"
              points={sparklinePoints()}
            />
          </svg>
        </div>
      </Show>

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
