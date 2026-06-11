import type { Context } from 'hono'
import type { ProxyStore, ProxyEntry } from '../proxy-store.js'
import type { AuthStore } from '../auth-store.js'
import type { UpstreamClient } from '../upstream.js'
import { proxyUrlSafe } from '../proxy-store.js'

interface CreateProxyBody {
  name?: string
  type?: string
  host?: string
  port?: number
  username?: string
  password?: string
}

interface UpdateProxyBody {
  name?: string
  type?: string
  host?: string
  port?: number
  username?: string
  password?: string
}

function validateProxyBody(body: CreateProxyBody | UpdateProxyBody): string | null {
  if (body.type && body.type !== 'http' && body.type !== 'socks5') {
    return 'type must be "http" or "socks5"'
  }
  if (body.host !== undefined && !body.host.trim()) {
    return 'host cannot be empty'
  }
  if (body.port !== undefined && (body.port < 1 || body.port > 65535)) {
    return 'port must be between 1 and 65535'
  }
  return null
}

export function handleProxiesList(proxyStore: ProxyStore, auth: AuthStore) {
  return (c: Context) => {
    const proxies = proxyStore.listProxies()
    const accounts = auth.listAccountsFull()

    const enriched = proxies.map(p => {
      // Find accounts using this proxy
      const boundAccounts = accounts
        .filter(a => a.proxy_id === p.id)
        .map(a => ({ id: a.id, name: a.name, email: a.email }))
      return {
        ...p,
        password: p.password ? '****' : '',
        url_safe: proxyUrlSafe(p),
        bound_accounts: boundAccounts,
      }
    })

    return c.json({ proxies: enriched })
  }
}

export function handleProxiesCreate(proxyStore: ProxyStore, upstreamClient: UpstreamClient) {
  return async (c: Context) => {
    let body: CreateProxyBody
    try { body = await c.req.json<CreateProxyBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    const validation = validateProxyBody(body)
    if (validation) return c.json({ error: validation }, 400)

    if (!body.host || !body.port || !body.type) {
      return c.json({ error: 'host, port, and type are required' }, 400)
    }

    const id = `proxy-${proxyStore.nextId()}`
    const entry: ProxyEntry = {
      id,
      name: body.name || `${body.type}://${body.host}:${body.port}`,
      type: body.type as ProxyEntry['type'],
      host: body.host,
      port: body.port,
      username: body.username ?? '',
      password: body.password ?? '',
      created_at: new Date().toISOString(),
    }

    proxyStore.addProxy(entry)
    upstreamClient.registerProxy(entry)

    return c.json({
      ok: true,
      proxy: { ...entry, password: entry.password ? '****' : '', url_safe: proxyUrlSafe(entry) },
    }, 201)
  }
}

export function handleProxiesUpdate(proxyStore: ProxyStore, upstreamClient: UpstreamClient) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    let body: UpdateProxyBody
    try { body = await c.req.json<UpdateProxyBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    const validation = validateProxyBody(body)
    if (validation) return c.json({ error: validation }, 400)

    const existing = proxyStore.getProxy(id)
    if (!existing) return c.json({ error: 'proxy not found' }, 404)

    const updated: ProxyEntry = {
      ...existing,
      name: body.name !== undefined
        ? (body.name.trim() || `${existing.type}://${body.host ?? existing.host}:${body.port ?? existing.port}`)
        : existing.name,
      type: (body.type as ProxyEntry['type']) ?? existing.type,
      host: body.host ?? existing.host,
      port: body.port ?? existing.port,
      username: body.username !== undefined ? body.username : existing.username,
      password: body.password !== undefined ? body.password : existing.password,
    }

    proxyStore.updateProxy(updated)
    upstreamClient.registerProxy(updated)

    return c.json({
      ok: true,
      proxy: { ...updated, password: updated.password ? '****' : '', url_safe: proxyUrlSafe(updated) },
    })
  }
}

export function handleProxiesDelete(proxyStore: ProxyStore, auth: AuthStore, upstreamClient: UpstreamClient) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    const existing = proxyStore.getProxy(id)
    if (!existing) return c.json({ error: 'proxy not found' }, 404)

    // Unbind this proxy from any accounts using it
    const accounts = auth.listAccountsFull()
    for (const acct of accounts) {
      if (acct.proxy_id === id) {
        acct.proxy_id = ''
        auth.updateAccount(acct)
      }
    }

    upstreamClient.unregisterProxy(id)
    proxyStore.removeProxy(id)

    return c.json({ ok: true })
  }
}

export function handleProxiesTest(proxyStore: ProxyStore, upstreamClient: UpstreamClient) {
  return async (c: Context) => {
    const id = c.req.param('id') ?? ''
    const existing = proxyStore.getProxy(id)
    if (!existing) return c.json({ error: 'proxy not found' }, 404)

    const start = Date.now()
    try {
      const dispatcher = upstreamClient.getDispatcher(id)
      const { request } = await import('undici')
      const resp = await request('https://httpbin.org/ip', {
        dispatcher,
        method: 'GET',
        headers: { 'accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      const text = await resp.body.text()
      const latency = Date.now() - start
      return c.json({ ok: true, latency_ms: latency, status: resp.statusCode, body: text.slice(0, 500) })
    } catch (err) {
      const latency = Date.now() - start
      return c.json({ ok: false, latency_ms: latency, error: String(err) }, 502)
    }
  }
}
