import { createSignal, onCleanup, createResource, Show, For } from 'solid-js'
import { apiGet } from '../lib/api'

interface UsageSummary {
  today: { requests: number; tokens_in: number; tokens_out: number; avg_latency_ms: number }
}

interface Pool {
  name: string
  sessionModel: string
  sessionStatus: string
  sessionPosition: number
  sessionQueueDepth: number
  sessionEstWaitMs: number
  cooldownUntil: string | null
  lastError: string
  paused: boolean
}

interface StatusData {
  running: boolean
  uptime_sec: number
  total_accounts: number
  active_accounts: number
  queued_accounts: number
  queues: { name: string; position: number; depth: number; estimated_wait_ms: number }[]
}

export default function HomePage() {
  const [usage] = createResource(() => apiGet<UsageSummary>('/api/usage/summary'))
  const [pools, setPools] = createSignal<Pool[]>([])
  const [status, setStatus] = createSignal<StatusData | null>(null)
  const [recentRequests, setRecentRequests] = createSignal<any[]>([])

  const poll = async () => {
    try {
      const [poolsData, reqsData, statusData] = await Promise.all([
        apiGet<{ pools: Pool[] }>('/api/pools'),
        apiGet<{ rows: any[] }>('/api/requests?limit=5'),
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

  const statusBadge = (pool: Pool) => {
    if (pool.paused) return <span class="badge badge-paused">Paused</span>
    if (pool.sessionStatus === 'active') return <span class="badge badge-active">Active</span>
    if (pool.sessionStatus === 'queued') {
      const wait = pool.sessionEstWaitMs > 0 ? ` (~${Math.ceil(pool.sessionEstWaitMs / 1000)}s)` : ''
      return <span class="badge badge-queued">Queued #{pool.sessionPosition}/{pool.sessionQueueDepth}{wait}</span>
    }
    if (pool.cooldownUntil) return <span class="badge badge-cooldown">Cooldown</span>
    return <span class="badge badge-none">{pool.sessionStatus || 'None'}</span>
  }

  const formatUptime = (sec: number) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${h}h ${m}m ${s}s`
  }

  return (
    <div class="page">
      <h1 class="page-title">Dashboard</h1>

      <Show when={status()}>
        <div class="topbar">
          <div class="topbar-item">
            <span class="topbar-dot topbar-dot-green"></span>
            <span>Proxy Running</span>
          </div>
          <div class="topbar-item">
            <span class="topbar-label">UPTIME</span>
            <span class="mono">{formatUptime(status()!.uptime_sec)}</span>
          </div>
          <div class="topbar-item">
            <span class="topbar-label">ACCOUNTS</span>
            <span class="mono">{status()!.total_accounts}</span>
          </div>
          <div class="topbar-item">
            <span class="topbar-label">ACTIVE</span>
            <span class="mono" style={{ color: 'var(--accent-green)' }}>{status()!.active_accounts}</span>
          </div>
          <div class="topbar-item">
            <span class="topbar-label">QUEUED</span>
            <span class="mono" style={{ color: '#f9e2af' }}>{status()!.queued_accounts}</span>
          </div>
        </div>
      </Show>

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
                        <span class="mono"> ~{Math.ceil(pool.sessionEstWaitMs / 1000)}s wait</span>
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
