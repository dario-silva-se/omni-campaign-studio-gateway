import { existsSync } from 'node:fs'
import { z } from 'zod'

/**
 * Load variables from a local .env file into process.env, if one exists.
 * Real deployments inject env vars directly (no .env), so this is best-effort:
 * we only load when the file is present. Uses Node's built-in loader — no
 * dotenv dependency required (Node >= 20.6).
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

/** Strip trailing slashes from a base URL so concatenation never yields `//`. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Environment schema. Validated once at module load so a misconfigured deploy
 * fails fast with a clear message instead of throwing deep inside a request.
 * Mirrors the convention used by omni-campaign-studio-api.
 */
const EnvSchema = z.object({
  // Upstream CRUD API we proxy to. Trailing slashes are stripped so that
  // `${UPSTREAM_API_URL}/health` and `UPSTREAM_API_URL + subPath` never double up.
  UPSTREAM_API_URL: z
    .string()
    .url('UPSTREAM_API_URL must be a valid URL')
    .transform(normalizeBaseUrl),

  // Mongo (api keys, telemetry, usage rollups).
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1, 'MONGODB_DB_NAME is required'),

  // Optional Upstash Redis — falls back to in-memory cache + rate limiter.
  UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal('')),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal('')),

  // JWT (end-user tokens). Either a JWKS URL or a shared HS256 secret enables it.
  // JWT_SECRET also signs the access tokens issued by the gateway's own login.
  JWT_JWKS_URL: z.string().url().optional().or(z.literal('')),
  JWT_SECRET: z.string().optional().or(z.literal('')),
  JWT_ISSUER: z.string().optional().or(z.literal('')),
  JWT_AUDIENCE: z.string().optional().or(z.literal('')),

  // Login-issued token lifetimes.
  ACCESS_TOKEN_TTL: z.string().default('30m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Upstream request timeout (ms). Aligns with the frontend axios timeout so a
  // slow upstream fails fast instead of holding the serverless function open.
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // Rate limiting (per principal, 1s sliding window).
  RATELIMIT_RPS: z.coerce.number().int().positive().default(1000),
  RATELIMIT_BURST: z.coerce.number().int().positive().default(2000),

  // Cost control.
  DEFAULT_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(50),

  // Telemetry retention (days) for the request_logs TTL index.
  TELEMETRY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // AI provider keys (BYOK).
  OPENAI_API_KEY: z.string().optional().or(z.literal('')),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal('')),

  // Shared secret injected into upstream requests so the API can reject traffic
  // that does not come through the gateway. Optional (open when unset).
  GATEWAY_SHARED_SECRET: z.string().optional().or(z.literal('')),

  ALLOWED_ORIGINS: z.string().default(''),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

export const env = loadEnv()

/** Origins allowed by CORS. localhost:5173 (Vite dev) is always permitted. */
export const allowedOrigins = Array.from(
  new Set(
    [
      'http://localhost:5173',
      ...env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
    ].filter(Boolean),
  ),
)

/** Whether an Upstash Redis REST cache/rate-limiter is configured. */
export const hasUpstash =
  !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN

/** Whether JWT auth is enabled (a JWKS URL or shared secret is configured). */
export const hasJwt = !!env.JWT_JWKS_URL || !!env.JWT_SECRET
