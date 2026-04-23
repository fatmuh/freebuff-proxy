import { createSignal, For, Show } from 'solid-js'
import { apiGet, apiPost, apiDelete, apiPatch } from '../lib/api'

interface KeyInfo {
  key: string
  masked_key: string
  name: string
  bound_account_id: string
  created_at: string
}

interface Account {
  id: string
  name: string
  email: string
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = createSignal<KeyInfo[]>([])
  const [accounts, setAccounts] = createSignal<Account[]>([])
  const [newKeyName, setNewKeyName] = createSignal('')
  const [newKeyBoundAccount, setNewKeyBoundAccount] = createSignal('')
  const [editingKey, setEditingKey] = createSignal<string | null>(null)
  const [editName, setEditName] = createSignal('')

  const refresh = async () => {
    try {
      const [keysData, acctData] = await Promise.all([
        apiGet<{ keys: KeyInfo[]; enabled: boolean }>('/api/keys'),
        apiGet<{ accounts: Account[] }>('/api/accounts'),
      ])
      setKeys(keysData.keys)
      setAccounts(acctData.accounts)
    } catch {}
  }

  refresh()

  const handleCreate = async () => {
    const body: Record<string, string> = {}
    if (newKeyName()) body.name = newKeyName()
    if (newKeyBoundAccount()) body.bound_account_id = newKeyBoundAccount()
    const res = await apiPost<{ key: string; name: string }>('/api/keys', body)
    alert(`Created key: ${res.key}`)
    setNewKeyName('')
    refresh()
  }

  const handleDelete = async (fullKey: string) => {
    if (!confirm('Delete this key?')) return
    await apiDelete(`/api/keys/${encodeURIComponent(fullKey)}`)
    refresh()
  }

  const handleRename = async (fullKey: string) => {
    await apiPatch(`/api/keys/${encodeURIComponent(fullKey)}`, { name: editName() })
    setEditingKey(null)
    setEditName('')
    refresh()
  }

  const getAccountName = (id: string) => {
    const acct = accounts().find(a => a.id === id)
    return acct ? `${acct.name} (${acct.email})` : id
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">API Keys</h1>
      </div>

      <div class="card">
        <h2 class="card-title">CREATE KEY</h2>
        <div class="form-grid">
          <input
            placeholder="Key name"
            value={newKeyName()}
            onInput={(e) => setNewKeyName(e.currentTarget.value)}
          />
          <select value={newKeyBoundAccount()} onChange={(e) => setNewKeyBoundAccount(e.currentTarget.value)}>
            <option value="">Select account (optional)</option>
            <For each={accounts()}>
              {(a) => <option value={a.id}>{a.name} ({a.email})</option>}
            </For>
          </select>
          <button class="btn btn-primary" onClick={handleCreate}>Generate Key</button>
        </div>
      </div>

      <Show when={keys().length > 0} fallback={<div class="card"><p class="text-muted">No API keys configured.</p></div>}>
        <div class="card">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>KEY</th>
                  <th>BOUND TO</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                <For each={keys()}>
                  {(k) => (
                    <tr>
                      <td>
                        <Show
                          when={editingKey() === k.key}
                          fallback={
                            <span
                              class="editable-name"
                              onClick={() => { setEditingKey(k.key); setEditName(k.name) }}
                            >
                              {k.name || 'Unnamed'}
                            </span>
                          }
                        >
                          <div class="rename-row">
                            <input value={editName()} onInput={(e) => setEditName(e.currentTarget.value)} />
                            <button class="btn btn-sm" onClick={() => handleRename(k.key)}>Save</button>
                            <button class="btn btn-sm" onClick={() => setEditingKey(null)}>Cancel</button>
                          </div>
                        </Show>
                      </td>
                      <td class="mono">{k.masked_key}</td>
                      <td>{getAccountName(k.bound_account_id)}</td>
                      <td>
                        <button class="btn btn-sm btn-danger" onClick={() => handleDelete(k.key)}>Delete</button>
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
