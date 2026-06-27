import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { env, hasJwt } from '../config/env.js'

/**
 * Verify an end-user JWT (studio frontend). Supports either a remote JWKS
 * (asymmetric, recommended) or a shared HS256 secret. Returns the payload on
 * success, or null when JWT auth is disabled or the token is invalid.
 */

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

function getJwks() {
  if (!env.JWT_JWKS_URL) return undefined
  if (!jwks) jwks = createRemoteJWKSet(new URL(env.JWT_JWKS_URL))
  return jwks
}

export async function verifyJwt(token: string): Promise<JWTPayload | null> {
  if (!hasJwt) return null
  const options = {
    issuer: env.JWT_ISSUER || undefined,
    audience: env.JWT_AUDIENCE || undefined,
  }
  try {
    const keySet = getJwks()
    if (keySet) {
      const { payload } = await jwtVerify(token, keySet, options)
      return payload
    }
    if (env.JWT_SECRET) {
      const secret = new TextEncoder().encode(env.JWT_SECRET)
      const { payload } = await jwtVerify(token, secret, options)
      return payload
    }
    return null
  } catch {
    return null
  }
}

/**
 * Map JWT claims to gateway scopes. A `scope`/`scp`/`permissions` claim (space-
 * or array-delimited) is honored; otherwise an authenticated user gets read +
 * AI invoke by default. `admin` is only granted when explicitly claimed.
 */
export function scopesFromClaims(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp ?? payload.permissions
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean)
  if (Array.isArray(raw)) return raw.map(String)
  return ['api:read', 'api:write', 'ai:invoke']
}
