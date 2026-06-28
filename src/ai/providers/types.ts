/** Normalized chat request (OpenAI chat-completions shape, the lingua franca). */
export interface ChatRequest {
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  max_tokens?: number
  temperature?: number
}

/** Normalized chat result returned to the caller, plus token usage for billing. */
export interface ChatResult {
  /** OpenAI-compatible response body returned verbatim to the client. */
  body: unknown
  usage: { inputTokens: number; outputTokens: number }
}

export interface ChatProvider {
  readonly name: 'openai' | 'anthropic'
  /** Whether a credential is configured (BYOK). */
  isConfigured(): boolean
  chat(request: ChatRequest): Promise<ChatResult>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
