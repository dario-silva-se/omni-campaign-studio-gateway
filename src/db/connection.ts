import { MongoClient, type Db } from 'mongodb'
import { env } from '../config/env.js'

/**
 * Serverless-safe Mongo connection (same approach as omni-campaign-studio-api).
 *
 * On Vercel each cold start would otherwise open a brand-new client, which under
 * load produces a connection storm against Atlas. We cache the connecting promise
 * on `globalThis` so warm invocations in the same container reuse one pool.
 */
declare global {

  var __gatewayMongoClientPromise: Promise<MongoClient> | undefined
}

function createClientPromise(): Promise<MongoClient> {
  const client = new MongoClient(env.MONGODB_URI, {
    // Keep the pool small — serverless functions are single-flight per instance.
    maxPoolSize: 10,
    // Fail fast when Mongo is unreachable so health checks and requests don't
    // hang on the driver's 30s default server-selection window.
    serverSelectionTimeoutMS: 5000,
  })
  return client.connect()
}

function getClientPromise(): Promise<MongoClient> {
  if (!globalThis.__gatewayMongoClientPromise) {
    globalThis.__gatewayMongoClientPromise = createClientPromise()
  }
  return globalThis.__gatewayMongoClientPromise
}

export async function getClient(): Promise<MongoClient> {
  return getClientPromise()
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise()
  return client.db(env.MONGODB_DB_NAME)
}

/** Close the cached client (used by scripts/tests; no-op in serverless). */
export async function closeDb(): Promise<void> {
  if (globalThis.__gatewayMongoClientPromise) {
    const client = await globalThis.__gatewayMongoClientPromise
    await client.close()
    globalThis.__gatewayMongoClientPromise = undefined
  }
}
