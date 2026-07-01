import type { Collection } from 'mongodb'
import { getDb } from './connection.js'
import { env } from '../config/env.js'

/* --------------------------------- Types --------------------------------- */

export type Scope =
  | 'api:read'
  | 'api:write'
  | 'ai:invoke'
  | 'admin'

export interface ApiKeyDoc {
  /** Stable id (uuid). */
  _id: string
  /** SHA-256 hex of the raw key — the raw key is never stored. */
  hash: string
  /** Tenant the key belongs to (groups usage/budget). */
  tenantId: string
  /** Human-friendly label. */
  name: string
  /** Granted scopes. */
  scopes: Scope[]
  status: 'active' | 'revoked'
  /** Optional per-key request-rate override (requests/second). */
  rateLimitRps?: number
  /** Optional per-key monthly budget override (USD). */
  budgetUsd?: number
  createdAt: string
  lastUsedAt?: string
}

export interface RequestLogDoc {
  _id: string
  requestId: string
  tenantId: string
  keyId?: string
  source: 'apiKey' | 'jwt'
  method: string
  path: string
  /** 'proxy' | 'ai' | 'control' */
  kind: string
  status: number
  latencyMs: number
  /** AI-only fields. */
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** Date the document was created; backs the TTL index. */
  createdAt: Date
}

export interface UsageMonthlyDoc {
  /** `${tenantId}:${yyyymm}` */
  _id: string
  tenantId: string
  /** e.g. 202606 */
  yyyymm: number
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  updatedAt: string
}

export interface UserDoc {
  /** Stable id (uuid). */
  _id: string
  /** Login identifier; unique, stored lowercased. */
  email: string
  /** Optional display name (collected at self-registration). */
  name?: string
  /** scrypt hash in `salt:hash` hex form — the raw password is never stored. */
  passwordHash: string
  /** Tenant the user belongs to (groups usage/budget). */
  tenantId: string
  /** Granted scopes (may include `ai:invoke`). */
  scopes: Scope[]
  status: 'active' | 'disabled'
  createdAt: string
  lastLoginAt?: string
}

export interface AuthSessionDoc {
  /** Stable id (uuid). */
  _id: string
  userId: string
  /** SHA-256 hex of the refresh token — the raw token is never stored. */
  refreshHash: string
  /** Backs the TTL index; the session expires at this instant. */
  expiresAt: Date
  createdAt: Date
}

/* ------------------------------- Accessors ------------------------------- */

export async function apiKeysCollection(): Promise<Collection<ApiKeyDoc>> {
  return (await getDb()).collection<ApiKeyDoc>('api_keys')
}

export async function requestLogsCollection(): Promise<Collection<RequestLogDoc>> {
  return (await getDb()).collection<RequestLogDoc>('request_logs')
}

export async function usageMonthlyCollection(): Promise<Collection<UsageMonthlyDoc>> {
  return (await getDb()).collection<UsageMonthlyDoc>('usage_monthly')
}

export async function usersCollection(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>('users')
}

export async function authSessionsCollection(): Promise<Collection<AuthSessionDoc>> {
  return (await getDb()).collection<AuthSessionDoc>('auth_sessions')
}

/**
 * Create indexes used by the gateway. Idempotent — safe to call from the seed
 * script and on demand. The request_logs TTL index expires telemetry after
 * TELEMETRY_RETENTION_DAYS.
 */
export async function ensureIndexes(): Promise<void> {
  const [keys, logs, usage, users, sessions] = await Promise.all([
    apiKeysCollection(),
    requestLogsCollection(),
    usageMonthlyCollection(),
    usersCollection(),
    authSessionsCollection(),
  ])
  await Promise.all([
    keys.createIndex({ hash: 1 }, { unique: true }),
    keys.createIndex({ tenantId: 1 }),
    logs.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: env.TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 },
    ),
    logs.createIndex({ tenantId: 1, createdAt: -1 }),
    usage.createIndex({ tenantId: 1, yyyymm: -1 }),
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ refreshHash: 1 }, { unique: true }),
    // TTL: expire sessions exactly at their expiresAt instant.
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ])
}

/** Current period key, e.g. 202606, in UTC. */
export function currentYyyymm(now = new Date()): number {
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1)
}
