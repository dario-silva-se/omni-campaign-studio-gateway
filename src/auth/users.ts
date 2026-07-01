import { randomUUID } from 'node:crypto'
import { usersCollection, type Scope, type UserDoc } from '../db/collections.js'
import { hashPassword, verifyPassword } from './password.js'

export interface CreateUserInput {
  email: string
  password: string
  tenantId: string
  scopes: Scope[]
  name?: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Create and persist a user. Throws on duplicate email (unique index). */
export async function createUser(input: CreateUserInput): Promise<UserDoc> {
  const doc: UserDoc = {
    _id: randomUUID(),
    email: normalizeEmail(input.email),
    passwordHash: await hashPassword(input.password),
    tenantId: input.tenantId,
    scopes: input.scopes,
    status: 'active',
    createdAt: new Date().toISOString(),
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
  }
  const col = await usersCollection()
  await col.insertOne(doc)
  return doc
}

export async function findByEmail(email: string): Promise<UserDoc | null> {
  const col = await usersCollection()
  return col.findOne({ email: normalizeEmail(email) })
}

export async function findById(id: string): Promise<UserDoc | null> {
  const col = await usersCollection()
  return col.findOne({ _id: id })
}

/**
 * Verify email + password. Returns the active user on success, otherwise null.
 * Always runs the password comparison shape uniformly to avoid leaking, via
 * timing, whether the email exists.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<UserDoc | null> {
  const user = await findByEmail(email)
  if (!user || user.status !== 'active') {
    // Spend comparable work even when the user is missing/disabled.
    await verifyPassword(password, 'aa:bb')
    return null
  }
  const ok = await verifyPassword(password, user.passwordHash)
  return ok ? user : null
}

/** Best-effort lastLoginAt touch; never blocks the request path. */
export function touchLogin(userId: string): void {
  void usersCollection()
    .then((col) =>
      col.updateOne({ _id: userId }, { $set: { lastLoginAt: new Date().toISOString() } }),
    )
    .catch(() => {})
}
