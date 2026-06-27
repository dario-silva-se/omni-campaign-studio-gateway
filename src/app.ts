import { Hono } from 'hono'
import type { MiddlewareHandler, Next } from 'hono'
import { cors } from 'hono/cors'
import { allowedOrigins } from './config/env.js'
import type { GatewayVariables } from './auth/principal.js'
import { authenticate, requireScope } from './auth/middleware.js'
import { rateLimit } from './ratelimit/limiter.js'
import { enforceBudget } from './cost/budget.js'
import { telemetry } from './telemetry/middleware.js'
import { proxyToUpstream } from './proxy/upstream.js'
import { aiRouter } from './ai/handler.js'
import { adminKeysRouter } from './admin/keys.js'
import { healthRouter } from './routes/health.js'
import { metricsRouter } from './routes/metrics.js'
import { usageRouter } from './routes/usage.js'

/**
 * Build the gateway. The middleware pipeline mirrors AWS API Gateway stage +
 * Vercel AI Gateway concerns, in order:
 *   telemetry → CORS → auth → rate limit → budget → handler.
 *
 * Surfaces:
 *   /_gw/health           public liveness/readiness (no auth)
 *   /_gw/metrics          Prometheus/JSON metrics (admin)
 *   /_gw/usage            tenant usage + budget (any authenticated)
 *   /_gw/keys             API-key management (admin)
 *   /ai/v1/*              AI proxy with token cost accounting (ai:invoke)
 *   /api/*               reverse proxy to omni-campaign-studio-api (api:read/write)
 */
export function createApp(): Hono<{ Variables: GatewayVariables }> {
  const app = new Hono<{ Variables: GatewayVariables }>()

  // Telemetry first so it also captures auth/limit/budget rejections.
  app.use('*', telemetry)
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return origin
        return allowedOrigins.includes(origin) ? origin : null
      },
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
    }),
  )

  // Public health check — registered before auth so monitors need no credential.
  app.route('/_gw/health', healthRouter)

  // Everything below requires authentication + is rate limited.
  app.use('*', authenticate)
  app.use('*', rateLimit)

  // Control plane (authorization per surface).
  app.use('/_gw/metrics', requireScope('admin'))
  app.route('/_gw/metrics', metricsRouter)
  app.route('/_gw/usage', usageRouter)
  app.use('/_gw/keys', requireScope('admin'))
  app.use('/_gw/keys/*', requireScope('admin'))
  app.route('/_gw', adminKeysRouter)

  // AI proxy — billable, budget-enforced, requires ai:invoke.
  app.use('/ai/*', requireScope('ai:invoke'))
  app.use('/ai/*', enforceBudget)
  app.route('/ai', aiRouter)

  // CRUD reverse proxy — billable, budget-enforced, method-based scope.
  app.use('/api/*', enforceBudget)
  app.use('/api/*', proxyScope)
  app.all('/api/*', proxyToUpstream)

  app.notFound((c) =>
    c.json({ error: 'Not Found', message: `No route for ${c.req.path}` }, 404),
  )

  app.onError((err, c) => {
    console.error('[unhandled]', err)
    return c.json({ error: 'Internal Server Error', message: err.message }, 500)
  })

  return app
}

/** Method-aware authorization for proxied CRUD calls: reads vs writes. */
const requireRead = requireScope('api:read')
const requireWrite = requireScope('api:write')
const proxyScope: MiddlewareHandler<{ Variables: GatewayVariables }> = (c, next: Next) => {
  const method = c.req.method
  return method === 'GET' || method === 'HEAD' ? requireRead(c, next) : requireWrite(c, next)
}

export const app = createApp()
