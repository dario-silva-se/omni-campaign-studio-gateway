# Deploy na Vercel — omni-campaign-studio-gateway

Topologia de produção: **Frontend → Gateway → API**.
O gateway é o BFF/proxy: autentica, aplica rate-limit/telemetria/budget, serve
`/_gw/auth/*` (login/refresh) e faz proxy de `/api/*` para a API upstream.

## Causas comuns de falha em produção

- **`UPSTREAM_API_URL` ausente ou `localhost`** → o proxy tenta `http://localhost:3000`
  (inalcançável no serverless) e devolve **502**. Defina a URL absoluta da API.
- **`ALLOWED_ORIGINS` sem a origem do frontend** → o browser é **bloqueado por
  CORS** (a origem do frontend de produção precisa estar listada; `localhost:5173`
  já é sempre permitido para dev).
- **`MONGODB_URI` / `MONGODB_DB_NAME` ausentes** → auth/telemetria/usage falham.
  Desde esta mudança, config inválida retorna um JSON claro
  `{"error":"Server misconfigured", ...}` em vez de um `FUNCTION_INVOCATION_FAILED`
  opaco — confira o corpo da resposta de `/_gw/health` para diagnosticar.
- **`NODE_ENV` ≠ `production`** → o cookie de refresh não recebe `Secure`/`SameSite=None`,
  quebrando o refresh cross-site em HTTPS.

## Variáveis a definir na Vercel

| Variável | Valor | Obrigatória |
|---|---|---|
| `UPSTREAM_API_URL` | `https://<api>.vercel.app/api` | **Sim** |
| `ALLOWED_ORIGINS` | `https://<frontend>.vercel.app` | **Sim** (para o browser) |
| `MONGODB_URI` | *connection string do Atlas* | **Sim** |
| `MONGODB_DB_NAME` | `omni_campaign_gateway` | **Sim** |
| `JWT_SECRET` | *segredo HS256* | Sim, se usar login `/_gw/auth` |
| `NODE_ENV` | `production` | Sim |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | *Upstash* | Não (fallback em memória) |
| `GATEWAY_SHARED_SECRET` | *segredo compartilhado* | Não (se usar, IGUAL ao da API) |

Substitua `<api>` e `<frontend>` pelos domínios reais.

## Notas

- MongoDB Atlas precisa permitir o egress da Vercel (Network Access:
  `0.0.0.0/0` ou os IPs de egress da Vercel).
- `GATEWAY_SHARED_SECRET`: para travar a API a tráfego que só vem pelo gateway,
  defina-o **primeiro aqui**, depois na API, para não derrubar tráfego no rollout.

## Verificação pós-deploy

`GET https://<gateway>.vercel.app/_gw/health` deve responder OK. Se vier
`Server misconfigured`, o corpo lista exatamente qual variável está faltando.
