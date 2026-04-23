import { createSignal, createResource, For, Show, onCleanup, createMemo, createEffect } from 'solid-js'
import { apiGet } from '../lib/api'
import {
  Chart,
  BarController,
  BarElement,
  LineController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, PointElement, LineElement, Tooltip, Legend)

// ── External HTML tooltip for Chart.js ──────────────────────
// Uses document.body for proper viewport-relative positioning.
let tooltipEl: HTMLDivElement | null = null

const getOrCreateTooltipEl = (): HTMLDivElement => {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div')
    tooltipEl.id = 'chartjs-tooltip'
    tooltipEl.innerHTML = '<table></table>'
    document.body.appendChild(tooltipEl)
  }
  return tooltipEl
}

const externalTooltipHandler = (context: { chart: any; tooltip: any }) => {
  const { chart, tooltip } = context
  const el = getOrCreateTooltipEl()

  if (tooltip.opacity === 0) {
    el.style.opacity = '0'
    return
  }

  if (tooltip.body) {
    const titleLines = tooltip.title || []
    const bodyLines = tooltip.body.map((b: any) => b.lines)

    let innerHtml = '<thead>'
    for (const title of titleLines) {
      innerHtml += `<tr><th class="cjs-tt-title">${title}</th></tr>`
    }
    innerHtml += '</thead><tbody>'

    bodyLines.forEach((body: string[], i: number) => {
      // Get color directly from dataset (not from labelColors, which can be empty with pointRadius: 0)
      const dataset = chart.data.datasets[tooltip.dataPoints[i].datasetIndex]
      const color = dataset.pointBackgroundColor || dataset.borderColor || '#89b4fa'
      const style = `background:${color};border-color:${color};border-width:0;width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px;flex-shrink:0`
      innerHtml += `<tr><td class="cjs-tt-row"><span style="${style}"></span>${body}</td></tr>`
    })
    innerHtml += '</tbody>'
    el.querySelector('table')!.innerHTML = innerHtml
  }

  const rect = chart.canvas.getBoundingClientRect()
  el.style.opacity = '1'
  el.style.position = 'absolute'
  el.style.left = `${rect.left + window.pageXOffset + tooltip.caretX}px`
  el.style.top = `${rect.top + window.pageYOffset + tooltip.caretY}px`
  el.style.pointerEvents = 'none'
}

// ── Types ────────────────────────────────────────────────────

interface AnalyticsTotals {
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

interface BarBucketModel {
  model: string
  inputTokens: number
  outputTokens: number
}

interface BarBucket {
  t: string
  models: BarBucketModel[]
}

interface LinePoint {
  t: string
  tokens: number
  request_count: number
}

interface ModelUsageRow {
  model: string
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

interface UsageAnalyticsResponse {
  timeframe: { key: string; bucket_seconds: number; start_at: string | null; end_at: string }
  api_key_id: string | null
  totals: AnalyticsTotals
  usage_over_time: BarBucket[]
  usage_lines: LinePoint[]
  model_usage: ModelUsageRow[]
}

interface ApiKeyInfo {
  id: string
  name: string
}

const TIMEFRAMES = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: '30d' },
  { value: '7d', label: '7d' },
  { value: '3d', label: '3d' },
  { value: '1d', label: '24h' },
]

const CHART_COLORS = [
  '#89b4fa',
  '#a6e3a1',
  '#cba6f7',
  '#f9e2af',
  '#f38ba8',
  '#94e2d5',
  '#fab387',
  '#b4befe',
]

