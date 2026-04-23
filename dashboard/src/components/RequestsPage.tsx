import { createSignal, createResource, For, Show, onCleanup } from 'solid-js'
import { apiGet } from '../lib/api'

interface RequestLog {
  id: number
  created_at: string
  api_key: string | null
  account_id: string | null
  model: string
  agent_id: string | null
  run_id: string | null
  status_code: number | null
  tokens_in: number | null
  tokens_out: number | null
  latency_ms: number | null
  error: string | null
  is_stream: number
}

interface DailyUsage {
  date: string
  requests: number
  tokens_in: number
  tokens_out: number
}

export default function RequestsPage() {
  const [page, setPage] = createSignal(1)
  const [total, setTotal] = createSignal(0)
  const [rows, setRows] = createSignal<RequestLog[]>([])
  const [filterModel, setFilterModel] = createSignal('')
  const [filterStatus, setFilterStatus] = createSignal('')
  const [fromDate, setFromDate] = createSignal('')
  const [toDate, setToDate] = createSignal('')
  const [autoRefresh, setAutoRefresh] = createSignal(true)

  const [dailyUsage] = createResource(() => apiGet<DailyUsage[]>('/api/usage/daily'))

  const refresh = async () => {
    const params = new URLSearchParams()
    params.set('page', String(page()))
    params.set('limit', '50')
    if (filterModel()) params.set('model', filterModel())
    if (filterStatus()) params.set('status', filterStatus())
    if (fromDate()) params.set('from', fromDate())
    if (toDate()) params.set('to', toDate())

    try {
      const data = await apiGet<{ rows: RequestLog[]; total: number }>(`/api/requests?${params}`)
      setRows(data.rows)
      setTotal(data.total)
    } catch {}
  }

  refresh()
  const interval = setInterval(() => {
    if (autoRefresh()) refresh()
  }, 5000)
  onCleanup(() => clearInterval(interval))

  const exportCsv = () => {
    const header = 'time,model,account,status,tokens_in,tokens_out,latency,error'
    const csvRows = rows().map(r =>
      `${r.created_at},${r.model},${r.account_id ?? ''},${r.status_code},${r.tokens_in ?? ''},${r.tokens_out ?? ''},${r.latency_ms ?? ''},${(r.error ?? '').replace(/,/g, ';')}`
    )
    const csv = [header, ...csvRows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `requests-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totalPages = () => Math.ceil(total() / 50)

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Requests</h1>
        <div class="header-actions">
          <button class="btn btn-sm" onClick={exportCsv}>Export CSV</button>
          <label class="toggle-label">
            <input type="checkbox" checked={autoRefresh()} onChange={(e) => setAutoRefresh(e.currentTarget.checked)} />
            Auto-refresh
          </label>
        </div>
      </div>

      <Show when={dailyUsage() && dailyUsage()!.length > 0}>
        <div class="card">
          <h2 class="card-title">DAILY USAGE</h2>
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>DATE</th>
                  <th>REQUESTS</th>
                  <th>TOKENS IN</th>
                  <th>TOKENS OUT</th>
                </tr>
              </thead>
              <tbody>
                <For each={dailyUsage()?.slice(0, 10)}>
                  {(d) => (
                    <tr>
                      <td class="mono">{d.date}</td>
                      <td class="mono">{d.requests.toLocaleString()}</td>
                      <td class="mono">{d.tokens_in.toLocaleString()}</td>
                      <td class="mono">{d.tokens_out.toLocaleString()}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </Show>

      <div class="card">
        <h2 class="card-title">FILTERS</h2>
        <div class="filter-row">
          <input placeholder="Model" value={filterModel()} onInput={(e) => setFilterModel(e.currentTarget.value)} />
          <input placeholder="Status code" value={filterStatus()} onInput={(e) => setFilterStatus(e.currentTarget.value)} />
          <input type="date" value={fromDate()} onInput={(e) => setFromDate(e.currentTarget.value)} />
          <input type="date" value={toDate()} onInput={(e) => setToDate(e.currentTarget.value)} />
          <button class="btn btn-primary" onClick={() => { setPage(1); refresh() }}>Apply</button>
        </div>
      </div>

      <div class="card">
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>TIME</th>
                <th>MODEL</th>
                <th>ACCOUNT</th>
                <th>STATUS</th>
                <th>TOKENS IN</th>
                <th>TOKENS OUT</th>
                <th>LATENCY</th>
                <th>ERROR</th>
              </tr>
            </thead>
            <tbody>
              <Show when={rows().length > 0} fallback={
                <tr><td colspan={8} class="text-muted">No requests found</td></tr>
              }>
                <For each={rows()}>
                  {(r) => (
                    <tr>
                      <td class="mono">{new Date(r.created_at).toLocaleString()}</td>
                      <td>{r.model}</td>
                      <td>{r.account_id ?? '-'}</td>
                      <td class="mono">{r.status_code ?? '-'}</td>
                      <td class="mono">{r.tokens_in?.toLocaleString() ?? '-'}</td>
                      <td class="mono">{r.tokens_out?.toLocaleString() ?? '-'}</td>
                      <td class="mono">{r.latency_ms ? r.latency_ms + 'ms' : '-'}</td>
                      <td class="error-cell">{r.error ? r.error.slice(0, 60) : '-'}</td>
                    </tr>
                  )}
                </For>
              </Show>
            </tbody>
          </table>
        </div>
        <div class="pagination">
          <span class="text-muted">{total()} total</span>
          <Show when={page() > 1}>
            <button class="btn btn-sm" onClick={() => { setPage(page() - 1); refresh() }}>Prev</button>
          </Show>
          <span class="text-muted">Page {page()} / {totalPages() || 1}</span>
          <Show when={page() < totalPages()}>
            <button class="btn btn-sm" onClick={() => { setPage(page() + 1); refresh() }}>Next</button>
          </Show>
        </div>
      </div>
    </div>
  )
}
