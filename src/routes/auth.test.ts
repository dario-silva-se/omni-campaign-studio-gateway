import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Mock the data/crypto layer so the routes are tested without Mongo.
vi.mock('../auth/users.js', () => ({
  verifyCredentials: vi.fn(),
  findById: vi.fn(),
  touchLogin: vi.fn(),
  createUser: vi.fn(),
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

  it('registers a new user, auto-logs in (201) and sets a refresh cookie', async () => {
    ;(users.createUser as any).mockImplementation(async (input: any) => ({
      _id: 'u-new',
      email: input.email,
      name: input.name,
      tenantId: input.tenantId,
      scopes: input.scopes,
      status: 'active',
    }))
    const app = makeApp()
    const res = await app.request('/_gw/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Maria Silva', email: 'maria@acme.com', password: 'secret12' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.accessToken).toBe('access-tok')
    expect(body.user.email).toBe('maria@acme.com')
    expect(body.user.name).toBe('Maria Silva')
    // Self-signup gets a generated tenant and standard non-admin scopes.
    const passed = (users.createUser as any).mock.calls[0][0]
    expect(passed.tenantId).toBeTruthy()
    expect(passed.scopes).toEqual(['api:read', 'api:write', 'ai:invoke'])
    expect(res.headers.get('set-cookie') ?? '').toContain('gw_refresh=')
  })

  it('returns 409 when the email already exists', async () => {
    ;(users.createUser as any).mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    const app = makeApp()
    const res = await app.request('/_gw/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Maria', email: 'taken@acme.com', password: 'secret12' }),
    })
    expect(res.status).toBe(409)
  })

  it('rejects registration with a short password (422)', async () => {
    const app = makeApp()
    const res = await app.request('/_gw/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Maria', email: 'maria@acme.com', password: 'short' }),
    })
    expect(res.status).toBe(422)
    expect(users.createUser).not.toHaveBeenCalled()
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
