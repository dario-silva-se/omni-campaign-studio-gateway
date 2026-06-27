import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { apiKeysCollection, type ApiKeyDoc, type Scope } from '../db/collections.js'
import { store } from '../cache/redis.js'

/** Prefix that identifies a gateway-issued key. */
export const KEY_PREFIX = 'gw_'

/** SHA-256 hex of a raw key. Lookups and storage use the hash only. */
export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Generate a new opaque key: `gw_` + 32 random bytes (base64url). */
export function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url')
}

export interface IssueKeyInput {
  tenantId: string
  name: string
  scopes: Scope[]
  rateLimitRps?: number
  budgetUsd?: number
}

/** Create and persist a key. Returns the raw key (shown once) and the stored doc. */
export async function issueKey(
  input: IssueKeyInput,
): Promise<{ raw: string; doc: ApiKeyDoc }> {
  const raw = generateRawKey()
  const doc: ApiKeyDoc = {
    _id: randomUUID(),
    hash: hashKey(raw),
    tenantId: input.tenantId,
    name: input.name,
    scopes: input.scopes,
    status: 'active',
    rateLimitRps: input.rateLimitRps,
    budgetUsd: input.budgetUsd,
    createdAt: new Date().toISOString(),
  }
  const col = await apiKeysCollection()
  await col.insertOne(doc)
  return { raw, doc }
}

const LOOKUP_TTL_SECONDS = 60
const lookupCacheKey = (hash: string) => `apikey:${hash}`

/**
 * Resolve a raw key to its active doc, or null. Caches the lookup briefly in the
 * key store to avoid a Mongo round-trip on every request. A revoked key is
 * cached as a tombstone so revocation takes effect within the TTL window.
 */
export async function lookupKey(raw: string): Promise<ApiKeyDoc | null> {
  if (!raw.startsWith(KEY_PREFIX)) return null
  const hash = hashKey(raw)
  const cacheKey = lookupCacheKey(hash)

  const cached = await store.get<ApiKeyDoc | 'missing'>(cacheKey)
  if (cached === 'missing') return null
  if (cached) return cached

  const col = await apiKeysCollection()
  const doc = await col.findOne({ hash, status: 'active' })
  await store.set(cacheKey, doc ?? 'missing', LOOKUP_TTL_SECONDS)
  return doc
}

/** Best-effort lastUsedAt touch; never blocks the request path. */
export function touchKey(keyId: string): void {
  void apiKeysCollection()
    .then((col) =>
      col.updateOne({ _id: keyId }, { $set: { lastUsedAt: new Date().toISOString() } }),
    )
    .catch(() => {})
}

/** Drop the cached lookup for a key hash (used after revoke/rotate). */
export async function invalidateKeyCache(hash: string): Promise<void> {
  await store.del(lookupCacheKey(hash))
}
