import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Integration tests for the gateway pipeline. The API-key lookup is mocked so we
 * exercise auth/scope/rate-limit/budget/proxy without Mongo, and `fetch` is
 * stubbed for upstream + AI provider calls.
 */
vi.mock('./auth/apiKey.js', () => {
  const docs: Record<string, any> = {
    gw_admin: {
      _id: 'k-admin',
      hash: 'h-admin',
      tenantId: 't-admin',
      name: 'admin',
      scopes: ['admin', 'api:read', 'api:write', 'ai:invoke'],
      status: 'active',
    },
    gw_read: {
      _id: 'k-read',
      hash: 'h-read',
      tenantId: 't-read',
      name: 'read-only',
      scopes: ['api:read'],
      status: 'active',
    },
    gw_limited: {
      _id: 'k-limited',
      hash: 'h-limited',
      tenantId: 't-limited',
      name: 'limited',
      scopes: ['api:read', 'api:write'],
      status: 'active',
      rateLimitRps: 2,
    },
  }
  return {
    KEY_PREFIX: 'gw_',
    lookupKey: vi.fn(async (raw: string) => docs[raw] ?? null),
    touchKey: vi.fn(),
    invalidateKeyCache: vi.fn(async () => {}),
    issueKey: vi.fn(),
    hashKey: (s: string) => s,
    generateRawKey: () => 'gw_generated',
  }
})

// Stub the Mongo layer so health/usage don't attempt a real connection.
vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(async () => ({
    command: vi.fn(async () => ({ ok: 1 })),
    collection: vi.fn(),
  })),
  getClient: vi.fn(),
  closeDb: vi.fn(async () => {}),
}))

vi.mock('./db/collections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/collections.js')>()
  return {
    ...actual,
    apiKeysCollection: vi.fn(),
    requestLogsCollection: vi.fn(),
    usageMonthlyCollection: vi.fn(async () => ({ findOne: vi.fn(async () => null) })),
  }
})

const { app } = await import('./app.js')

const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } })

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'generated' } }],
            usage: { prompt_tokens: 12, completion_tokens: 8 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // Upstream CRUD response.
      return new Response(JSON.stringify([{ _id: '1', name: 'Campaign' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('gateway pipeline', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.request('/api/campaigns')
    expect(res.status).toBe(401)
  })

  it('proxies authenticated reads to the upstream API', async () => {
    const res = await app.request('/api/campaigns', auth('gw_admin'))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ratelimit-limit')).toBeTruthy()
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('exposes gateway headers to cross-origin clients', async () => {
    const res = await app.request('/api/campaigns', {
      headers: { authorization: 'Bearer gw_admin', origin: 'http://localhost:5173' },
    })
    const exposed = res.headers.get('access-control-expose-headers') ?? ''
    expect(exposed).toContain('X-RateLimit-Limit')
    expect(exposed).toContain('X-Request-Id')
  })

  it('injects the gateway shared secret into upstream requests', async () => {
    const spy = vi.fn(async (_url: any, init: any) => {
      void _url
      void init
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', spy)
    await app.request('/api/campaigns', auth('gw_admin'))
    const init = spy.mock.calls[0]?.[1] as { headers: Headers }
    expect(init.headers.get('x-gateway-secret')).toBe('test-gw-secret')
  })

  it('maps an upstream timeout to 504 and other failures to 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('timed out')
        err.name = 'TimeoutError'
        throw err
      }),
    )
    const timeout = await app.request('/api/campaigns', auth('gw_admin'))
    expect(timeout.status).toBe(504)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const unreachable = await app.request('/api/campaigns', auth('gw_admin'))
    expect(unreachable.status).toBe(502)
  })

  it('enforces method-based scopes (write needs api:write)', async () => {
    const res = await app.request('/api/campaigns', {
      method: 'POST',
      headers: { authorization: 'Bearer gw_read', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(403)
  })

  it('rate limits per tenant', async () => {
    const opts = auth('gw_limited')
    await app.request('/api/campaigns', opts)
    await app.request('/api/campaigns', opts)
    const third = await app.request('/api/campaigns', opts)
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBeTruthy()
  })

  it('serves a public health check without credentials', async () => {
    const res = await app.request('/_gw/health')
    const body = await res.json()
    expect(body).toHaveProperty('upstream')
    expect(body).toHaveProperty('mongo')
    expect(body).toHaveProperty('redis')
  })

  it('requires admin scope for metrics', async () => {
    expect((await app.request('/_gw/metrics', auth('gw_read'))).status).toBe(403)
    expect((await app.request('/_gw/metrics', auth('gw_admin'))).status).toBe(200)
  })

  it('runs an AI completion and accounts for cost', async () => {
    const res = await app.request('/ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer gw_admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'write a tagline' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.choices[0].message.content).toBe('generated')
  })

  it('reports usage for the authenticated tenant', async () => {
    const res = await app.request('/_gw/usage', auth('gw_admin'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.tenantId).toBe('t-admin')
    expect(body.budget).toHaveProperty('limitUsd')
  })
})
