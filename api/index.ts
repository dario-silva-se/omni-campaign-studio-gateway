import { getRequestListener } from '@hono/node-server'
import { app } from '../src/app.js'

export const config = {
  runtime: 'nodejs',
}

/**
 * Vercel serverless entrypoint (Node.js runtime).
 *
 * NOTE: do NOT use `handle` from `hono/vercel` here — that adapter targets the
 * Edge runtime, where the incoming `req` is a Web `Request`. On the Node runtime
 * Vercel invokes the function with a Node `IncomingMessage`, whose `.headers` is
 * a plain object with no `.get()`. Passing it straight to `app.fetch` throws
 * `this.raw.headers.get is not a function` on the first `c.req.header(...)` call,
 * and because that adapter returns a Web `Response` without ever writing the Node
 * `res`, the invocation hangs until Vercel's max-duration limit (a 504 on every
 * route). `getRequestListener` bridges the Node req/res to `app.fetch` correctly.
 */
export default getRequestListener(app.fetch)
