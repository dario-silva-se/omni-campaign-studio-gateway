import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler, Next } from 'hono'
import type { GatewayVariables } from '../auth/principal.js'
import { recordRequest } from './recorder.js'

/** Classify a request by its top-level path for telemetry/metrics grouping. */
function kindFor(path: string): 'proxy' | 'ai' | 'control' {
  if (path.startsWith('/ai')) return 'ai'
  if (path.startsWith('/_gw')) return 'control'
  return 'proxy'
}

/**
 * Telemetry middleware. Assigns a request id (honoring an inbound
 * `X-Request-Id`), measures latency, and records the request after the handler
 * runs. AI cost/tokens, set by the AI handler on `c.var.aiUsage`, are folded in.
 * Runs early so it also captures auth/rate-limit/budget rejections.
 */
export const telemetry: MiddlewareHandler<{ Variables: GatewayVariables }> =
  async (c, next: Next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)

    const start = Date.now()
    try {
      await next()
    } finally {
      const latencyMs = Date.now() - start
      const principal = c.get('principal')
      const aiUsage = c.get('aiUsage')
      recordRequest({
        requestId,
        tenantId: principal?.tenantId ?? 'anonymous',
        keyId: principal?.keyId,
        source: principal?.source ?? 'apiKey',
        method: c.req.method,
        path: c.req.path,
        kind: kindFor(c.req.path),
        status: c.res.status,
        latencyMs,
        model: aiUsage?.model,
        inputTokens: aiUsage?.inputTokens,
        outputTokens: aiUsage?.outputTokens,
        costUsd: aiUsage?.costUsd,
      })
    }
  }
