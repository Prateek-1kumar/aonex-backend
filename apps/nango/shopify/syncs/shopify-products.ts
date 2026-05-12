import { createSync } from 'nango';
import { z } from 'zod';

// ZodCheckpoint constraint: z.ZodObject<Record<string, ZodString | ZodNumber | ZodBoolean>>
// Optional fields are not allowed — use a sentinel empty string for "no checkpoint yet".
const CheckpointSchema = z.object({
  updated_after: z.string()
});

const VariantSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  price: z.string(),
  inventoryQuantity: z.number(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() }))
});

const ShopifyProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(),
  vendor: z.string().nullable().optional(),
  productType: z.string().nullable().optional(),
  tags: z.array(z.string()),
  updated_at: z.string(),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  images: z.array(z.object({ url: z.string(), altText: z.string().nullable().optional() })),
  variants: z.array(VariantSchema)
});

type ShopifyProduct = z.infer<typeof ShopifyProductSchema>;

const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($after: String, $filter: String) {
    products(first: 50, after: $after, query: $filter) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title handle status vendor productType tags updatedAt
          options { name values }
          images(first: 10) { edges { node { url altText } } }
          variants(first: 100) {
            edges {
              node {
                id title sku barcode price inventoryQuantity
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  updatedAt: string;
  options: Array<{ name: string; values: string[] }>;
  images: { edges: Array<{ node: { url: string; altText: string | null } }> };
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        sku: string | null;
        barcode: string | null;
        price: string;
        inventoryQuantity: number;
        selectedOptions: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

interface GraphQLResponse {
  data: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: Array<{ node: ProductNode }>;
    };
  };
}

const sync = createSync({
  description: 'Pulls Shopify products + variants + inventory via Admin GraphQL with updated_at checkpoint',
  version: '1.0.0',
  frequency: 'every 6 hours',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: {
    ShopifyProduct: ShopifyProductSchema
  },

  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    // Empty string sentinel = first run (full pull). Non-empty = incremental filter.
    const filter =
      checkpoint?.updated_after ? `updatedAt:>'${checkpoint.updated_after}'` : '';

    let cursor: string | undefined;

    do {
      // https://shopify.dev/docs/api/admin-graphql/2024-10/queries/products
      const res = await nango.post<GraphQLResponse>({
        endpoint: '/admin/api/2024-10/graphql.json',
        data: { query: PRODUCTS_QUERY, variables: { after: cursor ?? null, filter } },
        retries: 3
      });

      const { edges, pageInfo } = res.data.data.products;

      const records: ShopifyProduct[] = edges.map(({ node }) => ({
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        ...(node.vendor != null && { vendor: node.vendor }),
        ...(node.productType != null && { productType: node.productType }),
        tags: node.tags,
        updated_at: node.updatedAt,
        options: node.options,
        images: node.images.edges.map((e) => e.node),
        variants: node.variants.edges.map((e) => e.node)
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'ShopifyProduct');
        // Per-page checkpoint: enables mid-run resumability at the cost of a partial-failure
        // window. If Nango aborts after page N, the next run starts from page N's last
        // updatedAt — pages N+1..end are skipped until those products are updated again.
        // This trade-off is accepted: large Shopify catalogs may span hundreds of pages,
        // and resumability matters more than guaranteed single-run completeness.
        const lastRecord = records[records.length - 1];
        if (lastRecord) {
          await nango.saveCheckpoint({ updated_after: lastRecord.updated_at });
        }
      }

      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : undefined;
    } while (cursor);
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
