import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { GatewayVariables } from '../auth/principal.js'
import { apiKeysCollection } from '../db/collections.js'
import { invalidateKeyCache, issueKey } from '../auth/apiKey.js'

const ScopeSchema = z.enum(['api:read', 'api:write', 'ai:invoke', 'admin'])

const IssueSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1),
  scopes: z.array(ScopeSchema).min(1),
  rateLimitRps: z.number().int().positive().optional(),
  budgetUsd: z.number().nonnegative().optional(),
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

/** Strip the secret hash before returning a key document. */
function redact<T extends { hash: string }>(doc: T): Omit<T, 'hash'> {
  const { hash: _hash, ...rest } = doc
  return rest
}

/**
 * Admin API-key management. All routes require the `admin` scope (enforced by
 * app.ts). Issuing a key returns the raw value exactly once — only its hash is
 * ever stored.
 */
export const adminKeysRouter = new Hono<{ Variables: GatewayVariables }>()

adminKeysRouter.post(
  '/keys',
  zValidator('json', IssueSchema, validationHook as any),
  async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof IssueSchema>
    const { raw, doc } = await issueKey(input)
    return c.json({ key: raw, ...redact(doc) }, 201)
  },
)

adminKeysRouter.get('/keys', async (c) => {
  const tenantId = c.req.query('tenantId')
  const col = await apiKeysCollection()
  const filter = tenantId ? { tenantId } : {}
  const docs = await col.find(filter).sort({ createdAt: -1 }).toArray()
  return c.json(docs.map(redact))
})

adminKeysRouter.delete('/keys/:id', async (c) => {
  const id = c.req.param('id')
  const col = await apiKeysCollection()
  const doc = await col.findOne({ _id: id })
  if (!doc) {
    return c.json({ error: 'Not Found', message: `key/${id} not found` }, 404)
  }
  await col.updateOne({ _id: id }, { $set: { status: 'revoked' } })
  await invalidateKeyCache(doc.hash)
  return c.body(null, 204)
})
