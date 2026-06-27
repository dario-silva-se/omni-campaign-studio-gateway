import { describe, it, expect } from 'vitest'
import { costUsd, priceFor, FALLBACK_PRICE } from './pricing.js'

describe('pricing', () => {
  it('computes cost from input/output tokens', () => {
    // gpt-4o-mini: 0.15 in / 0.6 out per 1M
    const cost = costUsd('gpt-4o-mini', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(0.75, 6)
  })

  it('prorates partial token counts', () => {
    const cost = costUsd('gpt-4o', 500_000, 0) // 2.5 per 1M input
    expect(cost).toBeCloseTo(1.25, 6)
  })

  it('falls back to a conservative price for unknown models', () => {
    expect(priceFor('totally-made-up')).toBe(FALLBACK_PRICE)
    const cost = costUsd('totally-made-up', 1_000_000, 0)
    expect(cost).toBeCloseTo(FALLBACK_PRICE.inputPerMTok / 1, 6)
  })
})
