import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { SignJWT, decodeJwt } from 'jose'
import { env } from '../config/env.js'
import {
  authSessionsCollection,
  type AuthSessionDoc,
  type UserDoc,
} from '../db/collections.js'

function secretKey(): Uint8Array {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required to issue access tokens')
  }
  return new TextEncoder().encode(env.JWT_SECRET)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface IssuedToken {
  accessToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
}

/**
 * Sign a short-lived HS256 access token for a user. Claims mirror what
 * `auth/jwt.ts` validates: `tenant`, `scope` (space-delimited), plus optional
 * issuer/audience. The same `JWT_SECRET` verifies it on the request path.
 */
export async function issueAccessToken(user: UserDoc): Promise<IssuedToken> {
  let signer = new SignJWT({ tenant: user.tenantId, scope: user.scopes.join(' ') })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user._id)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
  if (env.JWT_ISSUER) signer = signer.setIssuer(env.JWT_ISSUER)
  if (env.JWT_AUDIENCE) signer = signer.setAudience(env.JWT_AUDIENCE)

  const accessToken = await signer.sign(secretKey())
  const { exp } = decodeJwt(accessToken)
  const expiresIn = exp ? exp - Math.floor(Date.now() / 1000) : 0
  return { accessToken, expiresIn }
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
}

/** Mint a refresh token for a user, storing only its hash. Returns the raw token. */
export async function mintRefresh(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url')
  const doc: AuthSessionDoc = {
    _id: randomUUID(),
    userId,
    refreshHash: sha256(raw),
    expiresAt: refreshExpiry(),
    createdAt: new Date(),
  }
  const col = await authSessionsCollection()
  await col.insertOne(doc)
  return raw
}

/**
 * Validate a refresh token and rotate it (single-use): the old session is
 * deleted and a new one minted. Returns the userId + new raw token, or null if
 * the token is unknown/expired.
 */
export async function rotateRefresh(
  raw: string,
): Promise<{ userId: string; refresh: string } | null> {
  const col = await authSessionsCollection()
  const session = await col.findOneAndDelete({ refreshHash: sha256(raw) })
  if (!session || session.expiresAt.getTime() <= Date.now()) return null
  const refresh = await mintRefresh(session.userId)
  return { userId: session.userId, refresh }
}

/** Revoke a refresh token (logout). No-op if it does not exist. */
export async function revokeRefresh(raw: string): Promise<void> {
  const col = await authSessionsCollection()
  await col.deleteOne({ refreshHash: sha256(raw) })
}
