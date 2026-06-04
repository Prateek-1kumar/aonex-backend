// Serves the hand-maintained OpenAPI 3.0 spec and Swagger UI.
//
// GET /ui/doc returns the spec JSON; GET /ui renders the interactive docs. The
// spec is authored inline here (not generated) — keep it in sync with the routes.

import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';

export function swaggerRoutes(): Hono {
  const app = new Hono();

  const openApiSpec = {
    openapi: '3.0.0',
    info: {
      title: 'Aonex API',
      version: '1.0.0',
      description: `## Quick Start
1. Call **POST /api/auth/login** with \`dev@example.com\` / \`dev@123\`
2. Copy the \`token\` from the response
3. Click **Authorize 🔒** → paste the token → click **Authorize**
4. All protected endpoints will now use your token automatically

## Multi-tenant Isolation
Every JWT encodes a \`merchantId\`. All protected endpoints derive the merchant identity
**exclusively from the JWT** — never from request body. This means:
- Merchant A's token can only access Merchant A's Shopify store, connections, and products
- Merchant B's token can only access Merchant B's data
- No cross-merchant data leakage is possible`,
    },
    servers: [{ url: 'http://localhost:8787' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token from POST /api/auth/login or /api/auth/signup',
        },
      },
    },
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      { name: 'Auth', description: 'Signup, login, refresh, logout, and Google OAuth' },
      { name: 'Connections', description: 'Marketplace connection lifecycle (Nango generic flow)' },
      { name: 'Shopify', description: 'Shopify-specific OAuth connect, callback, products' },
      { name: 'eBay', description: 'eBay OAuth connect, callback, and live inventory/orders/offers reads' },
      { name: 'Sync', description: 'Manual product sync trigger' },
      { name: 'Ingestions', description: 'Product extraction from URLs and CSV uploads' },
      { name: 'Catalog', description: 'Canonical catalog product reads, soft-delete, provenance, and trace' },
      { name: 'Review', description: 'Reviewer workflow — review tasks and clusters' },
      { name: 'Anomaly Lab', description: 'Staged-product review queue and approve/reject/link actions' },
      { name: 'Webhooks', description: 'Nango webhook receiver (HMAC-protected, not JWT)' },
    ],
    paths: {

      // ── Health ────────────────────────────────────────────────────────────
      '/healthz': {
        get: {
          summary: 'Liveness check',
          tags: ['Health'],
          responses: {
            200: {
              description: 'Server is alive',
              content: { 'application/json': { example: { ok: true } } },
            },
          },
        },
      },
      '/readyz': {
        get: {
          summary: 'Readiness check — verifies Postgres + Redis connectivity',
          tags: ['Health'],
          responses: {
            200: {
              description: 'All dependencies healthy',
              content: { 'application/json': { example: { ok: true } } },
            },
            503: {
              description: 'A dependency is down',
              content: { 'application/json': { example: { ok: false, error: 'connection refused' } } },
            },
          },
        },
      },

      // ── Auth ──────────────────────────────────────────────────────────────
      '/api/auth/signup': {
        post: {
          summary: 'Register a new merchant + tenant',
          description: 'Creates a new tenant and merchant in one transaction. Returns a JWT immediately.',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password', 'displayName', 'tenantName'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'merchant@mystore.com' },
                    password: { type: 'string', minLength: 8, example: 'MyPass123' },
                    displayName: { type: 'string', example: 'My Store Name' },
                    tenantName: { type: 'string', example: 'Acme Corp' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Merchant created — copy the token for Authorize',
              content: {
                'application/json': {
                  example: {
                    data: { token: 'eyJhbGciOiJIUzI1NiJ9...', expiresAt: '2026-05-13T05:00:00.000Z' },
                  },
                },
              },
            },
            409: { description: 'Email already registered' },
            400: { description: 'Validation error' },
          },
        },
      },

      '/api/auth/login': {
        post: {
          summary: 'Login — returns JWT token',
          description: '**Step 1**: Call this, then click Authorize 🔒 and paste the token.',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@example.com' },
                    password: { type: 'string', example: 'dev@123' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Login success',
              content: {
                'application/json': {
                  example: {
                    data: { token: 'eyJhbGciOiJIUzI1NiJ9...', expiresAt: '2026-05-13T05:00:00.000Z' },
                  },
                },
              },
            },
            401: { description: 'Invalid credentials' },
          },
        },
      },

      '/api/auth/me': {
        get: {
          summary: 'Get the currently logged-in merchant profile',
          tags: ['Auth'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Merchant profile',
              content: {
                'application/json': {
                  example: {
                    data: {
                      id: 'e4decda9-49db-45d2-9af0-b166b13d72f6',
                      email: 'dev@example.com',
                      displayName: 'Dev User',
                      role: 'operator',
                      tenantName: 'Dev Tenant',
                    },
                  },
                },
              },
            },
            401: { description: 'Missing or invalid token' },
          },
        },
      },

      '/api/auth/refresh': {
        post: {
          summary: 'Refresh JWT — rotate to a new token (old one is revoked)',
          tags: ['Auth'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'New token issued',
              content: {
                'application/json': {
                  example: {
                    data: { token: 'eyJhbGciOiJIUzI1NiJ9...NEW...', expiresAt: '2026-05-13T06:00:00.000Z' },
                  },
                },
              },
            },
            401: { description: 'Session expired or revoked' },
          },
        },
      },

      '/api/auth/logout': {
        post: {
          summary: 'Logout — revoke current session',
          tags: ['Auth'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Session revoked',
              content: { 'application/json': { example: { data: { ok: true } } } },
            },
          },
        },
      },

      // ── Connections ───────────────────────────────────────────────────────
      '/api/connections': {
        get: {
          summary: 'List all marketplace connections for this merchant',
          description: '**Isolated per merchant** — returns only the calling merchant\'s connections.',
          tags: ['Connections'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Connection list',
              content: {
                'application/json': {
                  example: {
                    data: [
                      {
                        marketplace: 'shopify',
                        status: 'active',
                        scopes: ['read_products', 'write_products'],
                        connectedAt: '2026-05-11T07:47:25.000Z',
                        lastTokenRefreshAt: '2026-05-13T02:00:00.000Z',
                      },
                    ],
                  },
                },
              },
            },
            401: { description: 'Unauthenticated' },
          },
        },
        post: {
          summary: 'Create a Nango Connect session (generic flow for frontend Connect UI)',
          description: `Creates an opaque session token. The frontend opens the Nango Connect UI
with this token, the merchant completes OAuth there, and the token is then stored
securely in Nango. Use **POST /api/marketplaces/shopify/connect** instead for a direct OAuth URL.`,
          tags: ['Connections'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['marketplaces'],
                  properties: {
                    marketplaces: {
                      type: 'array',
                      items: { type: 'string', enum: ['shopify'] },
                      example: ['shopify'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Nango Connect session token',
              content: {
                'application/json': {
                  example: {
                    data: {
                      token: 'nango_connect_session_bccf45fc28912675...',
                      expiresAt: '2026-05-13T03:45:00.000Z',
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      '/api/connections/{marketplace}': {
        delete: {
          summary: 'Revoke a marketplace connection (idempotent)',
          description: '**Merchant-isolated** — can only revoke your own connection.',
          tags: ['Connections'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'marketplace',
              in: 'path',
              required: true,
              description: 'The marketplace to disconnect',
              schema: { type: 'string', enum: ['shopify'] },
            },
          ],
          responses: {
            200: {
              description: 'Connection revoked',
              content: { 'application/json': { example: { data: { ok: true } } } },
            },
            400: { description: 'Invalid marketplace name' },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      // ── Shopify ───────────────────────────────────────────────────────────
      '/api/marketplaces/shopify/connect': {
        post: {
          summary: 'Get Shopify OAuth URL — open in browser to authorize your store',
          description: `Creates a Nango Connect session scoped to Shopify and returns the OAuth redirect URL.
**Each merchant gets a unique URL** — determined by the \`merchantId\` in the JWT.
Open the URL in a browser to complete the Shopify OAuth flow.`,
          tags: ['Shopify'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'OAuth URL (valid for ~10 minutes)',
              content: {
                'application/json': {
                  example: {
                    data: {
                      url: 'https://connect.nango.dev?session_token=nango_connect_session_abc123...',
                      expiresAt: '2026-05-13T03:15:04.000Z',
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      '/api/marketplaces/shopify/callback': {
        get: {
          summary: 'Post-OAuth callback — confirms connection and enqueues initial product sync',
          description: `Call this after the merchant completes Shopify OAuth.
Checks if the connection exists in Nango, then enqueues an initial product sync job.
Returns 404 if OAuth has not been completed yet.`,
          tags: ['Shopify'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Connection confirmed, sync enqueued',
              content: {
                'application/json': {
                  example: { data: { status: 'active', marketplace: 'shopify' } },
                },
              },
            },
            404: { description: 'No Shopify connection found (OAuth not completed)' },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      '/api/marketplaces/shopify/products': {
        get: {
          summary: 'List products from the connected Shopify store (live read)',
          description: `Direct provider-native read via Nango proxy.
**Merchant-isolated** — only returns products from the calling merchant's Shopify store.
Returns up to 50 products (Shopify default page size).`,
          tags: ['Shopify'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Array of Shopify products with full raw payload',
              content: {
                'application/json': {
                  example: {
                    data: [
                      {
                        externalId: '8238678966338',
                        raw: {
                          id: 8238678966338,
                          title: 'Gift Card',
                          status: 'active',
                          vendor: 'aonex-test',
                          product_type: 'gift_card',
                          variants: [{ id: 123, price: '10.00', inventory_quantity: 0 }],
                          images: [],
                        },
                      },
                    ],
                  },
                },
              },
            },
            401: { description: 'Unauthenticated' },
            500: { description: 'No active Shopify connection for this merchant, or Shopify API error' },
          },
        },
      },

      // ── Sync ──────────────────────────────────────────────────────────────
      '/api/sync/trigger': {
        post: {
          summary: 'Manually trigger a product sync from Shopify → Aonex catalog',
          description: `Enqueues a BullMQ sync job with high priority (jumps the queue).
The worker will drain all products from Nango cache into \`source_artifacts\`.
One in-flight sync per (merchant, marketplace) — duplicates are deduped by jobId.`,
          tags: ['Sync'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['marketplace'],
                  properties: {
                    marketplace: {
                      type: 'string',
                      enum: ['shopify'],
                      example: 'shopify',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Sync job enqueued',
              content: { 'application/json': { example: { data: { ok: true } } } },
            },
            401: { description: 'Unauthenticated' },
            400: { description: 'Invalid marketplace' },
          },
        },
      },

      // ── Ingestions ────────────────────────────────────────────────────────
      '/api/ingestions/link': {
        post: {
          summary: 'Submit a product URL for LLM-based extraction (async)',
          description: `Fetches the URL, runs extraction to pull product facts, maps them to Aonex canonical schema, then creates either an approved catalog version or an Anomaly Lab review task.
Returns 202 immediately — extraction happens asynchronously via BullMQ.`,
          tags: ['Ingestions'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: {
                      type: 'string',
                      format: 'uri',
                      example: 'https://www.example.com/products/my-product',
                    },
                    category_hint: {
                      type: 'string',
                      maxLength: 200,
                      example: 'snowboard',
                      description: 'Optional hint to guide LLM extraction',
                    },
                  },
                },
              },
            },
          },
          responses: {
            202: {
              description: 'URL accepted — extraction in progress',
              content: {
                'application/json': {
                  example: {
                    success: true,
                    data: {
                      ingestion_id: 'job-abc123',
                      trace_id: 'uuid-...',
                      url: 'https://www.example.com/products/my-product',
                      status: 'accepted',
                      message: 'URL accepted. Extraction will continue asynchronously.',
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid URL or validation error' },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      '/api/ingestions/link/batch': {
        post: {
          summary: 'Submit up to 20 URLs for batch extraction (async)',
          description: 'Same as single URL ingestion but accepts an array of up to 20 URLs at once.',
          tags: ['Ingestions'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['urls'],
                  properties: {
                    urls: {
                      type: 'array',
                      items: { type: 'string', format: 'uri' },
                      minItems: 1,
                      maxItems: 20,
                      example: [
                        'https://www.example.com/products/product-1',
                        'https://www.example.com/products/product-2',
                      ],
                    },
                    category_hint: {
                      type: 'string',
                      maxLength: 200,
                      example: 'snowboard',
                    },
                  },
                },
              },
            },
          },
          responses: {
            202: {
              description: 'All URLs accepted',
              content: {
                'application/json': {
                  example: {
                    success: true,
                    data: {
                      batch_id: 'uuid-...',
                      status: 'accepted',
                      total: 2,
                      jobs: [
                        { ingestion_id: 'job-1', trace_id: 'uuid-1', url: 'https://...', status: 'accepted' },
                        { ingestion_id: 'job-2', trace_id: 'uuid-2', url: 'https://...', status: 'accepted' },
                      ],
                      message: '2 URL(s) accepted. Extraction will continue asynchronously.',
                    },
                  },
                },
              },
            },
            400: { description: 'Validation error (invalid URL, more than 20 items, etc.)' },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      '/api/ingestions/recent': {
        get: {
          summary: 'List recent ingestions for this merchant',
          description: 'Returns recent link/CSV ingestions for the authenticated merchant. Use this to find artifact_id values, then call GET /api/ingestions/{id}/trace to view the extracted payload.',
          tags: ['Ingestions'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Number of ingestions to return (1-100, default 20)',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            200: {
              description: 'Recent ingestions list',
              content: {
                'application/json': {
                  example: {
                    data: {
                      ingestions: [
                        {
                          artifact_id: '6c8d5a0f-5f3d-4928-bf8b-5a88eb1c2d9f',
                          source_type: 'link_url',
                          source_external_id: 'https://www.example.com/products/my-product',
                          status: 'completed',
                          received_at: '2026-06-01T06:50:00.000Z',
                          checksum: 'sha256:...',
                          fact_count: 38,
                          extractor_version: 'v1.2.3',
                          error_count: 0,
                        },
                      ],
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthenticated' },
          },
        },
      },

      '/api/ingestions/{id}/trace': {
        get: {
          summary: 'Get full ingestion trace and extracted product JSON',
          description: 'Returns stage events plus the reconstructed extracted product JSON at data.sku for a specific artifact_id.',
          tags: ['Ingestions'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'artifact_id from GET /api/ingestions/recent',
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            200: {
              description: 'Ingestion trace payload',
              content: {
                'application/json': {
                  example: {
                    data: {
                      artifact: {
                        id: '6c8d5a0f-5f3d-4928-bf8b-5a88eb1c2d9f',
                        source_external_id: 'https://www.example.com/products/my-product',
                        status: 'completed',
                        received_at: '2026-06-01T06:50:00.000Z',
                        processing_errors: [],
                      },
                      events: [
                        {
                          id: 'evt-1',
                          event_type: 'ingestion.extract.completed',
                          stage: 'extract',
                          created_at: '2026-06-01T06:50:12.000Z',
                          metadata: { durationMs: 1240 },
                        },
                      ],
                      sku: {
                        product: {
                          name: 'Example Product',
                          brand: 'Example Brand',
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthenticated' },
            404: { description: 'Artifact not found for this tenant' },
          },
        },
      },

      // ── Webhooks ──────────────────────────────────────────────────────────
      '/webhooks/nango': {
        post: {
          summary: 'Nango webhook receiver (HMAC-verified, not JWT-protected)',
          description: `Receives auth and sync events from Nango.
**Do not call this manually** — it is called by Nango after OAuth completes or a sync run finishes.
Protected by HMAC signature verification using \`NANGO_WEBHOOK_SECRET\`.
Implements queue-first ordering for idempotent processing.`,
          tags: ['Webhooks'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'Nango webhook payload (auth or sync event)',
                },
              },
            },
          },
          responses: {
            202: {
              description: 'Webhook received and enqueued',
              content: {
                'application/json': {
                  example: { received: true, webhookId: 'webhook-uuid-...' },
                },
              },
            },
            400: { description: 'HMAC signature verification failed' },
          },
        },
      },

      // ── Auth (Google OAuth) ───────────────────────────────────────────────
      '/api/auth/google': {
        get: {
          summary: 'Begin Google OAuth sign-in (redirects to Google)',
          description: 'Sets a CSRF state cookie and 302-redirects to Google\'s consent screen. Open in a browser — not an XHR endpoint. Only mounted when GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI are configured.',
          tags: ['Auth'],
          responses: {
            302: { description: 'Redirect to the Google consent screen' },
          },
        },
      },
      '/api/auth/google/callback': {
        get: {
          summary: 'Google OAuth callback (redirect target — called by Google)',
          description: 'Verifies the state cookie, exchanges the code, then either logs an existing merchant in (sets the aonex_token cookie) or issues a short-lived pending token and redirects to the workspace-naming step.',
          tags: ['Auth'],
          parameters: [
            { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            302: { description: 'Redirect to the app (existing user) or the signup workspace step (new user)' },
          },
        },
      },
      '/api/auth/google/complete': {
        post: {
          summary: 'Finish Google sign-up by naming the workspace',
          description: 'Exchanges a pending token (from the callback) plus a tenant name for a new tenant + merchant, then returns a JWT.',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['tenantName', 'pendingToken'],
              properties: {
                tenantName: { type: 'string', example: 'Acme Corp' },
                pendingToken: { type: 'string', description: 'Pending JWT issued by /api/auth/google/callback' },
              },
            } } },
          },
          responses: {
            201: { description: 'Tenant + merchant created; JWT returned' },
            401: { description: 'Pending token expired or invalid' },
            409: { description: 'Email already registered' },
          },
        },
      },

      // ── Ingestions (CSV) ──────────────────────────────────────────────────
      '/api/ingestions/csv': {
        post: {
          summary: 'Upload a CSV file for catalog ingestion (async)',
          description: 'Multipart upload. The file is stored as a source artifact and a csv_parse job is enqueued; rows are grouped into products and admitted or staged. Returns 202 immediately. Max size is CSV_MAX_BYTES (default 15 MB).',
          tags: ['Ingestions'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'multipart/form-data': { schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary', description: 'Canonical product CSV' } },
            } } },
          },
          responses: {
            202: { description: 'File accepted — parsing in progress' },
            400: { description: 'Missing or invalid file' },
            401: { description: 'Unauthenticated' },
            413: { description: 'File exceeds CSV_MAX_BYTES' },
          },
        },
      },

      // ── eBay ──────────────────────────────────────────────────────────────
      '/api/marketplaces/ebay/connect': {
        post: {
          summary: 'Get an eBay OAuth URL to connect a merchant\'s eBay account',
          tags: ['eBay'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'OAuth URL + expiry',
              content: { 'application/json': { example: { data: { url: 'https://connect.nango.dev?session_token=...', expiresAt: '2026-06-04T12:00:00.000Z' } } } },
            },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/marketplaces/ebay/callback': {
        get: {
          summary: 'Post-OAuth callback — confirms the eBay connection and enqueues initial sync',
          tags: ['eBay'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Connection confirmed, sync enqueued', content: { 'application/json': { example: { data: { status: 'active', marketplace: 'ebay' } } } } },
            404: { description: 'No eBay connection found (OAuth not completed)' },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/marketplaces/ebay/inventory': {
        get: {
          summary: 'List inventory items from the connected eBay account (live read)',
          tags: ['eBay'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'eBay inventory items' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/marketplaces/ebay/orders': {
        get: {
          summary: 'List recent orders from the connected eBay account (live read)',
          tags: ['eBay'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'eBay order records' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/marketplaces/ebay/offers': {
        get: {
          summary: 'List offers from the connected eBay account (live read)',
          tags: ['eBay'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'eBay offer records' }, 401: { description: 'Unauthenticated' } },
        },
      },

      // ── Catalog ───────────────────────────────────────────────────────────
      '/api/catalog/products': {
        get: {
          summary: 'List catalog products for the merchant (paginated)',
          description: 'Merchant-isolated. Pagination via ?limit (clamped by the service) and an opaque ?cursor.',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Page size (clamped by the service)' },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from a prior response' },
          ],
          responses: {
            200: { description: 'Product page', content: { 'application/json': { example: { data: { products: [], nextCursor: null, total: 0 } } } } },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/catalog/products/{id}': {
        get: {
          summary: 'Get a single catalog product by id',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Product detail' }, 404: { description: 'Not found for this tenant' }, 401: { description: 'Unauthenticated' } },
        },
        delete: {
          summary: 'Soft-delete a catalog product (sets status = deleted)',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Product soft-deleted' }, 404: { description: 'Not found for this tenant' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/catalog/products/{id}/provenance': {
        get: {
          summary: 'Legacy provenance trace for a product (proposed_diffs chain)',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Provenance chain' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/catalog/products/{id}/sku': {
        get: {
          summary: 'Get the assembled canonical SKU JSON for a product',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'SKU payload' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/catalog/products/{product_id}/provenance/{attribute_code}': {
        get: {
          summary: 'Per-attribute provenance (new schema: catalog_products + winning_values)',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'product_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'attribute_code', in: 'path', required: true, schema: { type: 'string' }, example: 'base_price' },
          ],
          responses: { 200: { description: 'Winning value plus the observations behind it' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/catalog/products/{product_id}/trace': {
        get: {
          summary: 'Full product debug trace (spec §20)',
          tags: ['Catalog'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'product_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Trace payload' }, 401: { description: 'Unauthenticated' } },
        },
      },

      // ── Review ────────────────────────────────────────────────────────────
      '/api/review/tasks': {
        get: {
          summary: 'List review tasks',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Review task list' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/clusters': {
        get: {
          summary: 'List review clusters',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Cluster list' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/clusters/{cluster_key}/items': {
        get: {
          summary: 'List the tasks within a review cluster',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'cluster_key', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Cluster items' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/clusters/{cluster_key}/resolve': {
        post: {
          summary: 'Bulk-resolve a review cluster (approve_all / reject_all)',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'cluster_key', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: { type: 'string', enum: ['approve_all', 'reject_all'] },
              bulkEdit: { type: 'object', properties: { fieldName: { type: 'string' }, newValue: {} } },
            },
          } } } },
          responses: { 200: { description: 'Cluster resolved' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/tasks/{id}/edit-and-approve': {
        post: {
          summary: 'Edit a field then approve a review task',
          description: 'Optionally rebinds a mapping (writes a mapping_override) and applies the approved diff.',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['fieldName', 'newCanonicalPath', 'newNormalizedValue'],
            properties: {
              fieldName: { type: 'string' },
              newCanonicalPath: { type: 'string', nullable: true },
              newNormalizedValue: {},
              pickedCandidateSource: { type: 'string' },
              reason: { type: 'string' },
            },
          } } } },
          responses: { 200: { description: 'Task approved' }, 404: { description: 'Task not found' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/tasks/{id}': {
        patch: {
          summary: 'Patch a review task (save / approve / reject / dismiss)',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: { type: 'string', enum: ['save', 'approve', 'reject', 'dismiss'] },
              diff_payload: { type: 'object' },
              resolution_notes: { type: 'string', maxLength: 1000 },
            },
          } } } },
          responses: { 200: { description: 'Task updated' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/tasks/{id}/reject': {
        post: {
          summary: 'Reject a review task with a reason',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: { type: 'string', enum: ['wrong_value', 'missing_field', 'wrong_category', 'no_product_found'] },
              note: { type: 'string' },
            },
          } } } },
          responses: { 200: { description: 'Task rejected' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/tasks/{id}/merge': {
        post: {
          summary: 'Merge a review task into an existing product',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['existingProductId'],
            properties: { existingProductId: { type: 'string', format: 'uuid' } },
          } } } },
          responses: { 200: { description: 'Merged' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/review/tasks/{id}/evidence': {
        get: {
          summary: 'Get the evidence backing a review task',
          tags: ['Review'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Evidence payload' }, 401: { description: 'Unauthenticated' } },
        },
      },

      // ── Anomaly Lab ───────────────────────────────────────────────────────
      '/api/lab/queue': {
        get: {
          summary: 'List the staged-product review queue (paginated)',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'ISO createdAt of the last item seen' },
          ],
          responses: {
            200: { description: 'Staged queue page', content: { 'application/json': { example: { data: { items: [], nextCursor: null } } } } },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/lab/queue/stats': {
        get: {
          summary: 'Pending-queue counts by reason / source / age',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Queue stats', content: { 'application/json': { example: { data: { total: 0, byReason: {}, bySource: {}, byAge: { today: 0, week: 0, older: 0 } } } } } },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/lab/staged/{id}': {
        get: {
          summary: 'Get full detail for one staged product',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Staged product detail' }, 404: { description: 'Not found for this tenant' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/lab/staged/{id}/evidence': {
        get: {
          summary: 'Get the evidence for a staged product',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Evidence payload' }, 401: { description: 'Unauthenticated' } },
        },
      },
      '/api/lab/staged/{id}/approve': {
        post: {
          summary: 'Approve (promote) a staged product into the catalog',
          description: 'Reviewer `fills` are merged with the staged observations to satisfy the readiness gate. Returns 400 INCOMPLETE (with stillMissing) when the gate is still unmet.',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: false, content: { 'application/json': { schema: {
            type: 'object',
            properties: { fills: { type: 'object', description: 'Field → value overrides supplied by the reviewer' } },
          } } } },
          responses: {
            200: { description: 'Promoted to catalog', content: { 'application/json': { example: { data: { productId: 'uuid-...' } } } } },
            400: { description: 'Still incomplete (stillMissing returned)' },
            409: { description: 'Staged product no longer pending' },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/lab/staged/{id}/reject': {
        post: {
          summary: 'Reject a staged product (terminal)',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Rejected', content: { 'application/json': { example: { data: { ok: true } } } } },
            409: { description: 'Staged product no longer pending' },
            401: { description: 'Unauthenticated' },
          },
        },
      },
      '/api/lab/staged/{id}/link': {
        post: {
          summary: 'Link a staged product to an existing catalog product',
          tags: ['Anomaly Lab'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['confirmedProductId'],
            properties: {
              confirmedProductId: { type: 'string', description: 'The existing catalog product to link this staged product into' },
              fills: { type: 'object', description: 'Optional reviewer field overrides' },
            },
          } } } },
          responses: {
            200: { description: 'Linked', content: { 'application/json': { example: { data: { productId: 'uuid-...' } } } } },
            400: { description: 'Confirmed product is not a candidate for this staged product' },
            401: { description: 'Unauthenticated' },
          },
        },
      },
    },
  };

  // Serve the OpenAPI JSON at /ui/doc
  app.get('/doc', (c) => c.json(openApiSpec));

  // Serve the Swagger UI at the root of this app (/ui)
  app.get('/', swaggerUI({ url: '/ui/doc' }));

  return app;
}
