import { Ratelimit } from '@upstash/ratelimit'
import type { Context, MiddlewareHandler, Next } from 'hono'
import { env } from '../config/env.js'
import { getRedis } from '../cache/redis.js'
import type { GatewayVariables } from '../auth/principal.js'

export interface LimitResult {
  success: boolean
  limit: number
  remaining: number
  /** Epoch ms when the window resets. */
  reset: number
}

interface Limiter {
  limit(identifier: string, max: number): Promise<LimitResult>
}

/** Upstash-backed sliding window (1s) limiter. */
class RedisLimiter implements Limiter {
  private cache = new Map<number, Ratelimit>()

  constructor(private readonly redis: NonNullable<ReturnType<typeof getRedis>>) {}

  private forMax(max: number): Ratelimit {
    let rl = this.cache.get(max)
    if (!rl) {
      rl = new Ratelimit({
        redis: this.redis,
        limiter: Ratelimit.slidingWindow(max, '1 s'),
        prefix: 'gw:rl',
      })
      this.cache.set(max, rl)
    }
    return rl
  }

  async limit(identifier: string, max: number): Promise<LimitResult> {
    const r = await this.forMax(max).limit(identifier)
    return { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset }
  }
}

/** In-process sliding window for local dev / tests (no Redis). */
class MemoryLimiter implements Limiter {
  private hits = new Map<string, number[]>()

  async limit(identifier: string, max: number): Promise<LimitResult> {
    const now = Date.now()
    const windowStart = now - 1000
    const recent = (this.hits.get(identifier) ?? []).filter((t) => t > windowStart)
    const success = recent.length < max
    if (success) recent.push(now)
    this.hits.set(identifier, recent)
    const reset = (recent[0] ?? now) + 1000
    return {
      success,
      limit: max,
      remaining: Math.max(0, max - recent.length),
      reset,
    }
  }
}

function createLimiter(): Limiter {
  const redis = getRedis()
  return redis ? new RedisLimiter(redis) : new MemoryLimiter()
}

export const limiter: Limiter = createLimiter()

/** Resolve the request-rate ceiling for a principal (override or env default). */
export function rpsFor(rateLimitRps?: number): number {
  return rateLimitRps ?? env.RATELIMIT_RPS
}

function tooManyRequests(c: Context, result: LimitResult) {
  const retryAfter = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000))
  c.header('Retry-After', String(retryAfter))
  setRateLimitHeaders(c, result)
  return c.json(
    { error: 'Too Many Requests', message: 'Rate limit exceeded' },
    429,
  )
}

function setRateLimitHeaders(c: Context, result: LimitResult) {
  c.header('X-RateLimit-Limit', String(result.limit))
  c.header('X-RateLimit-Remaining', String(result.remaining))
  c.header('X-RateLimit-Reset', String(Math.ceil(result.reset / 1000)))
}

/**
 * Rate-limiting middleware. Buckets by tenant so a tenant's keys share a quota,
 * using the principal's override or the env default as the per-second ceiling.
 * Emits standard `X-RateLimit-*` headers and a `Retry-After` on 429.
 */
export const rateLimit: MiddlewareHandler<{ Variables: GatewayVariables }> =
  async (c, next: Next) => {
    const principal = c.get('principal')
    const max = rpsFor(principal?.rateLimitRps)
    const identifier = principal ? `tenant:${principal.tenantId}` : 'anon'
    const result = await limiter.limit(identifier, max)
    if (!result.success) return tooManyRequests(c, result)
    setRateLimitHeaders(c, result)
    return next()
  }
