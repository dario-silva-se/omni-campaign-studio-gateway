import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Mock the data/crypto layer so the routes are tested without Mongo.
vi.mock('../auth/users.js', () => ({
  verifyCredentials: vi.fn(),
  findById: vi.fn(),
  touchLogin: vi.fn(),
}))
vi.mock('../auth/issue.js', () => ({
  issueAccessToken: vi.fn(async () => ({ accessToken: 'access-tok', expiresIn: 1800 })),
  mintRefresh: vi.fn(async () => 'refresh-raw'),
  rotateRefresh: vi.fn(),
  revokeRefresh: vi.fn(async () => {}),
}))

const users = await import('../auth/users.js')
const issue = await import('../auth/issue.js')
const { authRouter } = await import('./auth.js')

const activeUser = {
  _id: 'u-1',
  email: 'admin@acme.com',
  tenantId: 't-acme',
  scopes: ['api:read'],
  status: 'active',
}

function makeApp() {
  const app = new Hono()
  app.route('/_gw/auth', authRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('auth routes', () => {
  it('logs in with valid credentials and sets a refresh cookie', async () => {
    ;(users.verifyCredentials as any).mockResolvedValue(activeUser)
    const app = makeApp()
    const res = await app.request('/_gw/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@acme.com', password: 'whatever1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.accessToken).toBe('access-tok')
    expect(body.user.email).toBe('admin@acme.com')
    expect(res.headers.get('set-cookie') ?? '').toContain('gw_refresh=')
  })

  it('rejects invalid credentials with 401', async () => {
    ;(users.verifyCredentials as any).mockResolvedValue(null)
    const app = makeApp()
    const res = await app.request('/_gw/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@acme.com', password: 'bad' }),
    })
    expect(res.status).toBe(401)
  })

  it('refreshes when a valid cookie is present', async () => {
    ;(issue.rotateRefresh as any).mockResolvedValue({ userId: 'u-1', refresh: 'new-raw' })
    ;(users.findById as any).mockResolvedValue(activeUser)
    const app = makeApp()
    const res = await app.request('/_gw/auth/refresh', {
      method: 'POST',
      headers: { cookie: 'gw_refresh=refresh-raw' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.accessToken).toBe('access-tok')
  })

  it('rejects refresh without a cookie', async () => {
    const app = makeApp()
    const res = await app.request('/_gw/auth/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('logs out (204) and clears the cookie', async () => {
    const app = makeApp()
    const res = await app.request('/_gw/auth/logout', {
      method: 'POST',
      headers: { cookie: 'gw_refresh=refresh-raw' },
    })
    expect(res.status).toBe(204)
    expect(issue.revokeRefresh).toHaveBeenCalledWith('refresh-raw')
  })
})
