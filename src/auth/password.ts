import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

const KEYLEN = 64

/**
 * Password hashing with scrypt (Node's crypto — no external dependency).
 * Stored form is `saltHex:hashHex`. The raw password is never persisted.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEYLEN)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/** Constant-time verification of a password against a stored `salt:hash`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const derived = await scrypt(password, salt, expected.length)
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}
