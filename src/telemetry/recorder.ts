import { randomUUID } from 'node:crypto'
import {
  currentYyyymm,
  requestLogsCollection,
  usageMonthlyCollection,
  type RequestLogDoc,
} from '../db/collections.js'
import { record as recordMetric } from './metrics.js'
import { log } from './logger.js'
import { runBackground } from './background.js'
import { env } from '../config/env.js'

export interface RequestRecord {
  requestId: string
  tenantId: string
  keyId?: string
  source: 'apiKey' | 'jwt'
  method: string
  path: string
  kind: 'proxy' | 'ai' | 'control'
  status: number
  latencyMs: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

/**
 * Record one handled request: update in-process metrics synchronously, then
 * persist the per-request log and bump the durable monthly rollup. Persistence
 * is fire-and-forget so telemetry never adds latency to (or fails) the response.
 */
export function recordRequest(entry: RequestRecord): void {
  recordMetric({
    status: entry.status,
    kind: entry.kind,
    latencyMs: entry.latencyMs,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    costUsd: entry.costUsd,
  })

  // Always emit a structured access-log line.
  log.info('request', { ...entry })

  // Skip durable persistence under tests (no Mongo available).
  if (env.NODE_ENV === 'test') return

  // Persist out of band. On serverless this MUST be registered as background work
  // (see runBackground) — a bare detached promise blocks the response until Mongo
  // settles, which a slow/unreachable Mongo never does, yielding a 504 on every
  // request instead of a quietly-dropped log line.
  runBackground(
    persist(entry).catch((err) => {
      log.warn('telemetry persist failed', { error: (err as Error).message })
    }),
  )
}

async function persist(entry: RequestRecord): Promise<void> {
  const doc: RequestLogDoc = {
    _id: randomUUID(),
    requestId: entry.requestId,
    tenantId: entry.tenantId,
    keyId: entry.keyId,
    source: entry.source,
    method: entry.method,
    path: entry.path,
    kind: entry.kind,
    status: entry.status,
    latencyMs: entry.latencyMs,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    costUsd: entry.costUsd,
    createdAt: new Date(),
  }

  const [logs, usage] = await Promise.all([
    requestLogsCollection(),
    usageMonthlyCollection(),
  ])

  const yyyymm = currentYyyymm()
  await Promise.all([
    logs.insertOne(doc),
    usage.updateOne(
      { _id: `${entry.tenantId}:${yyyymm}` },
      {
        $setOnInsert: { tenantId: entry.tenantId, yyyymm },
        $set: { updatedAt: new Date().toISOString() },
        $inc: {
          requests: 1,
          inputTokens: entry.inputTokens ?? 0,
          outputTokens: entry.outputTokens ?? 0,
          costUsd: entry.costUsd ?? 0,
        },
      },
      { upsert: true },
    ),
  ])
}
