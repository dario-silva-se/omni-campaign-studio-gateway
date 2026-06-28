# omni-campaign-studio-gateway

Unified **API gateway** in front of
[`omni-campaign-studio-api`](https://github.com/dario-silva-se/omni-campaign-studio-api).
It adds the cross-cutting concerns the API deliberately leaves out (v1 has no
auth): **access control**, **cost control**, **request throttling**,
**telemetry** and **monitoring** — plus an **AI proxy** with per-token cost
accounting (Vercel-AI-Gateway-style) for content-generation workloads.

Built on the same stack as the API for operational consistency: **Hono** +
**TypeScript**, the official **MongoDB** driver, **Upstash Redis** (REST, with an
in-memory fallback), **Zod**-validated env, deployed on **Vercel serverless**.

## What it does

| Concern            | How                                                                           |
| ------------------ | ----------------------------------------------------------------------------- |
| **Access control** | API keys (`gw_…`, scoped) **and** end-user JWTs (JWKS or HS256)               |
| **Throttling**     | Sliding-window rate limit per tenant (Upstash, memory fallback); `429` + headers |
| **Cost control**   | Per-tenant monthly USD budget; AI cost from tokens × price table; `402` when over |
| **Telemetry**      | Structured access logs + per-request records in Mongo (TTL) + monthly rollups  |
| **Monitoring**     | `/_gw/health`, Prometheus/JSON `/_gw/metrics`, per-tenant `/_gw/usage`         |
| **AI proxy**       | OpenAI-compatible endpoint routed to OpenAI/Anthropic (BYOK) with failover     |

## Architecture

```
src/
  config/env.ts          Zod-validated environment (fail-fast at load)
  config/pricing.ts      model price table + costUsd(model, in, out)
  db/connection.ts       MongoClient cached on globalThis (serverless cold-start safe)
  db/collections.ts      typed accessors + index/TTL setup (api_keys, request_logs, usage_monthly)
  cache/redis.ts         Upstash | in-memory KeyStore (get/set/del/incrByFloat)
  auth/apiKey.ts         issue/hash/lookup API keys (SHA-256, cached lookups)
  auth/jwt.ts            JWT verification via JWKS or shared secret (jose)
  auth/middleware.ts     authenticate -> Principal; requireScope(...)
  ratelimit/limiter.ts   Upstash slidingWindow | memory; rateLimit middleware
  cost/budget.ts         monthly spend counters + enforceBudget middleware (402)
  telemetry/{logger,metrics,recorder,middleware}.ts   logs, counters, persistence
  proxy/upstream.ts      reverse proxy to UPSTREAM_API_URL
  ai/providers/*.ts      openai + anthropic adapters (canonical OpenAI shape)
  ai/router.ts           model -> provider routing with failover
  ai/handler.ts          POST /ai/v1/chat/completions (cost-accounted)
  admin/keys.ts          API-key management (admin)
  routes/{health,metrics,usage}.ts
  app.ts                 pipeline: telemetry -> CORS -> auth -> rate limit -> budget -> handler
  server.ts              local dev server (@hono/node-server)
api/index.ts             Vercel entry (hono/vercel)
scripts/seed-keys.ts     create indexes + mint a bootstrap admin key
```

### Request pipeline

`telemetry (request id + latency)` → `CORS` → `authenticate` → `rate limit` →
`budget` → handler (`proxy` / `ai` / control plane). Telemetry runs first so
it also records `401/403/429/402` rejections.

## Surfaces

| Method(s)        | Path                          | Auth / scope      | Purpose                              |
| ---------------- | ----------------------------- | ----------------- | ------------------------------------ |
| GET              | `/_gw/health`                 | public            | upstream + Mongo + Redis liveness    |
| POST             | `/_gw/auth/login`             | public (IP-limited) | email+password → access token + refresh cookie |
| POST             | `/_gw/auth/refresh`           | refresh cookie    | rotate refresh → new access token    |
| POST             | `/_gw/auth/logout`            | refresh cookie    | revoke session + clear cookie        |
| GET              | `/_gw/auth/me`                | any authenticated | current principal (tenant + scopes)  |
| GET              | `/_gw/metrics`                | `admin`           | Prometheus (`?format=json` for JSON) |
| GET              | `/_gw/usage`                  | any authenticated | tenant requests/tokens/cost + budget |
| POST/GET/DELETE  | `/_gw/keys`(`/:id`)           | `admin`           | issue / list / revoke API keys       |
| POST/GET/DELETE  | `/_gw/users`(`/:id`)          | `admin`           | create / list / disable login users  |
| POST             | `/ai/v1/chat/completions`     | `ai:invoke`       | OpenAI-compatible AI proxy           |
| GET/POST/PATCH/DELETE | `/api/*`                 | `api:read`/`api:write` | reverse proxy to the CRUD API   |

**Scopes:** `api:read`, `api:write`, `ai:invoke`, `admin` (implies all).

### Authentication

Two credential types resolve to the same scoped `Principal`:

- **API keys** (`gw_…`) — for server-to-server callers. Issue via `/_gw/keys` or `npm run seed:keys`.
- **User login + JWT** — for the browser. `POST /_gw/auth/login` returns a short-lived HS256 access token
  (sent as `Authorization: Bearer`) and sets an httpOnly **refresh** cookie; `/_gw/auth/refresh` rotates it.
  Create users via `/_gw/users` (admin) or `npm run seed:user`. Requires `JWT_SECRET` to be set.

## Local setup

Requires Node ≥ 20, a MongoDB instance, and the upstream API running.

```bash
npm install
cp .env.example .env        # set UPSTREAM_API_URL, MONGODB_URI/NAME
npm run seed:keys           # create indexes + print a bootstrap admin key
npm run dev                 # http://localhost:8787
```

Smoke checks (replace `<key>` with the seeded key):

```bash
curl localhost:8787/_gw/health
curl localhost:8787/api/campaigns                      # 401 without a key
curl -H "Authorization: Bearer <key>" localhost:8787/api/campaigns   # proxied
curl -H "X-Api-Key: <key>" localhost:8787/_gw/usage
curl -X POST localhost:8787/ai/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Scripts

| Script               | Description                                  |
| -------------------- | -------------------------------------------- |
| `npm run dev`        | Local dev server with watch (tsx)            |
| `npm start`          | Run the server once                          |
| `npm run build`      | `tsc` typecheck-and-emit to `dist/`          |
| `npm run typecheck`  | `tsc --noEmit`                               |
| `npm run lint`       | ESLint                                       |
| `npm test`           | Vitest (Mongo/Redis mocked or in-memory)     |
| `npm run seed:keys`  | Create indexes + mint a bootstrap admin key  |
| `npm run seed:user`  | Create indexes + create a bootstrap admin user |

## Environment

| Variable                     | Required | Default                  | Notes                                   |
| ---------------------------- | -------- | ------------------------ | --------------------------------------- |
| `UPSTREAM_API_URL`           | yes      | —                        | CRUD API base, e.g. `…/api` (trailing slashes stripped) |
| `UPSTREAM_TIMEOUT_MS`        | no       | `15000`                  | Upstream request timeout; exceed → `504` |
| `MONGODB_URI`                | yes      | —                        | Mongo connection string                 |
| `MONGODB_DB_NAME`            | yes      | —                        | Database name                           |
| `UPSTASH_REDIS_REST_URL`     | no       | —                        | Enables Redis cache + rate limit        |
| `UPSTASH_REDIS_REST_TOKEN`   | no       | —                        | Required alongside the URL              |
| `JWT_JWKS_URL` / `JWT_SECRET`| no       | —                        | Enables JWT auth; `JWT_SECRET` also signs login tokens |
| `JWT_ISSUER` / `JWT_AUDIENCE`| no       | —                        | Validated when set                      |
| `ACCESS_TOKEN_TTL`           | no       | `30m`                    | Login access-token lifetime             |
| `REFRESH_TOKEN_TTL_DAYS`     | no       | `7`                      | Refresh-token lifetime (days)           |
| `RATELIMIT_RPS`              | no       | `1000`                   | Per-tenant requests/second              |
| `RATELIMIT_BURST`            | no       | `2000`                   | Reserved for burst tuning               |
| `DEFAULT_MONTHLY_BUDGET_USD` | no       | `50`                     | Per-tenant cap; `0` disables            |
| `TELEMETRY_RETENTION_DAYS`   | no       | `30`                     | TTL for `request_logs`                  |
| `OPENAI_API_KEY`             | no       | —                        | BYOK for the AI proxy                    |
| `ANTHROPIC_API_KEY`          | no       | —                        | BYOK for the AI proxy                    |
| `GATEWAY_SHARED_SECRET`      | no       | —                        | Sent upstream as `x-gateway-secret`; set the same value on the API to block bypass |
| `ALLOWED_ORIGINS`            | no       | —                        | Comma-separated CORS origins — **must include the deployed frontend origin in production** |
| `NODE_ENV`                   | no       | `development`            | `development` / `test` / `production`   |
| `PORT`                       | no       | `8787`                   | Local dev server port                   |

## Deployment (Vercel)

Entry is `api/index.ts` (`hono/vercel`); `vercel.json` rewrites all paths to it.
CI (`.github/workflows/ci.yml`) runs typecheck + lint + test;
`deploy.yml` deploys previews on PRs and production on `main`. Configure project
env vars above, plus GitHub secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID_GATEWAY`.

## Connecting the frontend

Point [`omni-campaign-studio`](https://github.com/dario-silva-se/omni-campaign-studio)
at the gateway instead of the API and send a credential:

```
VITE_API_URL=https://<gateway-deployment>/api
```

Add an API key (`X-Api-Key`/`Authorization`) or a user JWT in the frontend's
`apiClient.ts`. The gateway authenticates, throttles, meters and forwards to
`UPSTREAM_API_URL`. The upstream API is unchanged; optionally it can later be
locked to only accept traffic carrying the gateway's `x-forwarded-by` header.
