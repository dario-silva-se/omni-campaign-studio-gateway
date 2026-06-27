import { Hono } from 'hono'
import { renderPrometheus, snapshot } from '../telemetry/metrics.js'

/**
 * Metrics endpoint. Defaults to Prometheus text exposition; `?format=json`
 * returns the raw counter snapshot. Counters are per-instance (reset on cold
 * start) — durable cost/usage is available via /_gw/usage.
 */
export const metricsRouter = new Hono()

metricsRouter.get('/', (c) => {
  if (c.req.query('format') === 'json') {
    return c.json(snapshot())
  }
  return c.text(renderPrometheus(), 200, {
    'content-type': 'text/plain; version=0.0.4',
  })
})
