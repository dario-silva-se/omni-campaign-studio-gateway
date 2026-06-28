import { describe, it, expect } from 'vitest'
import { limiter, rpsFor } from './limiter.js'
import { env } from '../config/env.js'

describe('rate limiter (in-memory fallback)', () => {
  it('allows up to the limit then rejects within the window', async () => {
    const id = `test-${Math.random()}`
    const first = await limiter.limit(id, 2)
    const second = await limiter.limit(id, 2)
    const third = await limiter.limit(id, 2)
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(third.success).toBe(false)
    expect(third.remaining).toBe(0)
  })

  it('resolves the ceiling from override or env default', () => {
    expect(rpsFor(5)).toBe(5)
    expect(rpsFor(undefined)).toBe(env.RATELIMIT_RPS)
  })
})
