/**
 * Model price table used to turn token usage into a USD cost for budget
 * enforcement and telemetry. Prices are USD per 1,000,000 tokens, split into
 * input (prompt) and output (completion), matching how providers bill.
 *
 * Keep this in sync with provider pricing. Unknown models fall back to a
 * conservative default so cost is never silently counted as zero.
 */
export interface ModelPrice {
  /** Canonical provider that serves this model. */
  provider: 'openai' | 'anthropic'
  /** USD per 1M input tokens. */
  inputPerMTok: number
  /** USD per 1M output tokens. */
  outputPerMTok: number
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { provider: 'openai', inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-mini': { provider: 'openai', inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4.1': { provider: 'openai', inputPerMTok: 2, outputPerMTok: 8 },
  'gpt-4.1-mini': { provider: 'openai', inputPerMTok: 0.4, outputPerMTok: 1.6 },

  // Anthropic
  'claude-opus-4': { provider: 'anthropic', inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4': { provider: 'anthropic', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4': { provider: 'anthropic', inputPerMTok: 0.8, outputPerMTok: 4 },
}

/** Conservative fallback when a model is not in the table. */
export const FALLBACK_PRICE: ModelPrice = {
  provider: 'openai',
  inputPerMTok: 5,
  outputPerMTok: 15,
}

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICING[model] ?? FALLBACK_PRICE
}

/** Compute USD cost for a completion given its token usage. */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceFor(model)
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  )
}
