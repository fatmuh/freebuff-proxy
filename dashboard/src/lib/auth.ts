import { apiGet, apiPost } from './api'

export interface AuthCheck {
  protected: boolean
}

export async function checkAuth(): Promise<AuthCheck> {
  return apiGet<AuthCheck>('/api/auth/check')
}

export async function login(password: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) throw new Error('invalid password')
  return res.json()
}

export async function logout(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/api/auth/logout')
}
