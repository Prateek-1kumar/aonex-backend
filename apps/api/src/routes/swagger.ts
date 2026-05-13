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
      { name: 'Auth', description: 'Signup, login, refresh, logout' },
      { name: 'Connections', description: 'Marketplace connection lifecycle (Nango generic flow)' },
      { name: 'Shopify', description: 'Shopify-specific OAuth connect, callback, products' },
      { name: 'Sync', description: 'Manual product sync trigger' },
      { name: 'Ingestions', description: 'LLM-based product extraction from URLs' },
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
          description: `Fetches the URL, runs LLM extraction to pull product facts, and ingests into the catalog.
Returns 202 immediately — extraction happens asynchronously via BullMQ.
Use \`GET /api/ingestions/link/test?url=...\` to test synchronously.`,
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

      '/api/ingestions/link/test': {
        get: {
          summary: 'Synchronous LLM extraction test — for development only',
          description: 'Fetches + extracts a URL synchronously and returns the raw facts. Use this to test without waiting for the queue.',
          tags: ['Ingestions'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'url',
              in: 'query',
              required: true,
              description: 'Product page URL to extract',
              schema: { type: 'string', format: 'uri', example: 'https://www.example.com/products/snowboard' },
            },
          ],
          responses: {
            200: {
              description: 'Extracted product facts',
              content: {
                'application/json': {
                  example: {
                    success: true,
                    data: {
                      url: 'https://...',
                      extracted_facts: [
                        { key: 'title', value: 'Pro Snowboard', confidence: 0.97 },
                        { key: 'price', value: '699.95', confidence: 0.95 },
                      ],
                      metadata: { model: 'gpt-4o-mini', tokens: 1200 },
                    },
                  },
                },
              },
            },
            400: { description: 'Missing ?url= parameter' },
            401: { description: 'Unauthenticated' },
            500: { description: 'Fetch or LLM extraction failed' },
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
    },
  };

  // Serve the OpenAPI JSON at /ui/doc
  app.get('/doc', (c) => c.json(openApiSpec));

  // Serve the Swagger UI at the root of this app (/ui)
  app.get('/', swaggerUI({ url: '/ui/doc' }));

  return app;
}
