#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Shopify Connector — manual curl test suite
# Server: http://localhost:8787
# Run: bash scratch/test-shopify.sh
# ─────────────────────────────────────────────────────────────────────────────

BASE="http://localhost:8787"
EMAIL="test@example.com"
PASSWORD="password123"

sep() { echo; echo "──────────────────────────────────────────"; echo "▶  $1"; echo "──────────────────────────────────────────"; }

# ── 0. Health ──────────────────────────────────────────────────────────────
sep "0. Health check"
curl -s "$BASE/health" | jq .

# ── 1. Login → capture JWT ────────────────────────────────────────────────
sep "1. Login  (POST /api/auth/login)"
LOGIN=$(curl -s -c /tmp/aonex_cookies.txt -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
echo "$LOGIN" | jq .

TOKEN=$(echo "$LOGIN" | jq -r '.data.token // empty')
if [ -z "$TOKEN" ]; then
  echo "❌  Login failed — cannot continue. Check email/password above."
  exit 1
fi
echo "✅  TOKEN captured (${#TOKEN} chars)"

AUTH="Authorization: Bearer $TOKEN"

# ── 2. /me — verify token works ───────────────────────────────────────────
sep "2. GET /api/auth/me"
curl -s "$BASE/api/auth/me" -H "$AUTH" | jq .

# ── 3. List connections (generic Nango flow) ───────────────────────────────
sep "3. GET /api/connections  (list all marketplace connections)"
curl -s "$BASE/api/connections" -H "$AUTH" | jq .

# ── 4. Shopify — create connect session + get OAuth URL ───────────────────
sep "4. POST /api/marketplaces/shopify/connect  (mint Nango session → OAuth URL)"
curl -s -X POST "$BASE/api/marketplaces/shopify/connect" \
  -H "$AUTH" \
  -H "Content-Type: application/json" | jq .

# ── 5. Shopify — callback (fires after OAuth completes) ───────────────────
sep "5. GET /api/marketplaces/shopify/callback  (post-OAuth landing — expects CONNECTION_NOT_FOUND if not yet connected)"
curl -s "$BASE/api/marketplaces/shopify/callback" -H "$AUTH" | jq .

# ── 6. Shopify — list products (direct provider read) ─────────────────────
sep "6. GET /api/marketplaces/shopify/products  (direct ShopifyAdapter read)"
curl -s "$BASE/api/marketplaces/shopify/products" -H "$AUTH" | jq .

# ── 7. Connections — create Nango connect session (generic) ───────────────
sep "7. POST /api/connections  (Nango Connect session for ['shopify'])"
curl -s -X POST "$BASE/api/connections" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"marketplaces":["shopify"]}' | jq .

# ── 8. Delete / revoke connection ─────────────────────────────────────────
sep "8. DELETE /api/connections/shopify  (revoke — expects error if no connection)"
curl -s -X DELETE "$BASE/api/connections/shopify" -H "$AUTH" | jq .

# ── 9. Sync trigger ───────────────────────────────────────────────────────
sep "9. POST /api/sync  (enqueue initial sync — check routes/sync.ts for body shape)"
curl -s -X POST "$BASE/api/sync" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"marketplace":"shopify"}' | jq .

# ── 10. Logout ────────────────────────────────────────────────────────────
sep "10. POST /api/auth/logout"
curl -s -X POST "$BASE/api/auth/logout" -H "$AUTH" | jq .

echo
echo "✅  Done. Review output above for any ❌ errors."
