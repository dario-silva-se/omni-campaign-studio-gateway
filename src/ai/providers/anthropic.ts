import { env } from '../../config/env.js'
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Anthropic Messages adapter (BYOK). Translates the canonical OpenAI chat shape
 * to the Anthropic Messages API and maps the response back to an
 * OpenAI-compatible body so clients see one consistent contract.
 */
export const anthropicProvider: ChatProvider = {
  name: 'anthropic',

  isConfigured() {
    return !!env.ANTHROPIC_API_KEY
  },

  async chat(request: ChatRequest): Promise<ChatResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY as string,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        system: system || undefined,
        messages,
        max_tokens: request.max_tokens ?? 1024,
        temperature: request.temperature,
      }),
    })

    const raw = (await res.json()) as {
      content?: { type: string; text?: string }[]
      stop_reason?: string
      usage?: { input_tokens?: number; output_tokens?: number }
      error?: { message?: string }
    }
    if (!res.ok) {
      throw new ProviderError(raw?.error?.message ?? 'Anthropic request failed', res.status)
    }

    const text = (raw.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    const inputTokens = raw.usage?.input_tokens ?? 0
    const outputTokens = raw.usage?.output_tokens ?? 0

    // Map to an OpenAI-compatible body.
    const body = {
      id: `gw-${Date.now()}`,
      object: 'chat.completion',
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: raw.stop_reason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }

    return { body, usage: { inputTokens, outputTokens } }
  },
}
