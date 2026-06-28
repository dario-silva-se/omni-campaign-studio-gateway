import type { MiddlewareHandler, Next } from 'hono'
import { env } from '../config/env.js'
import { store } from '../cache/redis.js'
import { currentYyyymm } from '../db/collections.js'
import type { GatewayVariables } from '../auth/principal.js'

/**
 * Cost control. A per-tenant, per-month USD counter is kept in the key store for
 * fast reads/writes on the request path; the durable monthly rollup lives in
 * Mongo (written by the telemetry recorder). When the counter meets or exceeds
 * the tenant's budget, further billable requests are rejected with 402.
 */

const spendKey = (tenantId: string, yyyymm: number) =>
  `cost:${tenantId}:${yyyymm}`

/** Resolve the monthly budget (USD) for a principal. 0 disables the cap. */
export function budgetFor(budgetUsd?: number): number {
  return budgetUsd ?? env.DEFAULT_MONTHLY_BUDGET_USD
}

/** Current month spend (USD) for a tenant, from the fast counter. */
export async function getMonthlySpend(
  tenantId: string,
  now = new Date(),
): Promise<number> {
  const value = await store.get<number>(spendKey(tenantId, currentYyyymm(now)))
  return value ?? 0
}

/** Add cost to the fast counter and return the new running total. */
export async function addSpend(
  tenantId: string,
  amountUsd: number,
  now = new Date(),
): Promise<number> {
  if (amountUsd <= 0) return getMonthlySpend(tenantId, now)
  return store.incrByFloat(spendKey(tenantId, currentYyyymm(now)), amountUsd)
}

/**
 * Budget-enforcement middleware. Blocks billable requests once a tenant has met
 * or exceeded its monthly budget. A budget of 0 means "no cap". Sub-requests
 * that incur cost (AI) reconcile the exact amount afterwards via {@link addSpend}.
 */
export const enforceBudget: MiddlewareHandler<{ Variables: GatewayVariables }> =
  async (c, next: Next) => {
    const principal = c.get('principal')
    const budget = budgetFor(principal?.budgetUsd)
    if (budget > 0 && principal) {
      const spent = await getMonthlySpend(principal.tenantId)
      if (spent >= budget) {
        return c.json(
          {
            error: 'Payment Required',
            message: `Monthly budget of $${budget.toFixed(2)} exhausted (spent $${spent.toFixed(2)})`,
          },
          402,
        )
      }
    }
    return next()
  }
