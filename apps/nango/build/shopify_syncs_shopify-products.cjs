"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// shopify/syncs/shopify-products.ts
var shopify_products_exports = {};
__export(shopify_products_exports, {
  default: () => shopify_products_default
});
module.exports = __toCommonJS(shopify_products_exports);
var import_zod = require("zod");
var CheckpointSchema = import_zod.z.object({
  updated_after: import_zod.z.string()
});
var VariantSchema = import_zod.z.object({
  id: import_zod.z.string(),
  title: import_zod.z.string(),
  sku: import_zod.z.string().nullable().optional(),
  barcode: import_zod.z.string().nullable().optional(),
  price: import_zod.z.string(),
  inventoryQuantity: import_zod.z.number(),
  selectedOptions: import_zod.z.array(import_zod.z.object({
    name: import_zod.z.string(),
    value: import_zod.z.string()
  }))
});
var ShopifyProductSchema = import_zod.z.object({
  id: import_zod.z.string(),
  title: import_zod.z.string(),
  handle: import_zod.z.string(),
  status: import_zod.z.string(),
  vendor: import_zod.z.string().nullable().optional(),
  productType: import_zod.z.string().nullable().optional(),
  tags: import_zod.z.array(import_zod.z.string()),
  updated_at: import_zod.z.string(),
  options: import_zod.z.array(import_zod.z.object({
    name: import_zod.z.string(),
    values: import_zod.z.array(import_zod.z.string())
  })),
  images: import_zod.z.array(import_zod.z.object({
    url: import_zod.z.string(),
    altText: import_zod.z.string().nullable().optional()
  })),
  variants: import_zod.z.array(VariantSchema)
});
var PRODUCTS_QUERY = (
  /* GraphQL */
  `
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
`
);
var sync = {
  type: "sync",
  description: "Pulls Shopify products + variants + inventory via Admin GraphQL with updated_at checkpoint",
  version: "1.0.0",
  frequency: "every 6 hours",
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: {
    ShopifyProduct: ShopifyProductSchema
  },
  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    const filter = checkpoint?.updated_after ? `updatedAt:>'${checkpoint.updated_after}'` : "";
    let cursor;
    do {
      const res = await nango.post({
        endpoint: "/admin/api/2024-10/graphql.json",
        data: {
          query: PRODUCTS_QUERY,
          variables: {
            after: cursor ?? null,
            filter
          }
        },
        retries: 3
      });
      const {
        edges,
        pageInfo
      } = res.data.data.products;
      const records = edges.map(({
        node
      }) => ({
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        ...node.vendor != null && {
          vendor: node.vendor
        },
        ...node.productType != null && {
          productType: node.productType
        },
        tags: node.tags,
        updated_at: node.updatedAt,
        options: node.options,
        images: node.images.edges.map((e) => e.node),
        variants: node.variants.edges.map((e) => e.node)
      }));
      if (records.length > 0) {
        await nango.batchSave(records, "ShopifyProduct");
        const lastRecord = records[records.length - 1];
        if (lastRecord) {
          await nango.saveCheckpoint({
            updated_after: lastRecord.updated_at
          });
        }
      }
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : void 0;
    } while (cursor);
  }
};
var shopify_products_default = sync;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic2hvcGlmeS9zeW5jcy9zaG9waWZ5LXByb2R1Y3RzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBjcmVhdGVTeW5jIH0gZnJvbSAnbmFuZ28nO1xuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5cbi8vIFpvZENoZWNrcG9pbnQgY29uc3RyYWludDogei5ab2RPYmplY3Q8UmVjb3JkPHN0cmluZywgWm9kU3RyaW5nIHwgWm9kTnVtYmVyIHwgWm9kQm9vbGVhbj4+XG4vLyBPcHRpb25hbCBmaWVsZHMgYXJlIG5vdCBhbGxvd2VkIFx1MjAxNCB1c2UgYSBzZW50aW5lbCBlbXB0eSBzdHJpbmcgZm9yIFwibm8gY2hlY2twb2ludCB5ZXRcIi5cbmNvbnN0IENoZWNrcG9pbnRTY2hlbWEgPSB6Lm9iamVjdCh7XG4gIHVwZGF0ZWRfYWZ0ZXI6IHouc3RyaW5nKClcbn0pO1xuY29uc3QgVmFyaWFudFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgaWQ6IHouc3RyaW5nKCksXG4gIHRpdGxlOiB6LnN0cmluZygpLFxuICBza3U6IHouc3RyaW5nKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBiYXJjb2RlOiB6LnN0cmluZygpLm51bGxhYmxlKCkub3B0aW9uYWwoKSxcbiAgcHJpY2U6IHouc3RyaW5nKCksXG4gIGludmVudG9yeVF1YW50aXR5OiB6Lm51bWJlcigpLFxuICBzZWxlY3RlZE9wdGlvbnM6IHouYXJyYXkoei5vYmplY3Qoe1xuICAgIG5hbWU6IHouc3RyaW5nKCksXG4gICAgdmFsdWU6IHouc3RyaW5nKClcbiAgfSkpXG59KTtcbmNvbnN0IFNob3BpZnlQcm9kdWN0U2NoZW1hID0gei5vYmplY3Qoe1xuICBpZDogei5zdHJpbmcoKSxcbiAgdGl0bGU6IHouc3RyaW5nKCksXG4gIGhhbmRsZTogei5zdHJpbmcoKSxcbiAgc3RhdHVzOiB6LnN0cmluZygpLFxuICB2ZW5kb3I6IHouc3RyaW5nKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBwcm9kdWN0VHlwZTogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIHRhZ3M6IHouYXJyYXkoei5zdHJpbmcoKSksXG4gIHVwZGF0ZWRfYXQ6IHouc3RyaW5nKCksXG4gIG9wdGlvbnM6IHouYXJyYXkoei5vYmplY3Qoe1xuICAgIG5hbWU6IHouc3RyaW5nKCksXG4gICAgdmFsdWVzOiB6LmFycmF5KHouc3RyaW5nKCkpXG4gIH0pKSxcbiAgaW1hZ2VzOiB6LmFycmF5KHoub2JqZWN0KHtcbiAgICB1cmw6IHouc3RyaW5nKCksXG4gICAgYWx0VGV4dDogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKClcbiAgfSkpLFxuICB2YXJpYW50czogei5hcnJheShWYXJpYW50U2NoZW1hKVxufSk7XG50eXBlIFNob3BpZnlQcm9kdWN0ID0gei5pbmZlcjx0eXBlb2YgU2hvcGlmeVByb2R1Y3RTY2hlbWE+O1xuY29uc3QgUFJPRFVDVFNfUVVFUlkgPSAvKiBHcmFwaFFMICovYFxuICBxdWVyeSBQcm9kdWN0cygkYWZ0ZXI6IFN0cmluZywgJGZpbHRlcjogU3RyaW5nKSB7XG4gICAgcHJvZHVjdHMoZmlyc3Q6IDUwLCBhZnRlcjogJGFmdGVyLCBxdWVyeTogJGZpbHRlcikge1xuICAgICAgcGFnZUluZm8geyBoYXNOZXh0UGFnZSBlbmRDdXJzb3IgfVxuICAgICAgZWRnZXMge1xuICAgICAgICBub2RlIHtcbiAgICAgICAgICBpZCB0aXRsZSBoYW5kbGUgc3RhdHVzIHZlbmRvciBwcm9kdWN0VHlwZSB0YWdzIHVwZGF0ZWRBdFxuICAgICAgICAgIG9wdGlvbnMgeyBuYW1lIHZhbHVlcyB9XG4gICAgICAgICAgaW1hZ2VzKGZpcnN0OiAxMCkgeyBlZGdlcyB7IG5vZGUgeyB1cmwgYWx0VGV4dCB9IH0gfVxuICAgICAgICAgIHZhcmlhbnRzKGZpcnN0OiAxMDApIHtcbiAgICAgICAgICAgIGVkZ2VzIHtcbiAgICAgICAgICAgICAgbm9kZSB7XG4gICAgICAgICAgICAgICAgaWQgdGl0bGUgc2t1IGJhcmNvZGUgcHJpY2UgaW52ZW50b3J5UXVhbnRpdHlcbiAgICAgICAgICAgICAgICBzZWxlY3RlZE9wdGlvbnMgeyBuYW1lIHZhbHVlIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuYDtcbmludGVyZmFjZSBQcm9kdWN0Tm9kZSB7XG4gIGlkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGhhbmRsZTogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgdmVuZG9yOiBzdHJpbmcgfCBudWxsO1xuICBwcm9kdWN0VHlwZTogc3RyaW5nIHwgbnVsbDtcbiAgdGFnczogc3RyaW5nW107XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICBvcHRpb25zOiBBcnJheTx7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIHZhbHVlczogc3RyaW5nW107XG4gIH0+O1xuICBpbWFnZXM6IHtcbiAgICBlZGdlczogQXJyYXk8e1xuICAgICAgbm9kZToge1xuICAgICAgICB1cmw6IHN0cmluZztcbiAgICAgICAgYWx0VGV4dDogc3RyaW5nIHwgbnVsbDtcbiAgICAgIH07XG4gICAgfT47XG4gIH07XG4gIHZhcmlhbnRzOiB7XG4gICAgZWRnZXM6IEFycmF5PHtcbiAgICAgIG5vZGU6IHtcbiAgICAgICAgaWQ6IHN0cmluZztcbiAgICAgICAgdGl0bGU6IHN0cmluZztcbiAgICAgICAgc2t1OiBzdHJpbmcgfCBudWxsO1xuICAgICAgICBiYXJjb2RlOiBzdHJpbmcgfCBudWxsO1xuICAgICAgICBwcmljZTogc3RyaW5nO1xuICAgICAgICBpbnZlbnRvcnlRdWFudGl0eTogbnVtYmVyO1xuICAgICAgICBzZWxlY3RlZE9wdGlvbnM6IEFycmF5PHtcbiAgICAgICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICAgICAgdmFsdWU6IHN0cmluZztcbiAgICAgICAgfT47XG4gICAgICB9O1xuICAgIH0+O1xuICB9O1xufVxuaW50ZXJmYWNlIEdyYXBoUUxSZXNwb25zZSB7XG4gIGRhdGE6IHtcbiAgICBwcm9kdWN0czoge1xuICAgICAgcGFnZUluZm86IHtcbiAgICAgICAgaGFzTmV4dFBhZ2U6IGJvb2xlYW47XG4gICAgICAgIGVuZEN1cnNvcjogc3RyaW5nO1xuICAgICAgfTtcbiAgICAgIGVkZ2VzOiBBcnJheTx7XG4gICAgICAgIG5vZGU6IFByb2R1Y3ROb2RlO1xuICAgICAgfT47XG4gICAgfTtcbiAgfTtcbn1cbmNvbnN0IHN5bmMgPSB7XG4gIHR5cGU6IFwic3luY1wiLFxuICBkZXNjcmlwdGlvbjogJ1B1bGxzIFNob3BpZnkgcHJvZHVjdHMgKyB2YXJpYW50cyArIGludmVudG9yeSB2aWEgQWRtaW4gR3JhcGhRTCB3aXRoIHVwZGF0ZWRfYXQgY2hlY2twb2ludCcsXG4gIHZlcnNpb246ICcxLjAuMCcsXG4gIGZyZXF1ZW5jeTogJ2V2ZXJ5IDYgaG91cnMnLFxuICBhdXRvU3RhcnQ6IHRydWUsXG4gIGNoZWNrcG9pbnQ6IENoZWNrcG9pbnRTY2hlbWEsXG4gIG1vZGVsczoge1xuICAgIFNob3BpZnlQcm9kdWN0OiBTaG9waWZ5UHJvZHVjdFNjaGVtYVxuICB9LFxuICBleGVjOiBhc3luYyBuYW5nbyA9PiB7XG4gICAgY29uc3QgY2hlY2twb2ludCA9IGF3YWl0IG5hbmdvLmdldENoZWNrcG9pbnQoKTtcbiAgICAvLyBFbXB0eSBzdHJpbmcgc2VudGluZWwgPSBmaXJzdCBydW4gKGZ1bGwgcHVsbCkuIE5vbi1lbXB0eSA9IGluY3JlbWVudGFsIGZpbHRlci5cbiAgICBjb25zdCBmaWx0ZXIgPSBjaGVja3BvaW50Py51cGRhdGVkX2FmdGVyID8gYHVwZGF0ZWRBdDo+JyR7Y2hlY2twb2ludC51cGRhdGVkX2FmdGVyfSdgIDogJyc7XG4gICAgbGV0IGN1cnNvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGRvIHtcbiAgICAgIC8vIGh0dHBzOi8vc2hvcGlmeS5kZXYvZG9jcy9hcGkvYWRtaW4tZ3JhcGhxbC8yMDI0LTEwL3F1ZXJpZXMvcHJvZHVjdHNcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IG5hbmdvLnBvc3Q8R3JhcGhRTFJlc3BvbnNlPih7XG4gICAgICAgIGVuZHBvaW50OiAnL2FkbWluL2FwaS8yMDI0LTEwL2dyYXBocWwuanNvbicsXG4gICAgICAgIGRhdGE6IHtcbiAgICAgICAgICBxdWVyeTogUFJPRFVDVFNfUVVFUlksXG4gICAgICAgICAgdmFyaWFibGVzOiB7XG4gICAgICAgICAgICBhZnRlcjogY3Vyc29yID8/IG51bGwsXG4gICAgICAgICAgICBmaWx0ZXJcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIHJldHJpZXM6IDNcbiAgICAgIH0pO1xuICAgICAgY29uc3Qge1xuICAgICAgICBlZGdlcyxcbiAgICAgICAgcGFnZUluZm9cbiAgICAgIH0gPSByZXMuZGF0YS5kYXRhLnByb2R1Y3RzO1xuICAgICAgY29uc3QgcmVjb3JkczogU2hvcGlmeVByb2R1Y3RbXSA9IGVkZ2VzLm1hcCgoe1xuICAgICAgICBub2RlXG4gICAgICB9KSA9PiAoe1xuICAgICAgICBpZDogbm9kZS5pZCxcbiAgICAgICAgdGl0bGU6IG5vZGUudGl0bGUsXG4gICAgICAgIGhhbmRsZTogbm9kZS5oYW5kbGUsXG4gICAgICAgIHN0YXR1czogbm9kZS5zdGF0dXMsXG4gICAgICAgIC4uLihub2RlLnZlbmRvciAhPSBudWxsICYmIHtcbiAgICAgICAgICB2ZW5kb3I6IG5vZGUudmVuZG9yXG4gICAgICAgIH0pLFxuICAgICAgICAuLi4obm9kZS5wcm9kdWN0VHlwZSAhPSBudWxsICYmIHtcbiAgICAgICAgICBwcm9kdWN0VHlwZTogbm9kZS5wcm9kdWN0VHlwZVxuICAgICAgICB9KSxcbiAgICAgICAgdGFnczogbm9kZS50YWdzLFxuICAgICAgICB1cGRhdGVkX2F0OiBub2RlLnVwZGF0ZWRBdCxcbiAgICAgICAgb3B0aW9uczogbm9kZS5vcHRpb25zLFxuICAgICAgICBpbWFnZXM6IG5vZGUuaW1hZ2VzLmVkZ2VzLm1hcChlID0+IGUubm9kZSksXG4gICAgICAgIHZhcmlhbnRzOiBub2RlLnZhcmlhbnRzLmVkZ2VzLm1hcChlID0+IGUubm9kZSlcbiAgICAgIH0pKTtcbiAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgbmFuZ28uYmF0Y2hTYXZlKHJlY29yZHMsICdTaG9waWZ5UHJvZHVjdCcpO1xuICAgICAgICAvLyBQZXItcGFnZSBjaGVja3BvaW50OiBlbmFibGVzIG1pZC1ydW4gcmVzdW1hYmlsaXR5IGF0IHRoZSBjb3N0IG9mIGEgcGFydGlhbC1mYWlsdXJlXG4gICAgICAgIC8vIHdpbmRvdy4gSWYgTmFuZ28gYWJvcnRzIGFmdGVyIHBhZ2UgTiwgdGhlIG5leHQgcnVuIHN0YXJ0cyBmcm9tIHBhZ2UgTidzIGxhc3RcbiAgICAgICAgLy8gdXBkYXRlZEF0IFx1MjAxNCBwYWdlcyBOKzEuLmVuZCBhcmUgc2tpcHBlZCB1bnRpbCB0aG9zZSBwcm9kdWN0cyBhcmUgdXBkYXRlZCBhZ2Fpbi5cbiAgICAgICAgLy8gVGhpcyB0cmFkZS1vZmYgaXMgYWNjZXB0ZWQ6IGxhcmdlIFNob3BpZnkgY2F0YWxvZ3MgbWF5IHNwYW4gaHVuZHJlZHMgb2YgcGFnZXMsXG4gICAgICAgIC8vIGFuZCByZXN1bWFiaWxpdHkgbWF0dGVycyBtb3JlIHRoYW4gZ3VhcmFudGVlZCBzaW5nbGUtcnVuIGNvbXBsZXRlbmVzcy5cbiAgICAgICAgY29uc3QgbGFzdFJlY29yZCA9IHJlY29yZHNbcmVjb3Jkcy5sZW5ndGggLSAxXTtcbiAgICAgICAgaWYgKGxhc3RSZWNvcmQpIHtcbiAgICAgICAgICBhd2FpdCBuYW5nby5zYXZlQ2hlY2twb2ludCh7XG4gICAgICAgICAgICB1cGRhdGVkX2FmdGVyOiBsYXN0UmVjb3JkLnVwZGF0ZWRfYXRcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY3Vyc29yID0gcGFnZUluZm8uaGFzTmV4dFBhZ2UgPyBwYWdlSW5mby5lbmRDdXJzb3IgOiB1bmRlZmluZWQ7XG4gICAgfSB3aGlsZSAoY3Vyc29yKTtcbiAgfVxufTtcbmV4cG9ydCB0eXBlIE5hbmdvU3luY0xvY2FsID0gUGFyYW1ldGVyczwodHlwZW9mIHN5bmMpWydleGVjJ10+WzBdO1xuZXhwb3J0IGRlZmF1bHQgc3luYzsiXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFDQSxpQkFBa0I7QUFJbEIsSUFBTSxtQkFBbUIsYUFBRSxPQUFPO0FBQUEsRUFDaEMsZUFBZSxhQUFFLE9BQU87QUFDMUIsQ0FBQztBQUNELElBQU0sZ0JBQWdCLGFBQUUsT0FBTztBQUFBLEVBQzdCLElBQUksYUFBRSxPQUFPO0FBQUEsRUFDYixPQUFPLGFBQUUsT0FBTztBQUFBLEVBQ2hCLEtBQUssYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUNwQyxTQUFTLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDeEMsT0FBTyxhQUFFLE9BQU87QUFBQSxFQUNoQixtQkFBbUIsYUFBRSxPQUFPO0FBQUEsRUFDNUIsaUJBQWlCLGFBQUUsTUFBTSxhQUFFLE9BQU87QUFBQSxJQUNoQyxNQUFNLGFBQUUsT0FBTztBQUFBLElBQ2YsT0FBTyxhQUFFLE9BQU87QUFBQSxFQUNsQixDQUFDLENBQUM7QUFDSixDQUFDO0FBQ0QsSUFBTSx1QkFBdUIsYUFBRSxPQUFPO0FBQUEsRUFDcEMsSUFBSSxhQUFFLE9BQU87QUFBQSxFQUNiLE9BQU8sYUFBRSxPQUFPO0FBQUEsRUFDaEIsUUFBUSxhQUFFLE9BQU87QUFBQSxFQUNqQixRQUFRLGFBQUUsT0FBTztBQUFBLEVBQ2pCLFFBQVEsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUN2QyxhQUFhLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDNUMsTUFBTSxhQUFFLE1BQU0sYUFBRSxPQUFPLENBQUM7QUFB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
