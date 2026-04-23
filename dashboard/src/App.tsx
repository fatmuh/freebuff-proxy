import type { RouteSectionProps } from '@solidjs/router'
import { createEffect, createSignal, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { checkAuth } from './lib/auth'
import Layout from './components/Layout'
import LoginPage from './components/LoginPage'

export default function App(props: RouteSectionProps) {
  const [isProtected, setIsProtected] = createSignal<boolean | null>(null)
  const [isLoggedIn, setIsLoggedIn] = createSignal(false)
  const navigate = useNavigate()

  createEffect(() => {
    checkAuth()
      .then(res => {
        setIsProtected(res.protected)
        if (!res.protected) setIsLoggedIn(true)
      })
      .catch(() => setIsProtected(false))
  })

  const handleLogin = () => {
    setIsLoggedIn(true)
    navigate('/')
  }

  return (
    <Show
      when={isProtected() !== null}
      fallback={<div style={{ padding: '24px', color: '#a6adc8', 'font-family': 'Inter, sans-serif' }}>Loading...</div>}
    >
      <Show
        when={!isProtected() || isLoggedIn()}
        fallback={<LoginPage onLogin={handleLogin} />}
      >
        <Layout>
          {props.children}
        </Layout>
      </Show>
    </Show>
  )
}
