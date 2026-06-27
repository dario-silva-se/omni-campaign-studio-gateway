import { Hono } from 'hono'
import { env, hasUpstash } from '../config/env.js'
import { getDb } from '../db/connection.js'
import { getRedis } from '../cache/redis.js'

/**
 * Health endpoint for monitoring. Checks the three dependencies the gateway
 * needs — the upstream API, Mongo, and Redis — and reports each independently so
 * an operator can see exactly what is degraded. Returns 200 when Mongo (the only
 * hard dependency) is reachable, 503 otherwise.
 */
export const healthRouter = new Hono()

async function checkUpstream(): Promise<'ok' | 'unreachable'> {
  try {
    const res = await fetch(`${env.UPSTREAM_API_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok ? 'ok' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

async function checkMongo(): Promise<'connected' | 'error'> {
  try {
    const db = await getDb()
    await db.command({ ping: 1 })
    return 'connected'
  } catch {
    return 'error'
  }
}

async function checkRedis(): Promise<'ok' | 'memory' | 'error'> {
  if (!hasUpstash) return 'memory'
  try {
    await getRedis()!.ping()
    return 'ok'
  } catch {
    return 'error'
  }
}

healthRouter.get('/', async (c) => {
  const [upstream, mongo, redis] = await Promise.all([
    checkUpstream(),
    checkMongo(),
    checkRedis(),
  ])
  const status = mongo === 'connected' ? 'ok' : 'degraded'
  return c.json({ status, upstream, mongo, redis }, status === 'ok' ? 200 : 503)
})
