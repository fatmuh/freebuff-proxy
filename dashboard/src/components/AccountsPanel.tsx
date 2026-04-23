import { createSignal, onCleanup, For, Show } from 'solid-js'
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
  sessionStatus: string
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
  const [token, setToken] = createSignal('')
  const [name, setName] = createSignal('')
  const [email, setEmail] = createSignal('')
  const [model, setModel] = createSignal('minimax/minimax-m2.7')
  const [loading, setLoading] = createSignal(false)

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

  const handleAdd = async () => {
    setLoading(true)
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
      alert('Failed to add account: ' + err)
    } finally {
      setLoading(false)
    }
  }

  const handlePause = async (id: string, paused: boolean) => {
    await apiPatch(`/api/accounts/${id}`, { paused })
    refresh()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this account?')) return
    await apiDelete(`/api/accounts/${id}`)
    refresh()
  }

  const handleSwitchModel = async (id: string, newModel: string) => {
    await apiPatch(`/api/accounts/${id}`, { session_model: newModel })
    refresh()
  }

  const getPool = (id: string) => pools().find(p => p.name === id)

  const statusBadge = (pool: Pool | undefined) => {
    if (!pool) return <span class="badge badge-none">No Pool</span>
    if (pool.paused) return <span class="badge badge-paused">Paused</span>
    if (pool.sessionStatus === 'active') return <span class="badge badge-active">Active</span>
    if (pool.sessionStatus === 'queued') {
      const wait = pool.sessionEstWaitMs > 0 ? ` (~${Math.ceil(pool.sessionEstWaitMs / 1000)}s)` : ''
      return (
        <span class="badge badge-queued">
          Queued #{pool.sessionPosition}/{pool.sessionQueueDepth}{wait}
        </span>
      )
    }
    if (pool.cooldownUntil) return <span class="badge badge-cooldown">Cooldown</span>
    return <span class="badge badge-none">{pool.sessionStatus || 'None'}</span>
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button class="btn btn-primary" onClick={() => setShowAdd(!showAdd())}>+ Add Account</button>
      </div>

      <Show when={showAdd()}>
        <div class="card">
          <h2 class="card-title">ADD ACCOUNT</h2>
          <div class="form-grid">
            <input placeholder="Auth Token" value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
            <input placeholder="Name" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <input placeholder="Email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
            <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
              <option value="minimax/minimax-m2.7">minimax/minimax-m2.7</option>
              <option value="z-ai/glm-5.1">z-ai/glm-5.1</option>
            </select>
            <button class="btn btn-primary" onClick={handleAdd} disabled={loading() || !token()}>
              {loading() ? 'Adding...' : 'Add'}
            </button>
          </div>
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
                <For each={accounts()}>
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
                              <br />~{Math.ceil(pool()!.sessionEstWaitMs / 1000)}s wait
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
    </div>
  )
}
