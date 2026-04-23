import { createSignal, Show, onCleanup } from 'solid-js'
import { useNavigate, A } from '@solidjs/router'
import { checkAuth, logout } from '../lib/auth'
import { apiGet } from '../lib/api'

const NAV_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/keys', label: 'API Keys' },
  { href: '/requests', label: 'Requests' },
]

interface StatusData {
  running: boolean
  uptime_sec: number
  total_accounts: number
  active_accounts: number
  queued_accounts: number
  sessions: { name: string; status: string; instanceId: string; model: string; admittedAt: string | null; expiresAt: string | null; remainingMs: number }[]
}

export default function Layout(props: { children: any }) {
  const navigate = useNavigate()
  const [theme, setTheme] = createSignal<'dark' | 'light'>(
    (localStorage.getItem('freebuff-theme') as 'dark' | 'light') ?? 'dark'
  )
  const [isProtected, setIsProtected] = createSignal(false)
  const [status, setStatus] = createSignal<StatusData | null>(null)

  checkAuth().then(r => setIsProtected(r.protected)).catch(() => {})

  const applyTheme = (t: 'dark' | 'light') => {
    setTheme(t)
    localStorage.setItem('freebuff-theme', t)
    document.documentElement.setAttribute('data-theme', t)
  }

  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme())
  }

  const toggleTheme = () => {
    applyTheme(theme() === 'dark' ? 'light' : 'dark')
  }

  const handleLogout = async () => {
    await logout()
    navigate('/')
    window.location.reload()
  }

  // Poll status for topbar
  const pollStatus = async () => {
    try {
      const data = await apiGet<StatusData>('/api/status')
      setStatus(data)
    } catch {}
  }
  pollStatus()
  const statusInterval = setInterval(pollStatus, 3000)
  onCleanup(() => clearInterval(statusInterval))

  const formatUptime = (sec: number) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${h}h ${m}m ${s}s`
  }

  const formatRemaining = (ms: number) => {
    const m = Math.floor(ms / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${m}m ${s}s`
  }

  const shortModel = (model: string) => {
    const parts = model.split('/')
    return parts[parts.length - 1]
  }

  return (
    <div class="app-container">
      <header class="topbar">
        <div class="topbar-item">
          <span class="topbar-dot topbar-dot-green"></span>
          <span>Proxy Running</span>
        </div>
        <Show when={status()}>
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
        </Show>
      </header>
      <nav class="sidebar">
        <div class="sidebar-brand">
          <span class="brand-icon">F</span>
          <span class="brand-text">Freebuff</span>
        </div>
        <div class="sidebar-nav">
          {NAV_ITEMS.map(item => (
            <A
              href={item.href}
              class="nav-item"
              activeClass="nav-item-active"
              end={item.href === '/'}
            >
              {item.label}
            </A>
          ))}
        </div>
        <div class="sidebar-footer">
          <button class="theme-toggle" onClick={toggleTheme}>
            {theme() === 'dark' ? '☀ Light' : '● Dark'}
          </button>
          <Show when={isProtected()}>
            <button class="logout-btn" onClick={handleLogout}>Logout</button>
          </Show>
        </div>
      </nav>
      <main class="main-content">
        {props.children}
      </main>
    </div>
  )
}
