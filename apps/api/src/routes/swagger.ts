
import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';

export function swaggerRoutes(): Hono {
  const app = new Hono();

  const openApiSpec = {
    openapi: '3.0.0',
    info: {
      title: 'Aonex API',
      version: '1.0.0',
      description: 'API Documentation for Aonex Backend',
    },
    servers: [{ url: 'http://localhost:8787' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    paths: {
      '/api/auth/login': {
        post: {
          summary: 'Merchant Login',
          tags: ['Auth'],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', example: 'dev@example.com' },
                    password: { type: 'string', example: 'password123' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Success' } },
        },
      },
      '/api/marketplaces/shopify/connect': {
        post: {
          summary: 'Shopify Connect',
          tags: ['Shopify'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Success' } },
        },
      },
      '/api/marketplaces/shopify/products': {
        get: {
          summary: 'Get Products',
          tags: ['Shopify'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Success' } },
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
