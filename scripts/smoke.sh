#!/usr/bin/env bash
#
# End-to-end smoke test for omni-campaign-studio-gateway.
# Drives: health → admin auth → create user → user login → proxied /api call →
# AI completion → usage → refresh → logout.
#
# Requires: curl, jq.
#
# Usage:
#   BASE=https://omni-campaign-studio-gateway.vercel.app \
#   ADMIN_EMAIL=admin@exemplo.com ADMIN_PASSWORD='senhaForte' \
#   ./scripts/smoke.sh
#
# Auth for admin step — provide ONE of:
#   ADMIN_KEY=gw_...                      # an admin API key (from seed:keys), OR
#   ADMIN_EMAIL=... ADMIN_PASSWORD=...    # an admin user (from seed:user)
#
# Optional overrides:
#   NEW_EMAIL (default maria@exemplo.com)  NEW_PASSWORD (default umaSenhaForte123)
#   TENANT (default acme)                  MODEL (default gpt-4o-mini)
set -u

BASE="${BASE:-http://localhost:8787}"
NEW_EMAIL="${NEW_EMAIL:-maria@exemplo.com}"
NEW_PASSWORD="${NEW_PASSWORD:-umaSenhaForte123}"
TENANT="${TENANT:-acme}"
MODEL="${MODEL:-gpt-4o-mini}"
COOKIES="$(mktemp)"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

bold() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
# req METHOD PATH [data] [extra curl args...] -> prints "HTTP <code>" then body
req() {
  local method="$1" path="$2" data="${3:-}"; shift 3 || shift $#
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}" "$@"
}
last_line() { tail -n1; }
drop_last() { sed '$d'; }

bold "1) Health"
out="$(req GET /_gw/health)"; echo "HTTP $(echo "$out" | last_line)"; echo "$out" | drop_last | jq . 2>/dev/null || true

bold "2) Admin token"
if [ -n "${ADMIN_KEY:-}" ]; then
  ADMIN="$ADMIN_KEY"; echo "using ADMIN_KEY"
elif [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  resp="$(req POST /_gw/auth/login "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')")"
  echo "HTTP $(echo "$resp" | last_line)"
  ADMIN="$(echo "$resp" | drop_last | jq -r '.accessToken // empty')"
  [ -n "$ADMIN" ] || { echo "admin login failed"; exit 1; }
  echo "admin login ok"
else
  echo "Provide ADMIN_KEY or ADMIN_EMAIL+ADMIN_PASSWORD"; exit 1
fi

bold "3) Create user $NEW_EMAIL (tolerates 409)"
body="$(jq -nc --arg e "$NEW_EMAIL" --arg p "$NEW_PASSWORD" --arg t "$TENANT" \
  '{email:$e,password:$p,tenantId:$t,scopes:["api:read","api:write","ai:invoke"]}')"
out="$(req POST /_gw/users "$body" -H "Authorization: Bearer $ADMIN")"
echo "HTTP $(echo "$out" | last_line)"; echo "$out" | drop_last | jq . 2>/dev/null || true

bold "4) Login as $NEW_EMAIL (saves refresh cookie)"
resp="$(curl -s -w $'\n%{http_code}' -c "$COOKIES" -X POST "$BASE/_gw/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg e "$NEW_EMAIL" --arg p "$NEW_PASSWORD" '{email:$e,password:$p}')")"
echo "HTTP $(echo "$resp" | last_line)"
TOKEN="$(echo "$resp" | drop_last | jq -r '.accessToken // empty')"
[ -n "$TOKEN" ] || { echo "user login failed"; exit 1; }
echo "user login ok"

bold "5) Proxied CRUD call: GET /api/campaigns"
out="$(req GET /api/campaigns "" -H "Authorization: Bearer $TOKEN")"
echo "HTTP $(echo "$out" | last_line)"; echo "$out" | drop_last | jq 'if type=="array" then length else . end' 2>/dev/null || true

bold "6) AI completion: POST /ai/v1/chat/completions ($MODEL)"
ai="$(jq -nc --arg m "$MODEL" '{model:$m,max_tokens:120,temperature:0.7,messages:[
  {role:"system",content:"Você é um redator de marketing B2B."},
  {role:"user",content:"Escreva 1 headline para uma campanha no LinkedIn sobre IA."}]}')"
out="$(req POST /ai/v1/chat/completions "$ai" -H "Authorization: Bearer $TOKEN")"
echo "HTTP $(echo "$out" | last_line)"
echo "$out" | drop_last | jq '{content:.choices[0].message.content, usage}' 2>/dev/null || echo "$out" | drop_last

bold "7) Usage / cost"
out="$(req GET /_gw/usage "" -H "Authorization: Bearer $TOKEN")"
echo "HTTP $(echo "$out" | last_line)"; echo "$out" | drop_last | jq . 2>/dev/null || true

bold "8) Refresh (rotates cookie) then logout"
out="$(curl -s -w $'\n%{http_code}' -b "$COOKIES" -c "$COOKIES" -X POST "$BASE/_gw/auth/refresh")"
echo "refresh HTTP $(echo "$out" | last_line)"
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST "$BASE/_gw/auth/logout")"
echo "logout HTTP $code"

rm -f "$COOKIES"
bold "done"
