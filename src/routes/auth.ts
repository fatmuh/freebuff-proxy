import type { Context } from 'hono'
import type { DB } from '../db.js'
import { randomBytes } from 'node:crypto'

interface LoginBody {
  password: string
}

const SESSION_DURATION_HOURS = 24
const COOKIE_NAME = 'sid'

export function handleAuthCheck() {
  return (c: Context) => {
    const password = process.env.DASHBOARD_PASSWORD?.trim()
    return c.json({ protected: !!password })
  }
}

export function handleAuthLogin(db: DB) {
  return async (c: Context) => {
    const password = process.env.DASHBOARD_PASSWORD?.trim()
    if (!password) {
      return c.json({ error: 'dashboard password not configured' }, 400)
    }

    let body: LoginBody
    try { body = await c.req.json<LoginBody>() } catch { return c.json({ error: 'invalid json' }, 400) }

    if (!body.password || body.password !== password) {
      return c.json({ error: 'invalid password' }, 401)
    }

    const sessionId = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 3600_000).toISOString()

    db.createSession(sessionId, expiresAt)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `${COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION_HOURS * 3600}; SameSite=Strict`,
      },
    })
  }
}

export function handleAuthLogout(db: DB) {
  return (c: Context) => {
    const sessionId = getCookie(c)
    if (sessionId) db.deleteSession(sessionId)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`,
      },
    })
  }
}

export function dashboardAuthMiddleware(db: DB) {
  return async (c: Context, next: () => Promise<void>) => {
    const password = process.env.DASHBOARD_PASSWORD?.trim()
    if (!password) return next()

    const sessionId = getCookie(c)
    if (!sessionId) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const session = db.getSession(sessionId)
    if (!session) {
      return c.json({ error: 'session expired or invalid' }, 401)
    }

    return next()
  }
}

function getCookie(c: Context): string | null {
  const cookieHeader = c.req.header('cookie') ?? ''
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1)
    }
  }
  return null
}
