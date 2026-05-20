# apps/api

Hono HTTP API server for Aonex. Handles JWT authentication, webhook ingestion, and all client-facing routes. Runs on Bun.

## Running locally

```bash
# From repo root — recommended (runs api + worker together)
bun run dev

# Api only
cd apps/api
bun run dev        # --hot reload, reads ../../.env
bun run start      # production-style, no hot reload
```

Default port: `8787` (set `PORT=` in `.env` to override).

## Route list

### Public (no auth)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe (checks Postgres + Redis) |
| GET | `/api/system/health` | Full system health detail |
| GET | `/ui` | Swagger / OpenAPI UI |

### Auth — `/api/auth`

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/signup` | Create account (email + password) |
| POST | `/api/auth/login` | Email/password login → sets JWT cookie |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/auth/me` | Return current user |
| POST | `/api/auth/logout` | Clear session cookie |
| GET | `/api/auth/google` | Start Google OAuth flow (optional, see env) |
| GET | `/api/auth/google/callback` | Google OAuth redirect handler |
| POST | `/api/auth/google/complete` | Complete Google OAuth with pending token |

### Webhooks — `/webhooks` (HMAC-protected, not JWT-protected)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/webhooks/nango` | Nango event webhook — queues `nango.auth` / `nango.sync` jobs |

### Connections — `/api/connections` (JWT required)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/connections` | Open Nango Connect handshake for a marketplace |
| GET | `/api/connections` | List merchant's active connections |
| DELETE | `/api/connections/:marketplace` | Disconnect a marketplace |

### Sync — `/api/sync` (JWT required)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/sync/trigger` | Manually trigger a Nango sync for a connection |

### Shopify — `/api/marketplaces/shopify` (JWT required)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/marketplaces/shopify/connect` | Start Shopify OAuth connect flow |
| GET | `/api/marketplaces/shopify/callback` | Shopify OAuth callback |
| GET | `/api/marketplaces/shopify/products` | List Shopify products via Nango proxy |

### Ingestions — `/api/ingestions` (JWT required)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/ingestions/link` | Submit a single product URL for ingestion |
| POST | `/api/ingestions/link/batch` | Submit multiple URLs for ingestion |
| GET | `/api/ingestions/recent` | List recent ingestion runs for merchant |
| GET | `/api/ingestions/:id/trace` | Full trace for a single ingestion run |

### Review — `/api/review` (JWT required)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/review/tasks` | List pending review tasks |
| GET | `/api/review/clusters` | List review clusters (grouped by similarity) |
| GET | `/api/review/clusters/:cluster_key/items` | Items within a cluster |
| POST | `/api/review/clusters/:cluster_key/resolve` | Resolve a review cluster |
| PATCH | `/api/review/tasks/:id` | Update a review task (partial) |
| POST | `/api/review/tasks/:id/edit-and-approve` | Edit extracted fields then approve |
| POST | `/api/review/tasks/:id/reject` | Reject a review task |
| POST | `/api/review/tasks/:id/merge` | Merge approved task into catalog |
| GET | `/api/review/tasks/:id/evidence` | Fetch source evidence for a task |

### Catalog — `/api/catalog` (JWT required)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/catalog/products` | List catalog products |
| DELETE | `/api/catalog/products/:id` | Delete a catalog product |
| GET | `/api/catalog/products/:id/provenance` | Ingestion provenance for a product |
| GET | `/api/catalog/products/:id/sku` | SKU data for a product |

## Key env vars

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection URL |
| `REDIS_URL` | yes | — | Redis connection URL |
| `JWT_SECRET` | yes | — | HS256 secret, min 32 chars |
| `NANGO_SECRET_KEY` | yes | — | Nango API secret key |
| `NANGO_WEBHOOK_SECRET` | yes | — | Nango webhook HMAC secret |
| `NANGO_HOST` | no | `https://api.nango.dev` | Override for self-hosted Nango |
| `NANGO_CONNECT_BASE_URL` | no | `https://connect.nango.dev` | Nango Connect UI base URL |
| `TOKEN_ENCRYPTION_KEY` | yes | — | 64-char lowercase hex (AES-256-GCM) |
| `PORT` | no | `8787` | HTTP listen port |
| `GOOGLE_CLIENT_ID` | no | — | If set, Google OAuth routes are mounted |
| `GOOGLE_CLIENT_SECRET` | no | — | Required with `GOOGLE_CLIENT_ID` |
| `GOOGLE_REDIRECT_URI` | no | — | Required with `GOOGLE_CLIENT_ID` |
| `FRONTEND_URL` | no | `http://localhost:3000` | Used for Google OAuth redirect |
| `LOG_LEVEL` | no | `info` | pino log level |
| `NODE_ENV` | no | `development` | Controls CORS policy and cookie `Secure` flag |

See `packages/types/src/env.ts` for the full Zod schema.

## Architecture

The API follows the **Composition Root** pattern (Seemann): `src/composition-root.ts` is the only file that instantiates concrete infrastructure (Postgres pool, Redis, BullMQ queues, Nango client) and wires everything together. No other file does `new Pool(...)` or `new IORedis(...)`.

```
src/
├── composition-root.ts   Single wiring point — instantiates infra, builds Hono app
├── index.ts              Entry point — calls buildContainerFromEnv(), starts server
├── routes/               HTTP contract layer — Hono route definitions, input parsing, response shaping
├── handlers/             Business logic layer — pure functions called by routes, extracted from route files
├── middleware/           auth.ts, error.ts, logger.ts, request-id.ts
├── services/             Thin domain services (e.g. JwtService)
└── queues/               Queue helper utilities
```

**Request flow:** `middleware → route (parse + validate input) → handler (business logic) → response`

The public routes (`/healthz`, `/ui`, `/api/auth`, `/webhooks/nango`) are mounted directly on the root Hono app. All other routes are mounted on a `protectedApp` sub-app that runs `authMiddleware` first.
