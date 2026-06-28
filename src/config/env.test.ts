import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from './env.js'

describe('normalizeBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeBaseUrl('http://x/api/')).toBe('http://x/api')
  })

  it('strips multiple trailing slashes', () => {
    expect(normalizeBaseUrl('http://x/api///')).toBe('http://x/api')
  })

  it('leaves a clean URL unchanged and is idempotent', () => {
    const clean = 'http://x/api'
    expect(normalizeBaseUrl(clean)).toBe(clean)
    expect(normalizeBaseUrl(normalizeBaseUrl('http://x/api/'))).toBe(clean)
  })
})
