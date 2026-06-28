import type { Context } from 'hono'
import { env } from '../config/env.js'
import type { GatewayVariables } from '../auth/principal.js'
import { log } from '../telemetry/logger.js'

/** Hop-by-hop and gateway-internal headers that must not be forwarded upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'authorization',
  'x-api-key',
  'content-length',
])

const STRIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding'])

/**
 * Reverse proxy to the upstream CRUD API (omni-campaign-studio-api).
 *
 * The gateway exposes the same surface under `/api/*`; this strips that prefix
 * and re-issues the request against `UPSTREAM_API_URL` (which already ends in
 * `/api`). Gateway credentials are removed before forwarding — the upstream is
 * trusted and the gateway is the trust boundary. Tracing/forwarding headers are
 * added so the upstream can correlate logs.
 */
export async function proxyToUpstream(
  c: Context<{ Variables: GatewayVariables }>,
): Promise<Response> {
  const principal = c.get('principal')
  const requestId = c.get('requestId')

  // Path after the gateway's "/api" base, plus the original query string.
  const subPath = c.req.path.replace(/^\/api/, '')
  const url = new URL(env.UPSTREAM_API_URL + subPath)
  const incomingUrl = new URL(c.req.url)
  url.search = incomingUrl.search

  const headers = new Headers()
  c.req.raw.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
  })
  if (requestId) headers.set('x-request-id', requestId)
  if (principal) {
    // Propagate identity downstream without leaking the raw credential.
    headers.set('x-gateway-tenant', principal.tenantId)
    headers.set('x-forwarded-by', 'omni-campaign-studio-gateway')
  }

  const method = c.req.method
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer()

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(env.UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    log.error('upstream fetch failed', {
      url: url.toString(),
      error: (err as Error).message,
    })
    // AbortSignal.timeout aborts with a TimeoutError — surface that as 504.
    if ((err as Error).name === 'TimeoutError') {
      return c.json(
        { error: 'Gateway Timeout', message: 'Upstream API did not respond in time' },
        504,
      )
    }
    return c.json(
      { error: 'Bad Gateway', message: 'Upstream API is unreachable' },
      502,
    )
  }

  // Start from headers already set on the response (X-Request-Id, X-RateLimit-*)
  // so returning a fresh Response does not drop the gateway's own headers.
  const responseHeaders = new Headers()
  c.res.headers.forEach((value, key) => responseHeaders.set(key, value))
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value)
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}
