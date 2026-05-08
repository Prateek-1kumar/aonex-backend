// Nango sync script — runs INSIDE Nango's runtime, NOT in our process.
// Deployed via: `nango deploy production`.
//
// LLD §11.1: this script lists products from Shopify Admin GraphQL,
// transforms minimally, and calls nango.batchSave. Nango caches the
// result and emits a sync webhook to /webhooks/nango when done.
//
// We deliberately keep transformations here trivial — the canonical
// normalization happens in the gateway adapter (HLD §17 boundary).

import type { NangoSync } from "@nangohq/types";

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  variants: Array<{
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: string;
    inventoryQuantity: number;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
  options: Array<{ name: string; values: string[] }>;
  images: Array<{ url: string; altText: string | null }>;
  updatedAt: string;
}

const QUERY = /* GraphQL */ `
  query Products($after: String) {
    products(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          vendor
          productType
          tags
          updatedAt
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

export default async function fetchData(nango: NangoSync): Promise<void> {
  let cursor: string | null = null;
  do {
    const res = (await nango.post({
      endpoint: "/admin/api/2024-10/graphql.json",
      data: { query: QUERY, variables: { after: cursor } }
    })) as {
      data: {
        data: {
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            edges: Array<{
              node: ShopifyProduct & {
                images: { edges: Array<{ node: { url: string; altText: string | null } }> };
                variants: { edges: Array<{ node: ShopifyProduct["variants"][number] }> };
              };
            }>;
          };
        };
      };
    };

    const records = res.data.data.products.edges.map(({ node }) => ({
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      vendor: node.vendor,
      productType: node.productType,
      tags: node.tags,
      updated_at: node.updatedAt,
      options: node.options,
      images: node.images.edges.map((e) => e.node),
      variants: node.variants.edges.map((e) => e.node)
    }));

    if (records.length > 0) {
      await nango.batchSave(records, "ShopifyProduct");
    }

    cursor = res.data.data.products.pageInfo.hasNextPage
      ? res.data.data.products.pageInfo.endCursor
      : null;
  } while (cursor);
}
