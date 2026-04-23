import { createSignal, Show } from 'solid-js'
import { login } from '../lib/auth'

export default function LoginPage(props: { onLogin: () => void }) {
  const [password, setPassword] = createSignal('')
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await login(password())
      props.onLogin()
    } catch {
      setError('Invalid password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="login-page">
      <div class="login-card">
        <h1>Freebuff Dashboard</h1>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Dashboard password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            disabled={loading()}
          />
          <Show when={error()}>
            <p class="error-text">{error()}</p>
          </Show>
          <button type="submit" disabled={loading() || !password()}>
            {loading() ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  )
}
