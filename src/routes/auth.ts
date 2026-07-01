import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { env } from '../config/env.js'
import type { GatewayVariables } from '../auth/principal.js'
import { createUser, findById, touchLogin, verifyCredentials } from '../auth/users.js'
import {
  issueAccessToken,
  mintRefresh,
  revokeRefresh,
  rotateRefresh,
} from '../auth/issue.js'
import type { Scope, UserDoc } from '../db/collections.js'

const REFRESH_COOKIE = 'gw_refresh'
const COOKIE_PATH = '/_gw/auth'

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

function validationHook(
  result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
  c: { json: (body: unknown, status: 422) => Response },
): Response | undefined {
  if (!result.success && result.error) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ')
    return c.json({ error: 'Validation Error', message }, 422)
  }
  return undefined
}

const isProd = env.NODE_ENV === 'production'

function setRefreshCookie(c: Parameters<typeof setCookie>[0], raw: string) {
  setCookie(c, REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: isProd,
    // Cross-site in production (separate domains) needs None+Secure; Lax is fine
    // for same-site local dev (localhost:5173 → localhost:8787).
    sameSite: isProd ? 'None' : 'Lax',
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  })
}

function publicUser(user: UserDoc) {
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    tenantId: user.tenantId,
    scopes: user.scopes,
  }
}

const RegisterSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})

/**
 * Self-service signup gets a fresh, isolated tenant and the standard
 * non-privileged scopes — never `admin` (that path stays behind `/_gw/users`).
 */
const SELF_SIGNUP_SCOPES: Scope[] = ['api:read', 'api:write', 'ai:invoke']

/**
 * Public authentication endpoints (token-exchange). Mounted at `/_gw/auth`
 * before the `authenticate` middleware and guarded by a per-IP rate limiter.
 * Access tokens are short-lived HS256 JWTs (memory on the client); the refresh
 * token lives only in an httpOnly cookie.
 */
export const authRouter = new Hono<{ Variables: GatewayVariables }>()

authRouter.post(
  '/login',
  zValidator('json', LoginSchema, validationHook as any),
  async (c) => {
    if (!env.JWT_SECRET) {
      return c.json({ error: 'Service Unavailable', message: 'Auth is not configured' }, 503)
    }
    const { email, password } = c.req.valid('json' as never) as z.infer<typeof LoginSchema>
    const user = await verifyCredentials(email, password)
    if (!user) {
      return c.json({ error: 'Unauthorized', message: 'Invalid email or password' }, 401)
    }
    const { accessToken, expiresIn } = await issueAccessToken(user)
    const refresh = await mintRefresh(user._id)
    setRefreshCookie(c, refresh)
    touchLogin(user._id)
    return c.json({ accessToken, expiresIn, user: publicUser(user) })
  },
)

/**
 * Public self-service signup. Creates an active user in a brand-new isolated
 * tenant, then logs them straight in (access token + refresh cookie), mirroring
 * the login response shape. Admin-provisioned users still go through
 * `/_gw/users` (which can set tenant + scopes, including `admin`).
 */
authRouter.post(
  '/register',
  zValidator('json', RegisterSchema, validationHook as any),
  async (c) => {
    if (!env.JWT_SECRET) {
      return c.json({ error: 'Service Unavailable', message: 'Auth is not configured' }, 503)
    }
    const { name, email, password } = c.req.valid('json' as never) as z.infer<typeof RegisterSchema>
    let user: UserDoc
    try {
      user = await createUser({
        name,
        email,
        password,
        tenantId: randomUUID(),
        scopes: SELF_SIGNUP_SCOPES,
      })
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return c.json({ error: 'Conflict', message: 'Email already exists' }, 409)
      }
      throw err
    }
    const { accessToken, expiresIn } = await issueAccessToken(user)
    const refresh = await mintRefresh(user._id)
    setRefreshCookie(c, refresh)
    return c.json({ accessToken, expiresIn, user: publicUser(user) }, 201)
  },
)

authRouter.post('/refresh', async (c) => {
  if (!env.JWT_SECRET) {
    return c.json({ error: 'Service Unavailable', message: 'Auth is not configured' }, 503)
  }
  const raw = getCookie(c, REFRESH_COOKIE)
  if (!raw) {
    return c.json({ error: 'Unauthorized', message: 'No refresh token' }, 401)
  }
  const rotated = await rotateRefresh(raw)
  if (!rotated) {
    deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH })
    return c.json({ error: 'Unauthorized', message: 'Invalid or expired session' }, 401)
  }
  const user = await findById(rotated.userId)
  if (!user || user.status !== 'active') {
    deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH })
    return c.json({ error: 'Unauthorized', message: 'User is no longer active' }, 401)
  }
  const { accessToken, expiresIn } = await issueAccessToken(user)
  setRefreshCookie(c, rotated.refresh)
  return c.json({ accessToken, expiresIn, user: publicUser(user) })
})

authRouter.post('/logout', async (c) => {
  const raw = getCookie(c, REFRESH_COOKIE)
  if (raw) await revokeRefresh(raw)
  deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH })
  return c.body(null, 204)
})
