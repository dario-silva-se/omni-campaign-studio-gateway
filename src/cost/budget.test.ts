import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { addSpend, getMonthlySpend, enforceBudget, budgetFor } from './budget.js'
import type { GatewayVariables, Principal } from '../auth/principal.js'

describe('budget', () => {
  it('accumulates spend per tenant', async () => {
    const tenant = `t-${Math.random()}`
    expect(await getMonthlySpend(tenant)).toBe(0)
    await addSpend(tenant, 1.5)
    await addSpend(tenant, 0.25)
    expect(await getMonthlySpend(tenant)).toBeCloseTo(1.75, 6)
  })

  it('resolves budget from override or env default', () => {
    expect(budgetFor(10)).toBe(10)
    expect(typeof budgetFor(undefined)).toBe('number')
  })

  it('blocks with 402 once the budget is exhausted', async () => {
    const tenant = `t-${Math.random()}`
    const principal: Principal = {
      tenantId: tenant,
      scopes: ['ai:invoke'],
      source: 'apiKey',
      budgetUsd: 1,
    }
    await addSpend(tenant, 5)

    const app = new Hono<{ Variables: GatewayVariables }>()
    app.use('*', async (c, next) => {
      c.set('principal', principal)
      await next()
    })
    app.use('*', enforceBudget)
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/')
    expect(res.status).toBe(402)
  })

  it('allows requests when under budget', async () => {
    const tenant = `t-${Math.random()}`
    const principal: Principal = {
      tenantId: tenant,
      scopes: ['ai:invoke'],
      source: 'apiKey',
      budgetUsd: 100,
    }
    const app = new Hono<{ Variables: GatewayVariables }>()
    app.use('*', async (c, next) => {
      c.set('principal', principal)
      await next()
    })
    app.use('*', enforceBudget)
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
