import { describe, it, expect } from 'vitest'
import { generateRawKey, hashKey, lookupKey, KEY_PREFIX } from './apiKey.js'

describe('apiKey', () => {
  it('generates prefixed opaque keys', () => {
    const raw = generateRawKey()
    expect(raw.startsWith(KEY_PREFIX)).toBe(true)
    expect(raw.length).toBeGreaterThan(KEY_PREFIX.length + 20)
  })

  it('hashes deterministically and hides the raw value', () => {
    const raw = generateRawKey()
    expect(hashKey(raw)).toBe(hashKey(raw))
    expect(hashKey(raw)).not.toContain(raw)
    expect(hashKey('a')).not.toBe(hashKey('b'))
  })

  it('rejects credentials without the gateway prefix without touching the db', async () => {
    expect(await lookupKey('not-a-gateway-key')).toBeNull()
  })
})
