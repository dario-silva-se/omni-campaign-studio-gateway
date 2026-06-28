import type { Scope } from '../db/collections.js'

/**
 * The authenticated caller, resolved from an API key or a JWT. Stored on the
 * Hono context (`c.get('principal')`) and consumed by rate limiting, budget
 * enforcement, telemetry and the proxy handlers.
 */
export interface Principal {
  tenantId: string
  scopes: string[]
  source: 'apiKey' | 'jwt'
  /** Present only for API-key auth. */
  keyId?: string
  /** Per-principal overrides resolved at auth time. */
  rateLimitRps?: number
  budgetUsd?: number
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes('admin') || principal.scopes.includes(scope)
}

/** Usage attached by the AI handler so the telemetry middleware can record cost. */
export interface AiUsage {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** Typed Hono variables shared across middlewares. */
export type GatewayVariables = {
  principal: Principal
  requestId: string
  aiUsage?: AiUsage
}