// ── Helpers ───────────────────────────────────────────────────

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatXLabel(iso: string, tf: string): string {
  const d = new Date(iso)
  if (tf === '1d') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (tf === '3d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatTokenTick(v: number): string {
  if (v === 0) return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`
  return String(Math.round(v))
}

// ── Component ─────────────────────────────────────────────────

export default function UsagePage() {
  const [timeframe, setTimeframe] = createSignal('1d')
  const [apiKeyId, setApiKeyId] = createSignal<string | null>(null)

  // Chart refs (native, not through solid-chartjs)
  let barCanvasRef: HTMLCanvasElement | undefined
  let lineCanvasRef: HTMLCanvasElement | undefined
  let barChartInstance: Chart | undefined
  let lineChartInstance: Chart | undefined

  const [analytics] = createResource(() => {
    const tf = timeframe()
    const akid = apiKeyId()
    const params = new URLSearchParams({ timeframe: tf })
    if (akid) params.set('apiKeyId', akid)
    return `/api/usage-analytics?${params}`
  }, (url: string) => apiGet<UsageAnalyticsResponse>(url))

  const [apiKeys] = createResource(() => apiGet<{ keys: ApiKeyInfo[] }>('/api/keys'))

  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => setTick(t => t + 1), 30_000)
  onCleanup(() => clearInterval(interval))

  const data = () => analytics()

  // ── Build chart configs reactively ──────────────────────────

  const barChartConfig = createMemo(() => {
    const buckets = analytics()?.usage_over_time
    if (!buckets || buckets.length === 0) return null

    const tf = timeframe()
    const modelSet = new Set<string>()
    for (const b of buckets) for (const m of b.models) modelSet.add(m.model)
    const models = Array.from(modelSet).sort()

    const inputDatasets = models.map((model, i) => ({
      label: `${model} (in)`,
      data: buckets.map(b => {
        const m = b.models.find(x => x.model === model)
        return m ? m.inputTokens : 0
      }),
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '33',
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      borderWidth: 1,
      stack: 'input',
    }))

    const outputDatasets = models.map((model, i) => ({
      label: `${model} (out)`,
      data: buckets.map(b => {
        const m = b.models.find(x => x.model === model)
        return m ? m.outputTokens : 0
      }),
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + 'E6',
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      borderWidth: 1,
      stack: 'output',
    }))

    return {
      type: 'bar' as const,
      data: {
        labels: buckets.map(b => formatXLabel(b.t, tf)),
        datasets: [...inputDatasets, ...outputDatasets],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, labels: { color: '#cdd6f4', font: { size: 10 } } },
          tooltip: {
            enabled: false,
            position: 'nearest',
            external: externalTooltipHandler,
            callbacks: {
              label: (ctx: any) => ` ${ctx.dataset.label}: ${formatCompactNumber(ctx.parsed.y)} tokens`,
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#a6adc8', font: { size: 10 }, maxRotation: 45 },
            grid: { display: false },
          },
          y: {
            stacked: true,
            ticks: { color: '#a6adc8', font: { size: 10 }, callback: (v: number) => formatTokenTick(v) },
            grid: { color: 'rgba(49,50,68,0.5)' },
          },
        },
      },
    }
  })

  const lineChartConfig = createMemo(() => {
    const points = analytics()?.usage_lines
    if (!points || points.length === 0) return null
    const tf = timeframe()
    return {
      type: 'line' as const,
      data: {
        labels: points.map(p => formatXLabel(p.t, tf)),
        datasets: [
          {
            label: 'Tokens',
            data: points.map(p => p.tokens),
            borderColor: '#89b4fa',
            pointBackgroundColor: '#89b4fa',
            backgroundColor: 'rgba(137,180,250,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            yAxisID: 'tokens',
          },
          {
            label: 'Requests',
            data: points.map(p => p.request_count),
            borderColor: '#a6e3a1',
            pointBackgroundColor: '#a6e3a1',
            backgroundColor: 'rgba(166,227,161,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            yAxisID: 'requests',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, labels: { color: '#cdd6f4', font: { size: 10 } } },
          tooltip: {
            enabled: false,
            position: 'nearest',
            external: externalTooltipHandler,
            callbacks: {
              label: (ctx: any) => {
                const label = ctx.dataset.label
                const val = ctx.parsed.y
                return label === 'Tokens'
                  ? ` Tokens: ${formatCompactNumber(val)}`
                  : ` Requests: ${val}`
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#a6adc8', font: { size: 10 }, maxRotation: 45 },
            grid: { display: false },
          },
          tokens: {
            type: 'linear' as const,
            position: 'left' as const,
            ticks: { color: '#89b4fa', font: { size: 10 }, callback: (v: number) => formatTokenTick(v) },
            grid: { color: 'rgba(49,50,68,0.5)' },
          },
          requests: {
            type: 'linear' as const,
            position: 'right' as const,
            ticks: { color: '#a6e3a1', font: { size: 10 } },
            grid: { display: false },
          },
        },
      },
    }
  })

  // ── Manage chart lifecycle imperatively (like opencode) ────
  // This is the KEY difference from solid-chartjs: we control the
  // Chart instance directly, so Chart.js internal plugin state
  // (tooltip, legend, etc.) is properly initialized on each create.

  const createBarChart = () => {
    if (!barCanvasRef) return
    if (barChartInstance) barChartInstance.destroy()
    const config = barChartConfig()
    if (config) barChartInstance = new Chart(barCanvasRef, config)
  }

  const createLineChart = () => {
    if (!lineCanvasRef) return
    if (lineChartInstance) lineChartInstance.destroy()
    const config = lineChartConfig()
    if (config) lineChartInstance = new Chart(lineCanvasRef, config)
  }

  // Create/recreate charts when data or filters change
  // createEffect runs AFTER DOM updates, so canvas refs from <Show> are set
  createEffect(() => {
    analytics() // track
    timeframe() // track
    apiKeyId()  // track
    tick()      // track
    createBarChart()
    createLineChart()
  })

  onCleanup(() => {
    barChartInstance?.destroy()
    lineChartInstance?.destroy()
  })

  return (
    <div class="page usage-page">
      {/* ── Header ── */}
      <div class="usage-header">
        <div>
          <h1 class="page-title">Usage</h1>
          <p class="text-muted" style={{ 'font-size': '0.85rem', 'margin-top': '-12px', 'margin-bottom': '16px' }}>
            Token analytics from request history, filterable by API key and time range.
          </p>
        </div>
        <div class="usage-filters">
          <Show when={apiKeys()?.keys && apiKeys()!.keys.length > 0}>
            <select
              value={apiKeyId() ?? 'all'}
              onChange={(e) => setApiKeyId(e.currentTarget.value === 'all' ? null : e.currentTarget.value)}
              style={{ width: '180px' }}
            >
              <option value="all">All Keys</option>
              <For each={apiKeys()!.keys}>
                {(k) => <option value={k.id}>{k.name}</option>}
              </For>
            </select>
          </Show>
          <div class="timeframe-pills">
            <For each={TIMEFRAMES}>
              {(tf) => (
                <button
                  class={`tf-pill ${timeframe() === tf.value ? 'tf-pill-active' : ''}`}
                  onClick={() => setTimeframe(tf.value)}
                >
                  {tf.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      <Show when={data()} fallback={<div class="text-muted" style={{ padding: '40px' }}>Loading usage analytics...</div>}>
        {/* ── Stat Cards ── */}
        <div class="usage-stats-grid">
          <div class="usage-stat-card">
            <div class="usage-stat-icon" style={{ background: 'rgba(137,180,250,0.15)', color: 'var(--primary)' }}>⬡</div>
            <div>
              <div class="usage-stat-label">REQUESTS</div>
              <div class="usage-stat-value">{formatCompactNumber(data()!.totals.request_count)}</div>
              <div class="usage-stat-hint">In selected range</div>
            </div>
          </div>
          <div class="usage-stat-card">
            <div class="usage-stat-icon" style={{ background: 'rgba(166,227,161,0.15)', color: 'var(--accent-green)' }}>↓</div>
            <div>
              <div class="usage-stat-label">INPUT TOKENS</div>
              <div class="usage-stat-value">{formatCompactNumber(data()!.totals.input_tokens)}</div>
              <div class="usage-stat-hint">Prompt-side</div>
            </div>
          </div>
          <div class="usage-stat-card">
            <div class="usage-stat-icon" style={{ background: 'rgba(203,166,247,0.15)', color: 'var(--accent-mauve)' }}>↑</div>
            <div>
              <div class="usage-stat-label">OUTPUT TOKENS</div>
              <div class="usage-stat-value">{formatCompactNumber(data()!.totals.output_tokens)}</div>
              <div class="usage-stat-hint">Completion-side</div>
            </div>
          </div>
          <div class="usage-stat-card">
            <div class="usage-stat-icon" style={{ background: 'rgba(249,226,175,0.15)', color: '#f9e2af' }}>Σ</div>
            <div>
              <div class="usage-stat-label">TOTAL TOKENS</div>
              <div class="usage-stat-value">{formatCompactNumber(data()!.totals.total_tokens)}</div>
              <div class="usage-stat-hint">Input + Output</div>
            </div>
          </div>
        </div>

        {/* ── Bar Chart: Token Usage Over Time ── */}
        <div class="card usage-chart-card">
          <div class="usage-chart-header">
            <div>
              <h2 class="card-title">TOKEN USAGE OVER TIME</h2>
              <p class="text-muted" style={{ 'font-size': '0.75rem' }}>
                Stacked bars per model. Outlined = input, Solid = output.
              </p>
            </div>
            <Show when={data()!.timeframe}>
              <span class="badge">{data()!.timeframe.key}</span>
            </Show>
          </div>
          <Show when={barChartConfig()} fallback={<div class="text-muted" style={{ padding: '40px', 'text-align': 'center' }}>No token usage data in this range</div>}>
            <div style={{ height: '320px' }}>
              <canvas ref={barCanvasRef} />
            </div>
          </Show>
          <Show when={barChartConfig()}>
            <div class="usage-legend-strip">
              <span class="legend-hint">Outlined = Input</span>
              <span class="legend-hint">Solid = Output</span>
              <For each={(() => {
                const buckets = data()!.usage_over_time
                const ms = new Set<string>()
                for (const b of buckets) for (const m of b.models) ms.add(m.model)
                return Array.from(ms).sort()
              })()}>
                {(model, i) => (
                  <span class="legend-model-pill">
                    <span class="legend-dot" style={{ background: CHART_COLORS[i() % CHART_COLORS.length] }}></span>
                    {model}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* ── Line Chart: Usage Trend ── */}
        <div class="card usage-chart-card">
          <div class="usage-chart-header">
            <div>
              <h2 class="card-title">USAGE TREND</h2>
              <p class="text-muted" style={{ 'font-size': '0.75rem' }}>
                Tokens and request count over time.
              </p>
            </div>
          </div>
          <Show when={lineChartConfig()} fallback={<div class="text-muted" style={{ padding: '40px', 'text-align': 'center' }}>No usage trend data in this range</div>}>
            <div style={{ height: '280px' }}>
              <canvas ref={lineCanvasRef} />
            </div>
          </Show>
        </div>

        {/* ── Model Usage Table ── */}
        <div class="card">
          <h2 class="card-title">MODEL USAGE</h2>
          <Show when={data()!.model_usage.length > 0} fallback={<div class="text-muted" style={{ padding: '20px', 'text-align': 'center' }}>No model usage data in this range</div>}>
            <div class="table-wrapper">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th class="text-right">Requests</th>
                    <th class="text-right">Input</th>
                    <th class="text-right">Output</th>
                    <th class="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={data()!.model_usage}>
                    {(row) => (
                      <tr>
                        <td style={{ 'font-family': 'JetBrains Mono, monospace', 'font-size': '0.8rem' }}>{row.model}</td>
                        <td class="text-right mono">{formatCompactNumber(row.request_count)}</td>
                        <td class="text-right mono">{formatCompactNumber(row.input_tokens)}</td>
                        <td class="text-right mono">{formatCompactNumber(row.output_tokens)}</td>
                        <td class="text-right mono">{formatCompactNumber(row.total_tokens)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
