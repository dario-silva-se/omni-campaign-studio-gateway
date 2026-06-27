import { Redis } from '@upstash/redis'
import { env, hasUpstash } from '../config/env.js'

/**
 * Cache + counter abstraction. Uses Upstash Redis (REST) when configured,
 * otherwise an in-process Map so the gateway works locally and in tests without
 * Redis. Mirrors the cache module of omni-campaign-studio-api but adds atomic
 * counter helpers used for cost/budget tracking.
 */
export interface KeyStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  /** Atomically add `amount` to a numeric key and return the new total. */
  incrByFloat(key: string, amount: number): Promise<number>
}

class MemoryStore implements KeyStore {
  private store = new Map<string, { value: unknown; expiresAt: number }>()

  private live(key: string): { value: unknown; expiresAt: number } | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.live(key)?.value as T) ?? null
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    })
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
  }

  async incrByFloat(key: string, amount: number): Promise<number> {
    const current = (this.live(key)?.value as number) ?? 0
    const next = current + amount
    // Preserve any existing TTL window.
    const existing = this.store.get(key)
    this.store.set(key, { value: next, expiresAt: existing?.expiresAt ?? 0 })
    return next
  }
}

class RedisStore implements KeyStore {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(key)) ?? null
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.redis.set(key, value, { ex: ttlSeconds })
    else await this.redis.set(key, value)
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async incrByFloat(key: string, amount: number): Promise<number> {
    return this.redis.incrbyfloat(key, amount)
  }
}

let redisClient: Redis | undefined

/** The shared Upstash client, or undefined when not configured. */
export function getRedis(): Redis | undefined {
  if (!hasUpstash) return undefined
  if (!redisClient) {
    redisClient = new Redis({
      url: env.UPSTASH_REDIS_REST_URL as string,
      token: env.UPSTASH_REDIS_REST_TOKEN as string,
    })
  }
  return redisClient
}

function createStore(): KeyStore {
  const redis = getRedis()
  return redis ? new RedisStore(redis) : new MemoryStore()
}

export const store: KeyStore = createStore()
