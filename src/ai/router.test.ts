import { describe, it, expect, vi, afterEach } from 'vitest'
import { routeChat } from './router.js'
import { ProviderError } from './providers/types.js'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ai router', () => {
  it('routes to OpenAI and extracts token usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse({
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      ),
    )

    const result = await routeChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(4)
  })

  it('surfaces provider errors as ProviderError with status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(
      routeChat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(ProviderError)
  })
})
