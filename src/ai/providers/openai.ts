import { env } from '../../config/env.js'
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

/** OpenAI chat-completions adapter (BYOK). Request/response are already in the
 * gateway's canonical shape, so this is a near-passthrough plus usage extraction. */
export const openaiProvider: ChatProvider = {
  name: 'openai',

  isConfigured() {
    return !!env.OPENAI_API_KEY
  },

  async chat(request: ChatRequest): Promise<ChatResult> {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(request),
    })

    const body = (await res.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      error?: { message?: string }
    }
    if (!res.ok) {
      throw new ProviderError(body?.error?.message ?? 'OpenAI request failed', res.status)
    }

    return {
      body,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    }
  },
}
