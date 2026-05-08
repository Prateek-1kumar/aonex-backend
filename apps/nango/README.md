# Nango sync scripts

These run **inside Nango's runtime**, not in our process. Deployed
with `nango deploy production` from this directory.

## Phase status (HLD §26)

| Marketplace | Sync script | Phase |
| --- | --- | --- |
| Shopify | `syncs/shopify/products.ts` | 1 |
| Amazon SP-API | `syncs/amazon/catalog-items.ts` | 3 |
| eBay | `syncs/ebay/inventory-items.ts` | 4 |
| Walmart | _(not yet)_ | 5 |
| Etsy | _(not yet)_ | 5 |

## Why these live in our repo

So the deployed-to-Nango code is versioned alongside the consumer
code that depends on its output shape. The CI gate is: any change to
a sync script's `model` field schema must be matched by a
corresponding change in the matching `packages/connector-gateway/src/adapters/nango/normalize/<marketplace>.ts`.

## Deploy

```bash
cd apps/nango
nango deploy production
```

Requires `NANGO_SECRET_KEY` in env.
