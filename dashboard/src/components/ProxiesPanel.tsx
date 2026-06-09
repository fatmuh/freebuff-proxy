import { createSignal, onCleanup, For, Show } from 'solid-js'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'

interface BoundAccount {
  id: string
  name: string
  email: string
}

interface Proxy {
  id: string
  name: string
  type: string
  host: string
  port: number
  username: string
  password: string
  created_at: string
  url_safe: string
  bound_accounts: BoundAccount[]
}

export default function ProxiesPanel() {
  const [proxies, setProxies] = createSignal<Proxy[]>([])
  const [showAdd, setShowAdd] = createSignal(false)
  const [name, setName] = createSignal('')
  const [ptype, setPtype] = createSignal<'http' | 'socks5'>('http')
  const [host, setHost] = createSignal('')
  const [port, setPort] = createSignal('1080')
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)
  const [testingId, setTestingId] = createSignal<string | null>(null)
  const [testResult, setTestResult] = createSignal<Record<string, { ok: boolean; latency_ms?: number; error?: string }>>({})
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editName, setEditName] = createSignal('')
  const [editHost, setEditHost] = createSignal('')
  const [editPort, setEditPort] = createSignal('')
  const [editUser, setEditUser] = createSignal('')
  const [editPass, setEditPass] = createSignal('')

  const isEditingFormControl = () => {
    if (typeof document === 'undefined') return false
    const el = document.activeElement
    return el instanceof HTMLInputElement
      || el instanceof HTMLSelectElement
      || el instanceof HTMLTextAreaElement
    }

  const refresh = async () => {
    try {
      const data = await apiGet<{ proxies: Proxy[] }>('/api/proxies')
      if (isEditingFormControl()) return
      setProxies(data.proxies)
    } catch {}
  }

  refresh()
  const interval = setInterval(refresh, 5000)
  onCleanup(() => clearInterval(interval))

  const handleAdd = async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const portNum = parseInt(port(), 10)
      if (!host() || isNaN(portNum)) {
        setErrorMsg('Host and valid port are required')
        setLoading(false)
        return
      }
      await apiPost('/api/proxies', {
        name: name() || undefined,
        type: ptype(),
        host: host(),
        port: portNum,
        username: username() || undefined,
        password: password() || undefined,
      })
      setShowAdd(false)
      setName(''); setHost(''); setPort('1080'); setUsername(''); setPassword('')
      refresh()
    } catch (err) {
      setErrorMsg('Failed to add proxy: ' + err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    setConfirmDelete(id)
  }

  const confirmDeleteProxy = async () => {
    const id = confirmDelete()
    if (!id) return
    setConfirmDelete(null)
    await apiDelete(`/api/proxies/${id}`)
    refresh()
  }

  const handleTest = async (id: string) => {
    setTestingId(id)
    setTestResult(prev => ({ ...prev, [id]: { ok: false, latency_ms: 0 } }))
    try {
      const result = await apiPost<{ ok: boolean; latency_ms?: number; error?: string }>(`/api/proxies/${id}/test`)
      setTestResult(prev => ({ ...prev, [id]: result }))
    } catch (err: any) {
      const body = err?.message ? JSON.parse(err.message.split(': ').slice(1).join(': ')) : null
      setTestResult(prev => ({ ...prev, [id]: { ok: false, latency_ms: body?.latency_ms, error: String(err) } }))
    } finally {
      setTestingId(null)
    }
  }

  const startEdit = (p: Proxy) => {
    setEditingId(p.id)
    setEditName(p.name)
    setEditHost(p.host)
    setEditPort(String(p.port))
    setEditUser(p.username)
    setEditPass('')
  }

  const handleEdit = async () => {
    const id = editingId()
    if (!id) return
    const portNum = parseInt(editPort(), 10)
    if (isNaN(portNum)) return
    try {
      const body: Record<string, unknown> = {
        name: editName(),
        host: editHost(),
        port: portNum,
        username: editUser(),
      }
      if (editPass()) body.password = editPass()
      await apiPatch(`/api/proxies/${id}`, body)
      setEditingId(null)
      refresh()
    } catch {}
  }

  const typeBadge = (type: string) => {
    if (type === 'socks5') return <span class="badge badge-socks5">SOCKS5</span>
    return <span class="badge badge-http">HTTP</span>
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Proxies</h1>
        <button class="btn btn-primary" onClick={() => setShowAdd(!showAdd())}>+ Add Proxy</button>
      </div>

      <Show when={errorMsg()}>
        <div class="card error-banner">
          <span class="error-text">{errorMsg()}</span>
          <button class="btn btn-sm" onClick={() => setErrorMsg(null)}>Dismiss</button>
        </div>
      </Show>

      <Show when={confirmDelete()}>
        <div class="card confirm-dialog">
          <p>Remove this proxy? Accounts using it will be unbound.</p>
          <div class="confirm-actions">
            <button class="btn btn-sm btn-danger" onClick={confirmDeleteProxy}>Remove</button>
            <button class="btn btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
          </div>
        </div>
      </Show>

      <Show when={showAdd()}>
        <div class="card">
          <h2 class="card-title">ADD PROXY</h2>
          <div class="form-grid">
            <select value={ptype()} onChange={(e) => setPtype(e.currentTarget.value as 'http' | 'socks5')}>
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
            <input placeholder="Host (e.g. proxy.example.com)" value={host()} onInput={(e) => setHost(e.currentTarget.value)} />
            <input placeholder="Port" value={port()} onInput={(e) => setPort(e.currentTarget.value)} />
            <input placeholder="Name (optional)" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <input placeholder="Username (optional)" value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
            <input placeholder="Password (optional)" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
            <button class="btn btn-primary" onClick={handleAdd} disabled={loading() || !host()}>
              {loading() ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>
      </Show>

      <Show when={proxies().length > 0} fallback={<div class="card"><p class="text-muted">No proxies configured. Add one above to route account traffic through HTTP or SOCKS5 proxies.</p></div>}>
        <div class="card">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>TYPE</th>
                  <th>ADDRESS</th>
                  <th>AUTH</th>
                  <th>BOUND ACCOUNTS</th>
                  <th>TEST</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                <For each={proxies()} by={p => p.id}>
                  {(proxy) => (
                    <tr>
                      <td>
                        <Show when={editingId() === proxy.id} fallback={
                          <span>{proxy.name}</span>
                        }>
                          <div class="rename-row">
                            <input value={editName()} onInput={(e) => setEditName(e.currentTarget.value)} />
                            <input value={editHost()} onInput={(e) => setEditHost(e.currentTarget.value)} style="width:120px" />
                            <input value={editPort()} onInput={(e) => setEditPort(e.currentTarget.value)} style="width:60px" />
                            <input value={editUser()} onInput={(e) => setEditUser(e.currentTarget.value)} placeholder="user" style="width:80px" />
                            <input value={editPass()} onInput={(e) => setEditPass(e.currentTarget.value)} type="password" placeholder="pass" style="width:80px" />
                            <button class="btn btn-sm btn-primary" onClick={handleEdit}>Save</button>
                            <button class="btn btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </Show>
                      </td>
                      <td>{typeBadge(proxy.type)}</td>
                      <td class="mono">{proxy.url_safe}</td>
                      <td class="mono">{proxy.username ? `${proxy.username}:****` : 'none'}</td>
                      <td>
                        <Show when={proxy.bound_accounts.length > 0} fallback={<span class="text-muted">none</span>}>
                          <For each={proxy.bound_accounts} by={a => a.id}>
                            {(acct) => (
                              <span class="proxy-bound-acct">{acct.name || acct.email}</span>
                            )}
                          </For>
                        </Show>
                      </td>
                      <td>
                        <Show when={testingId() === proxy.id} fallback={
                          <button class="btn btn-sm" onClick={() => handleTest(proxy.id)}>Test</button>
                        }>
                          <span class="text-muted">Testing...</span>
                        </Show>
                        <Show when={testResult()[proxy.id]}>
                          <div class={`test-result ${testResult()[proxy.id].ok ? 'test-ok' : 'test-fail'}`}>
                            {testResult()[proxy.id].ok
                              ? `${testResult()[proxy.id].latency_ms}ms`
                              : `FAIL: ${testResult()[proxy.id].error?.slice(0, 40)}`}
                          </div>
                        </Show>
                      </td>
                      <td class="actions">
                        <button class="btn btn-sm" onClick={() => startEdit(proxy)}>Edit</button>
                        <button class="btn btn-sm btn-danger" onClick={() => handleDelete(proxy.id)}>Remove</button>
                      </td>
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
