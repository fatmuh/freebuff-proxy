import { createSignal, For, Show, createResource } from 'solid-js'
import { apiGet, apiPost, apiDelete, apiPatch } from '../lib/api'

interface KeyInfo {
  id: string
  key: string
  masked_key: string
  name: string
  created_at: string
}

interface KeyUsage {
  api_key_id: string | null
  requests: number
  tokens_in: number
  tokens_out: number
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = createSignal<KeyInfo[]>([])
  const [enabled, setEnabled] = createSignal(true)
  const [newKeyName, setNewKeyName] = createSignal('')
  const [editingKey, setEditingKey] = createSignal<string | null>(null)
  const [editName, setEditName] = createSignal('')
  const [createdKey, setCreatedKey] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)

  const [keyUsage] = createResource(() => apiGet<KeyUsage[]>('/api/usage/by-key'))

  const refresh = async () => {
    try {
      const keysData = await apiGet<{ keys: KeyInfo[]; enabled: boolean; has_keys: boolean }>('/api/keys')
      setKeys(keysData.keys)
      setEnabled(keysData.enabled)
    } catch {}
  }

  refresh()

  const handleToggle = async () => {
    const newState = !enabled()
    await apiPatch('/api/keys/toggle', { enabled: newState })
    setEnabled(newState)
  }

  const handleCreate = async () => {
    const body: Record<string, string> = {}
    if (newKeyName()) body.name = newKeyName()
    const res = await apiPost<{ key: string; name: string; id: string }>('/api/keys', body)
    setCreatedKey(res.key)
    setNewKeyName('')
    refresh()
  }

  const handleDelete = async (fullKey: string) => {
    setConfirmDelete(fullKey)
  }

  const confirmDeleteKey = async () => {
    const key = confirmDelete()
    if (!key) return
    setConfirmDelete(null)
    await apiDelete(`/api/keys/${encodeURIComponent(key)}`)
    refresh()
  }

  const handleRename = async (fullKey: string) => {
    await apiPatch(`/api/keys/${encodeURIComponent(fullKey)}`, { name: editName() })
    setEditingKey(null)
    setEditName('')
    refresh()
  }

  const getKeyUsage = (keyId: string) => {
    const usage = keyUsage()
    if (!usage) return null
    return usage.find(u => u.api_key_id === keyId)
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">API Keys</h1>
        <button class="btn btn-sm" classList={{ 'btn-primary': enabled(), 'btn-danger': !enabled() }} onClick={handleToggle}>
          Protection: {enabled() ? 'ON' : 'OFF'}
        </button>
      </div>

      <Show when={createdKey()}>
        <div class="card created-key-banner">
          <span>Key created: </span>
          <span class="mono">{createdKey()}</span>
          <button class="btn btn-sm" onClick={() => { navigator.clipboard.writeText(createdKey()!); }}>Copy</button>
          <button class="btn btn-sm" onClick={() => setCreatedKey(null)}>Dismiss</button>
        </div>
      </Show>

      <Show when={confirmDelete()}>
        <div class="card confirm-dialog">
          <p>Delete this API key? Any requests using it will be rejected.</p>
          <div class="confirm-actions">
            <button class="btn btn-sm btn-danger" onClick={confirmDeleteKey}>Delete</button>
            <button class="btn btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
          </div>
        </div>
      </Show>

      <div class="card">
        <h2 class="card-title">CREATE KEY</h2>
        <div class="form-grid">
          <input
            placeholder="Key name"
            value={newKeyName()}
            onInput={(e) => setNewKeyName(e.currentTarget.value)}
          />
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
                  <th>REQUESTS</th>
                  <th>TOKENS IN/OUT</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                <For each={keys()}>
                  {(k) => {
                    const usage = () => getKeyUsage(k.id)
                    return (
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
                        <td class="mono">{usage()?.requests?.toLocaleString() ?? '-'}</td>
                        <td class="mono">
                          {usage() ? `${usage()!.tokens_in?.toLocaleString() ?? 0} / ${usage()!.tokens_out?.toLocaleString() ?? 0}` : '-'}
                        </td>
                        <td>
                          <button class="btn btn-sm btn-danger" onClick={() => handleDelete(k.key)}>Delete</button>
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
