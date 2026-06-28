import { describe, it, expect } from 'vitest'
import { issueAccessToken } from './issue.js'
import { verifyJwt, scopesFromClaims } from './jwt.js'
import type { UserDoc } from '../db/collections.js'

const user: UserDoc = {
  _id: 'u-1',
  email: 'admin@acme.com',
  passwordHash: 'x:y',
  tenantId: 't-acme',
  scopes: ['api:read', 'api:write', 'ai:invoke'],
  status: 'active',
  createdAt: new Date().toISOString(),
}

describe('issueAccessToken', () => {
  it('signs a token that the request-path verifier accepts', async () => {
    const { accessToken, expiresIn } = await issueAccessToken(user)
    expect(expiresIn).toBeGreaterThan(0)

    const payload = await verifyJwt(accessToken)
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe('u-1')
    expect(payload!.tenant).toBe('t-acme')
    expect(scopesFromClaims(payload!)).toEqual(['api:read', 'api:write', 'ai:invoke'])
  })
})
