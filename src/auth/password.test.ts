import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('s3cret')
    expect(await verifyPassword('not-it', stored)).toBe(false)
  })

  it('produces a salted hash (different each time, never the raw password)', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    expect(a).not.toContain('same')
  })

  it('returns false for a malformed stored value', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false)
  })
})
