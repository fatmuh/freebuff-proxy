import { createSignal, For, Show } from 'solid-js'
import { apiGet, apiPost, apiDelete } from '../lib/api'

interface Binding {
  api_key: string
  full_key: string
  model: string
  key_name: string
  email: string
  account_name: string
  created_at: string
}

export default function BindingsPanel() {
  const [bindings, setBindings] = createSignal<Binding[]>([])
  const [showAdd, setShowAdd] = createSignal(false)
  const [apiKey, setApiKey] = createSignal('')
  const [model, setModel] = createSignal('minimax/minimax-m2.7')

  const refresh = async () => {
    try {
      const data = await apiGet<{ bindings: Binding[] }>('/api/bindings')
      setBindings(data.bindings)
    } catch {}
  }

  refresh()

  const handleAdd = async () => {
    await apiPost('/api/bindings', { api_key: apiKey(), model: model() })
    setShowAdd(false)
    setApiKey('')
    refresh()
  }

  const handleDelete = async (fullKey: string) => {
    await apiDelete(`/api/bindings/${encodeURIComponent(fullKey)}`)
    refresh()
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Bindings</h1>
        <button class="btn btn-primary" onClick={() => setShowAdd(!showAdd())}>+ Add Binding</button>
      </div>

      <Show when={showAdd()}>
        <div class="card">
          <h2 class="card-title">ADD BINDING</h2>
          <div class="form-grid">
            <input placeholder="API Key" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} />
            <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
              <option value="minimax/minimax-m2.7">minimax/minimax-m2.7</option>
              <option value="z-ai/glm-5.1">z-ai/glm-5.1</option>
            </select>
            <button class="btn btn-primary" onClick={handleAdd} disabled={!apiKey()}>Bind</button>
          </div>
        </div>
      </Show>

      <Show when={bindings().length > 0} fallback={<div class="card"><p class="text-muted">No bindings configured.</p></div>}>
        <div class="card">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>KEY</th>
                  <th>KEY NAME</th>
                  <th>EMAIL</th>
                  <th>MODEL</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                <For each={bindings()}>
                  {(b) => (
                    <tr>
                      <td class="mono">{b.api_key}</td>
                      <td>{b.key_name || '-'}</td>
                      <td class="mono">{b.email || '-'}</td>
                      <td>{b.model}</td>
                      <td>
                        <button class="btn btn-sm btn-danger" onClick={() => handleDelete(b.full_key)}>Remove</button>
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
