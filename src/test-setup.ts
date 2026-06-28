/**
 * Minimal environment for the test runner. Set before any module that imports
 * `config/env.ts` is evaluated, so Zod validation passes without a real .env.
 * Mongo and Redis are always mocked/in-memory in tests.
 */
process.env.UPSTREAM_API_URL ??= 'http://localhost:3000/api'
process.env.MONGODB_URI ??= 'mongodb://localhost:27017'
process.env.MONGODB_DB_NAME ??= 'omni_campaign_gateway_test'
process.env.NODE_ENV = 'test'
// A fake provider key so the AI router treats OpenAI as configured; the actual
// network call is stubbed in tests.
process.env.OPENAI_API_KEY ??= 'sk-test-openai'
// Leave UPSTASH_* unset so the in-memory cache + rate limiter are used.
