const BASE = ''

async function request(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...opts,
  })
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await request(path, { method: 'DELETE' })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}
