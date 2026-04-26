import { createSignal, onCleanup, For, Show, createEffect } from 'solid-js'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'

interface Account {
  id: string
  name: string
  email: string
  user_id: string
  session_model: string
  added_at: string
  paused: boolean
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

export default function AccountsPanel() {
  const [accounts, setAccounts] = createSignal<Account[]>([])
  const [pools, setPools] = createSignal<Pool[]>([])
  const [showAdd, setShowAdd] = createSignal(false)
  const [addMode, setAddMode] = createSignal<'manual' | 'web'>('web')
  const [token, setToken] = createSignal('')
  const [name, setName] = createSignal('')
  const [email, setEmail] = createSignal('')
  const [model, setModel] = createSignal('minimax-m2.7')
  const [loading, setLoading] = createSignal(false)
  const [authFlowId, setAuthFlowId] = createSignal<string | null>(null)
  const [authFlowUrl, setAuthFlowUrl] = createSignal<string | null>(null)
  const [authFlowStatus, setAuthFlowStatus] = createSignal<string>('pending')
  const [authFlowPollCount, setAuthFlowPollCount] = createSignal(0)
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)
  const [toasts, setToasts] = createSignal<{ id: number; msg: string; type: string }[]>([])
  let toastId = 0

  const addToast = (msg: string, type = 'info') => {
    const id = ++toastId
    setToasts(prev => [...prev, { id, msg, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
  }

  const refresh = async () => {
    try {
      const [acctData, poolData] = await Promise.all([
        apiGet<{ accounts: Account[] }>('/api/accounts'),
        apiGet<{ pools: Pool[] }>('/api/pools'),
      ])
      setAccounts(acctData.accounts)
      setPools(poolData.pools)
    } catch {}
  }

  refresh()
  const interval = setInterval(refresh, 3000)
  onCleanup(() => clearInterval(interval))

  // Poll auth flow status when active
  let authFlowPoll: ReturnType<typeof setInterval> | null = null
  const startAuthFlowPoll = (flowId: string) => {
    if (authFlowPoll) clearInterval(authFlowPoll)
    authFlowPoll = setInterval(async () => {
      try {
        const data = await apiGet<{ status: string; accountId?: string; error?: string }>(`/api/accounts/flows/${flowId}/status`)
        setAuthFlowStatus(data.status)
        setAuthFlowPollCount(prev => prev + 1)
        if (data.status === 'authenticated' || data.status === 'failed') {
          if (authFlowPoll) clearInterval(authFlowPoll)
          setAuthFlowId(null)
          setAuthFlowUrl(null)
          setShowAdd(false)
          refresh()
        }
      } catch {}
    }, 3000)
  }
  onCleanup(() => { if (authFlowPoll) clearInterval(authFlowPoll) })

  const handleAddManual = async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await apiPost('/api/accounts', {
        token: token(),
        name: name() || undefined,
        email: email() || undefined,
        session_model: model(),
      })
      setShowAdd(false)
      setToken('')
      setName('')
      setEmail('')
      refresh()
    } catch (err) {
      setErrorMsg('Failed to add account: ' + err)
    } finally {
      setLoading(false)
    }
  }

  const handleAddWebAuth = async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const data = await apiPost<{ ok: boolean; loginUrl: string; flowId: string }>('/api/accounts', {
        name: name() || undefined,
        session_model: model(),
      })
      setAuthFlowUrl(data.loginUrl)
      setAuthFlowId(data.flowId)
      setAuthFlowStatus('pending')
      setAuthFlowPollCount(0)
      startAuthFlowPoll(data.flowId)
    } catch (err) {
      setErrorMsg('Failed to start auth flow: ' + err)
    } finally {
      setLoading(false)
    }
  }

  const handleCancelAuthFlow = async () => {
    const flowId = authFlowId()
    if (!flowId) return
    if (authFlowPoll) clearInterval(authFlowPoll)
    try { await apiPost(`/api/accounts/flows/${flowId}/cancel`) } catch {}
    setAuthFlowId(null)
    setAuthFlowUrl(null)
    setAuthFlowStatus('pending')
    setAuthFlowPollCount(0)
    setShowAdd(false)
  }

  const handlePause = async (id: string, paused: boolean) => {
    await apiPatch(`/api/accounts/${id}`, { paused })
    refresh()
  }

  const handleDelete = async (id: string) => {
    setConfirmDelete(id)
  }

  const confirmDeleteAccount = async () => {
    const id = confirmDelete()
    if (!id) return
    setConfirmDelete(null)
    await apiDelete(`/api/accounts/${id}`)
    refresh()
  }

  const handleSwitchModel = async (id: string, newModel: string) => {
    const shortModel = newModel.split('/').pop() ?? newModel
    addToast(`Switching to ${shortModel}...`, 'info')
    await apiPatch(`/api/accounts/${id}`, { session_model: newModel })
    refresh()
  }

  const getPool = (id: string) => pools().find(p => p.name === id)

  const prevStatus = new Map<string, string>()
  createEffect(() => {
    for (const p of pools()) {
      const prev = prevStatus.get(p.name)
      if (prev && prev !== p.sessionStatus) {
        const short = p.sessionModel.split('/').pop() ?? p.sessionModel
        if (p.sessionStatus === 'active') addToast(`${p.name}: ${short} is active`, 'success')
        else if (p.sessionStatus === 'queued') addToast(`${p.name}: queued #${p.sessionPosition}/${p.sessionQueueDepth}`, 'info')
        else if (p.sessionStatus === 'ended' || p.sessionStatus === 'superseded') addToast(`${p.name}: session ended`, 'warn')
      }
      prevStatus.set(p.name, p.sessionStatus)
    }
  })

  const formatDuration = (ms: number) => {
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${h}h ${m}m ${s}s`
  }

  const statusBadge = (pool: Pool | undefined) => {
    if (!pool) return <span class="badge badge-none">No Pool</span>
    if (pool.paused) return <span class="badge badge-paused">Paused</span>
    if (pool.switching) return <span class="badge badge-queued">Switching...</span>
    if (pool.sessionStatus === 'active') {
      const remaining = pool.sessionExpiresAt ? Math.max(0, new Date(pool.sessionExpiresAt).getTime() - Date.now()) : 0
      return <span class="badge badge-active">Active ({formatDuration(remaining)})</span>
    }
    if (pool.sessionStatus === 'queued') {
      const wait = pool.sessionEstWaitMs > 0 ? ` (~${formatDuration(pool.sessionEstWaitMs)})` : ''
      return (
        <span class="badge badge-queued">
          Queued #{pool.sessionPosition}/{pool.sessionQueueDepth}{wait}
        </span>
      )
    }
    if (pool.cooldownUntil) return <span class="badge badge-cooldown">Cooldown</span>
    return <span class="badge badge-none">{pool.sessionStatus || 'None'}</span>
  }

  // Group accounts by model for the model→account binding view
  const accountsByModel = () => {
    const map = new Map<string, Account[]>()
    for (const acct of accounts()) {
      const m = acct.session_model
      if (!map.has(m)) map.set(m, [])
      map.get(m)!.push(acct)
    }
    return [...map.entries()]
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button class="btn btn-primary" onClick={() => setShowAdd(!showAdd())}>+ Add Account</button>
      </div>

      <Show when={errorMsg()}>
        <div class="card error-banner">
          <span class="error-text">{errorMsg()}</span>
          <button class="btn btn-sm" onClick={() => setErrorMsg(null)}>Dismiss</button>
        </div>
      </Show>

      <Show when={confirmDelete()}>
        <div class="card confirm-dialog">
          <p>Remove this account? This cannot be undone.</p>
          <div class="confirm-actions">
            <button class="btn btn-sm btn-danger" onClick={confirmDeleteAccount}>Remove</button>
            <button class="btn btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
          </div>
        </div>
      </Show>

      <Show when={showAdd()}>
        <div class="card">
          <h2 class="card-title">ADD ACCOUNT</h2>
          <Show when={!authFlowId()}>
            <div class="form-grid" style={{ 'margin-bottom': '12px' }}>
              <button class="btn btn-sm" classList={{ 'btn-primary': addMode() === 'web' }} onClick={() => setAddMode('web')}>Web Auth</button>
              <button class="btn btn-sm" classList={{ 'btn-primary': addMode() === 'manual' }} onClick={() => setAddMode('manual')}>Manual Token</button>
            </div>
            <Show when={addMode() === 'web'}>
              <div class="form-grid">
                <input placeholder="Name (optional)" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
                <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
                  <option value="minimax-m2.7">minimax-m2.7</option>
                  <option value="glm-5.1">glm-5.1</option>
                </select>
                <button class="btn btn-primary" onClick={handleAddWebAuth} disabled={loading()}>
                  {loading() ? 'Starting...' : 'Start Auth Flow'}
                </button>
              </div>
            </Show>
            <Show when={addMode() === 'manual'}>
              <div class="form-grid">
                <input placeholder="Auth Token" value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
                <input placeholder="Name" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
                <input placeholder="Email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
                <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
                  <option value="minimax-m2.7">minimax-m2.7</option>
                  <option value="glm-5.1">glm-5.1</option>
                </select>
                <button class="btn btn-primary" onClick={handleAddManual} disabled={loading() || !token()}>
                  {loading() ? 'Adding...' : 'Add'}
                </button>
              </div>
            </Show>
          </Show>
          <Show when={authFlowId()}>
            <div class="auth-flow-status">
              <p>Open this URL to authenticate:</p>
              <a href={authFlowUrl()!} target="_blank" rel="noopener" class="auth-flow-link">{authFlowUrl()}</a>
              <p class="text-muted">
                <span class="poll-indicator" />
                Polling... (status: {authFlowStatus()}, check #{authFlowPollCount()})
              </p>
              <button class="btn btn-sm btn-danger" onClick={handleCancelAuthFlow}>Cancel Login</button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={accounts().length > 0} fallback={<div class="card"><p class="text-muted">No accounts configured.</p></div>}>
        <div class="card">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>EMAIL</th>
                  <th>MODEL</th>
                  <th>STATUS</th>
                  <th>QUEUE DETAIL</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                <For each={accounts()} by={acct => acct.id}>
                  {(acct) => {
                    const pool = () => getPool(acct.id)
                    return (
                      <tr>
                        <td>{acct.name}</td>
                        <td class="mono">{acct.email}</td>
                        <td>
                          <select
                            value={acct.session_model}
                            onChange={(e) => handleSwitchModel(acct.id, e.currentTarget.value)}
                            disabled={acct.paused}
                          >
                            <option value="minimax/minimax-m2.7">minimax/minimax-m2.7</option>
                            <option value="z-ai/glm-5.1">z-ai/glm-5.1</option>
                          </select>
                        </td>
                        <td>{statusBadge(pool())}</td>
                        <td class="mono">
                          <Show when={pool()?.sessionStatus === 'queued'}>
                            Position {pool()!.sessionPosition} of {pool()!.sessionQueueDepth}
                            <Show when={pool()!.sessionEstWaitMs > 0}>
                              <br />~{formatDuration(pool()!.sessionEstWaitMs)} wait
                            </Show>
                          </Show>
                        </td>
                        <td class="actions">
                          <Show when={!acct.paused} fallback={
                            <button class="btn btn-sm" onClick={() => handlePause(acct.id, false)}>Resume</button>
                          }>
                            <button class="btn btn-sm" onClick={() => handlePause(acct.id, true)}>Pause</button>
                          </Show>
                          <button class="btn btn-sm btn-danger" onClick={() => handleDelete(acct.id)}>Remove</button>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </Show>

      <Show when={accountsByModel().length > 0}>
        <div class="card">
          <h2 class="card-title">MODEL BINDINGS</h2>
          <div class="model-binding-grid">
            <For each={accountsByModel()} by={([model]) => model}>
              {([model, accts]) => (
                <div class="model-binding-row">
                  <div class="model-binding-model mono">{model}</div>
                  <div class="model-binding-accounts">
                    <For each={accts} by={acct => acct.id}>
                      {(acct) => {
                        const pool = () => getPool(acct.id)
                        return (
                          <div class="model-binding-acct">
                            <span>{acct.name}</span>
                            {statusBadge(pool())}
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="toast-container">
        <For each={toasts()} by={t => t.id}>
          {(t) => (
            <div class={`toast toast-${t.type}`}>{t.msg}</div>
          )}
        </For>
      </div>
    </div>
  )
}
