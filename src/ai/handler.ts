import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { GatewayVariables } from '../auth/principal.js'
import { costUsd } from '../config/pricing.js'
import { addSpend } from '../cost/budget.js'
import { routeChat } from './router.js'
import { ProviderError } from './providers/types.js'

const ChatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
})

function validationHook(
  result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
  c: { json: (body: unknown, status: 422) => Response },
): Response | undefined {
  if (!result.success && result.error) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ')
    return c.json({ error: 'Validation Error', message }, 422)
  }
  return undefined
}

/**
 * AI proxy router. Exposes an OpenAI-compatible `POST /v1/chat/completions`,
 * routes to the configured provider with failover, computes USD cost from token
 * usage, charges the tenant's monthly budget, and stamps usage on the context so
 * the telemetry middleware records tokens + cost. The `ai:invoke` scope is
 * enforced by the caller (app.ts) before reaching this router.
 */
export const aiRouter = new Hono<{ Variables: GatewayVariables }>()

aiRouter.post(
  '/v1/chat/completions',
  zValidator('json', ChatSchema, validationHook as any),
  async (c) => {
    const request = c.req.valid('json' as never) as z.infer<typeof ChatSchema>
    const principal = c.get('principal')

    try {
      const result = await routeChat(request)
      const cost = costUsd(
        request.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
      )

      // Stamp usage for telemetry and charge the tenant's running monthly spend.
      c.set('aiUsage', {
        model: request.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: cost,
      })
      if (principal) await addSpend(principal.tenantId, cost)

      return c.json(result.body as object)
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json(
          { error: 'AI Provider Error', message: err.message },
          (err.status >= 400 && err.status <= 599 ? err.status : 502) as any,
        )
      }
      throw err
    }
  },
)
