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
  limit(identifier: string, max: number, windowMs?: number): Promise<LimitResult>
}

/** Upstash-backed sliding-window limiter (window configurable, default 1s). */
class RedisLimiter implements Limiter {
  private cache = new Map<string, Ratelimit>()

  constructor(private readonly redis: NonNullable<ReturnType<typeof getRedis>>) {}

  private forWindow(max: number, windowMs: number): Ratelimit {
    const key = `${max}:${windowMs}`
    let rl = this.cache.get(key)
    if (!rl) {
      const seconds = Math.max(1, Math.round(windowMs / 1000))
      rl = new Ratelimit({
        redis: this.redis,
        limiter: Ratelimit.slidingWindow(max, `${seconds} s`),
        prefix: 'gw:rl',
      })
      this.cache.set(key, rl)
    }
    return rl
  }

  async limit(identifier: string, max: number, windowMs = 1000): Promise<LimitResult> {
    const r = await this.forWindow(max, windowMs).limit(identifier)
    return { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset }
  }
}

/** In-process sliding window for local dev / tests (no Redis). */
class MemoryLimiter implements Limiter {
  private hits = new Map<string, number[]>()

  async limit(identifier: string, max: number, windowMs = 1000): Promise<LimitResult> {
    const now = Date.now()
    const windowStart = now - windowMs
    const recent = (this.hits.get(identifier) ?? []).filter((t) => t > windowStart)
    const success = recent.length < max
    if (success) recent.push(now)
    this.hits.set(identifier, recent)
    const reset = (recent[0] ?? now) + windowMs
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

/** Best-effort client IP for unauthenticated (pre-principal) rate limiting. */
function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

const AUTH_MAX_ATTEMPTS = 10
const AUTH_WINDOW_MS = 60_000

/**
 * Per-IP brute-force guard for the public auth endpoints (login/refresh), which
 * run before authentication so the tenant-based limiter does not apply. Limits
 * to {@link AUTH_MAX_ATTEMPTS} attempts per minute per IP.
 */
export const authRateLimit: MiddlewareHandler = async (c, next: Next) => {
  const result = await limiter.limit(
    `auth:${clientIp(c)}`,
    AUTH_MAX_ATTEMPTS,
    AUTH_WINDOW_MS,
  )
  if (!result.success) return tooManyRequests(c, result)
  return next()
}
