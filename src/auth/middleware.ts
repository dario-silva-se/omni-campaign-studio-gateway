import type { Context, MiddlewareHandler, Next } from 'hono'
import { invalidateKeyCache, lookupKey, touchKey } from './apiKey.js'
import { scopesFromClaims, verifyJwt } from './jwt.js'
import type { GatewayVariables, Principal } from './principal.js'
import { hasScope } from './principal.js'
import type { Scope } from '../db/collections.js'
import { log } from '../telemetry/logger.js'

function unauthorized(c: Context) {
  return c.json(
    { error: 'Unauthorized', message: 'Missing or invalid credentials' },
    401,
  )
}

function authUnavailable(c: Context) {
  return c.json(
    { error: 'Service Unavailable', message: 'Authentication backend unavailable' },
    503,
  )
}

/** Extract a bearer token / api key from the request, if any. */
function readCredential(c: Context): { apiKey?: string; bearer?: string } {
  const header = c.req.header('authorization')
  const xApiKey = c.req.header('x-api-key')
  if (xApiKey) return { apiKey: xApiKey }
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    // gw_ tokens are API keys; everything else is treated as a JWT.
    if (token.startsWith('gw_')) return { apiKey: token }
    return { bearer: token }
  }
  return {}
}

/**
 * Authentication middleware. Resolves a {@link Principal} from an API key or a
 * JWT and stores it on the context. Rejects with 401 when no valid credential
 * is present. Authorization (scope checks) is enforced per-route by
 * {@link requireScope}.
 */
export const authenticate: MiddlewareHandler<{ Variables: GatewayVariables }> =
  async (c, next: Next) => {
    const { apiKey, bearer } = readCredential(c)

    if (apiKey) {
      let doc
      try {
        doc = await lookupKey(apiKey)
      } catch (err) {
        log.error('api key lookup failed', { error: (err as Error).message })
        return authUnavailable(c)
      }
      if (!doc) return unauthorized(c)
      const principal: Principal = {
        tenantId: doc.tenantId,
        scopes: doc.scopes,
        source: 'apiKey',
        keyId: doc._id,
        rateLimitRps: doc.rateLimitRps,
        budgetUsd: doc.budgetUsd,
      }
      // Revocation should take effect promptly even within the lookup TTL.
      if (doc.status !== 'active') {
        await invalidateKeyCache(doc.hash)
        return unauthorized(c)
      }
      touchKey(doc._id)
      c.set('principal', principal)
      return next()
    }

    if (bearer) {
      const payload = await verifyJwt(bearer)
      if (!payload) return unauthorized(c)
      const tenantId =
        (payload.tenant as string) ?? (payload.sub as string) ?? 'unknown'
      const principal: Principal = {
        tenantId,
        scopes: scopesFromClaims(payload),
        source: 'jwt',
      }
      c.set('principal', principal)
      return next()
    }

    return unauthorized(c)
  }

/** Per-route authorization: 403 when the principal lacks the required scope. */
export function requireScope(
  scope: Scope,
): MiddlewareHandler<{ Variables: GatewayVariables }> {
  return async (c, next: Next) => {
    const principal = c.get('principal')
    if (!principal || !hasScope(principal, scope)) {
      return c.json(
        { error: 'Forbidden', message: `Requires scope: ${scope}` },
        403,
      )
    }
    return next()
  }
}
