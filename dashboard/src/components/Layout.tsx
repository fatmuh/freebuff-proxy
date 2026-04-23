import { createSignal, Show } from 'solid-js'
import { useNavigate, A } from '@solidjs/router'
import { checkAuth, logout } from '../lib/auth'

const NAV_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/bindings', label: 'Bindings' },
  { href: '/keys', label: 'API Keys' },
  { href: '/requests', label: 'Requests' },
]

export default function Layout(props: { children: any }) {
  const navigate = useNavigate()
  const [theme, setTheme] = createSignal<'dark' | 'light'>(
    (localStorage.getItem('freebuff-theme') as 'dark' | 'light') ?? 'dark'
  )
  const [isProtected, setIsProtected] = createSignal(false)

  checkAuth().then(r => setIsProtected(r.protected)).catch(() => {})

  const applyTheme = (t: 'dark' | 'light') => {
    setTheme(t)
    localStorage.setItem('freebuff-theme', t)
    document.documentElement.setAttribute('data-theme', t)
  }

  // apply on mount
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

  return (
    <div class="app-container">
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
