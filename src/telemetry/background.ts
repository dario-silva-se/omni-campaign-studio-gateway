/**
 * Register fire-and-forget work so it does not hold a serverless invocation open.
 *
 * On Vercel, a merely-detached background promise (`void p`) keeps the function's
 * event loop busy, so the platform blocks the response until that work settles —
 * and the Mongo driver's background topology monitors never let it settle, so the
 * invocation is killed at the max-duration limit and the client sees a 504. The
 * runtime exposes a `waitUntil` through a global request-context symbol (the same
 * one `@vercel/functions` wraps); handing the promise to it lets Vercel flush the
 * response immediately and keep compute alive only until the work itself settles.
 *
 * Off Vercel — the local long-running `src/server.ts`, tests — there is no such
 * context, so we fall back to a detached promise. That is harmless on a
 * persistent process where the response was already written to the open socket.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')

interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

type ContextHolder = { get?: () => VercelRequestContext | undefined } | undefined

export function runBackground(promise: Promise<unknown>): void {
  const holder = (globalThis as Record<symbol, ContextHolder>)[REQUEST_CONTEXT]
  const waitUntil = holder?.get?.()?.waitUntil
  if (waitUntil) {
    waitUntil(promise)
  } else {
    void promise
  }
}
