import { priceFor } from '../config/pricing.js'
import { anthropicProvider } from './providers/anthropic.js'
import { openaiProvider } from './providers/openai.js'
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './providers/types.js'
import { log } from '../telemetry/logger.js'

const PROVIDERS: Record<'openai' | 'anthropic', ChatProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
}

/**
 * Route a chat request to the provider that serves its model, with automatic
 * failover (Vercel-AI-Gateway-style): if the primary provider errors and another
 * configured provider exists, retry once on the fallback. Throws ProviderError
 * when no provider is configured or all candidates fail.
 */
export async function routeChat(request: ChatRequest): Promise<ChatResult> {
  const primaryName = priceFor(request.model).provider
  const ordered = [primaryName, ...(['openai', 'anthropic'] as const).filter((n) => n !== primaryName)]
  const candidates = ordered.map((n) => PROVIDERS[n]).filter((p) => p.isConfigured())

  if (candidates.length === 0) {
    throw new ProviderError('No AI provider is configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY)', 503)
  }

  let lastError: unknown
  for (const provider of candidates) {
    try {
      return await provider.chat(request)
    } catch (err) {
      lastError = err
      log.warn('ai provider failed, trying fallback', {
        provider: provider.name,
        error: (err as Error).message,
      })
    }
  }

  if (lastError instanceof ProviderError) throw lastError
  throw new ProviderError('All AI providers failed', 502)
}
