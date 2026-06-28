import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { GatewayVariables } from '../auth/principal.js'
import { usersCollection, type UserDoc } from '../db/collections.js'
import { createUser } from '../auth/users.js'

const ScopeSchema = z.enum(['api:read', 'api:write', 'ai:invoke', 'admin'])

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantId: z.string().min(1),
  scopes: z.array(ScopeSchema).min(1),
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

/** Strip the password hash before returning a user document. */
function redact<T extends { passwordHash: string }>(doc: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _h, ...rest } = doc
  return rest
}

/**
 * Admin user management. All routes require the `admin` scope (enforced by
 * app.ts). Passwords are stored only as scrypt hashes.
 */
export const adminUsersRouter = new Hono<{ Variables: GatewayVariables }>()

adminUsersRouter.post(
  '/users',
  zValidator('json', CreateUserSchema, validationHook as any),
  async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof CreateUserSchema>
    try {
      const doc = await createUser(input)
      return c.json(redact(doc), 201)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return c.json({ error: 'Conflict', message: 'Email already exists' }, 409)
      }
      throw err
    }
  },
)

adminUsersRouter.get('/users', async (c) => {
  const tenantId = c.req.query('tenantId')
  const col = await usersCollection()
  const filter = tenantId ? { tenantId } : {}
  const docs = await col.find(filter).sort({ createdAt: -1 }).toArray()
  return c.json(docs.map((d: UserDoc) => redact(d)))
})

adminUsersRouter.delete('/users/:id', async (c) => {
  const id = c.req.param('id')
  const col = await usersCollection()
  const result = await col.updateOne({ _id: id }, { $set: { status: 'disabled' } })
  if (result.matchedCount === 0) {
    return c.json({ error: 'Not Found', message: `user/${id} not found` }, 404)
  }
  return c.body(null, 204)
})
