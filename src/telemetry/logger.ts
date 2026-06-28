import { env } from '../config/env.js'

/**
 * Minimal structured logger. Emits one JSON line per event so logs are
 * machine-parseable by Vercel/CloudWatch/Datadog without a heavy dependency.
 * In tests we stay quiet to keep output readable.
 */
type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (env.NODE_ENV === 'test') return
  const line = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    message,
    ...fields,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
}
