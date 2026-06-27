import { Hono } from 'hono'
import type { GatewayVariables } from '../auth/principal.js'
import { hasScope } from '../auth/principal.js'
import { currentYyyymm, usageMonthlyCollection } from '../db/collections.js'
import { budgetFor, getMonthlySpend } from '../cost/budget.js'

/**
 * Usage & cost reporting (Vercel-AI-Gateway-style). Returns the current month's
 * request/token/cost rollup plus live budget status for a tenant. Callers see
 * their own tenant; admins may query any tenant via `?tenantId=`.
 */
export const usageRouter = new Hono<{ Variables: GatewayVariables }>()

usageRouter.get('/', async (c) => {
  const principal = c.get('principal')
  const requested = c.req.query('tenantId')
  const tenantId =
    requested && hasScope(principal, 'admin') ? requested : principal.tenantId

  const yyyymm = currentYyyymm()
  const col = await usageMonthlyCollection()
  const rollup = await col.findOne({ _id: `${tenantId}:${yyyymm}` })

  const budget = budgetFor(principal.budgetUsd)
  const spent = await getMonthlySpend(tenantId)

  return c.json({
    tenantId,
    period: yyyymm,
    requests: rollup?.requests ?? 0,
    inputTokens: rollup?.inputTokens ?? 0,
    outputTokens: rollup?.outputTokens ?? 0,
    costUsd: rollup?.costUsd ?? 0,
    budget: {
      limitUsd: budget,
      spentUsd: spent,
      remainingUsd: budget > 0 ? Math.max(0, budget - spent) : null,
    },
  })
})
