/**
 * Lightweight in-process metrics for the `/metrics` endpoint. Counters are
 * per-instance and reset on cold start — adequate for a Prometheus scrape of a
 * warm instance and for local monitoring. Durable, cross-instance cost/usage
 * lives in the `usage_monthly` Mongo rollup (see telemetry/recorder + routes/usage).
 */
interface Counters {
  requestsTotal: number
  byStatusClass: Record<string, number>
  byKind: Record<string, number>
  errorsTotal: number
  rateLimitedTotal: number
  budgetBlockedTotal: number
  aiTokensInputTotal: number
  aiTokensOutputTotal: number
  aiCostUsdTotal: number
  latencyMsSum: number
  latencyCount: number
}

const counters: Counters = {
  requestsTotal: 0,
  byStatusClass: {},
  byKind: {},
  errorsTotal: 0,
  rateLimitedTotal: 0,
  budgetBlockedTotal: 0,
  aiTokensInputTotal: 0,
  aiTokensOutputTotal: 0,
  aiCostUsdTotal: 0,
  latencyMsSum: 0,
  latencyCount: 0,
}

export interface MetricSample {
  status: number
  kind: string
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export function record(sample: MetricSample): void {
  counters.requestsTotal += 1
  const cls = `${Math.floor(sample.status / 100)}xx`
  counters.byStatusClass[cls] = (counters.byStatusClass[cls] ?? 0) + 1
  counters.byKind[sample.kind] = (counters.byKind[sample.kind] ?? 0) + 1
  if (sample.status >= 500) counters.errorsTotal += 1
  if (sample.status === 429) counters.rateLimitedTotal += 1
  if (sample.status === 402) counters.budgetBlockedTotal += 1
  counters.aiTokensInputTotal += sample.inputTokens ?? 0
  counters.aiTokensOutputTotal += sample.outputTokens ?? 0
  counters.aiCostUsdTotal += sample.costUsd ?? 0
  counters.latencyMsSum += sample.latencyMs
  counters.latencyCount += 1
}

export function snapshot(): Counters & { latencyMsAvg: number } {
  return {
    ...counters,
    latencyMsAvg: counters.latencyCount
      ? counters.latencyMsSum / counters.latencyCount
      : 0,
  }
}

/** Render counters in Prometheus text exposition format. */
export function renderPrometheus(): string {
  const lines: string[] = []
  const m = (name: string, value: number, help: string, type = 'counter') => {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} ${type}`)
    lines.push(`${name} ${value}`)
  }
  m('gateway_requests_total', counters.requestsTotal, 'Total requests handled')
  for (const [cls, n] of Object.entries(counters.byStatusClass)) {
    lines.push(`gateway_requests_by_status{class="${cls}"} ${n}`)
  }
  for (const [kind, n] of Object.entries(counters.byKind)) {
    lines.push(`gateway_requests_by_kind{kind="${kind}"} ${n}`)
  }
  m('gateway_errors_total', counters.errorsTotal, 'Requests with 5xx status')
  m('gateway_rate_limited_total', counters.rateLimitedTotal, 'Requests rejected with 429')
  m('gateway_budget_blocked_total', counters.budgetBlockedTotal, 'Requests rejected with 402')
  m('gateway_ai_tokens_input_total', counters.aiTokensInputTotal, 'AI input tokens consumed')
  m('gateway_ai_tokens_output_total', counters.aiTokensOutputTotal, 'AI output tokens consumed')
  m('gateway_ai_cost_usd_total', counters.aiCostUsdTotal, 'AI cost in USD')
  m(
    'gateway_request_latency_ms_avg',
    counters.latencyCount ? counters.latencyMsSum / counters.latencyCount : 0,
    'Average request latency (ms)',
    'gauge',
  )
  return lines.join('\n') + '\n'
}

/** Reset counters — test helper. */
export function resetMetrics(): void {
  Object.assign(counters, {
    requestsTotal: 0,
    byStatusClass: {},
    byKind: {},
    errorsTotal: 0,
    rateLimitedTotal: 0,
    budgetBlockedTotal: 0,
    aiTokensInputTotal: 0,
    aiTokensOutputTotal: 0,
    aiCostUsdTotal: 0,
    latencyMsSum: 0,
    latencyCount: 0,
  })
}
