import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { MerchantId, TenantId } from "@aonex/types";

export interface CatalogRouteDeps {
  db: DrizzleClient;
}

export function catalogRoutes(deps: CatalogRouteDeps): Hono {
  const app = new Hono();

  app.get("/products", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);

    const products = await deps.db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.merchantId, merchantId)))
      .orderBy(desc(schema.products.updatedAt));

    const hydrated = await Promise.all(
      products.map(async (product) => {
        const version = product.currentVersionId
          ? await deps.db.query.productVersions.findFirst({
              where: (v, { eq }) => eq(v.id, product.currentVersionId as string),
            })
          : null;

        const variants = version
          ? await deps.db
              .select()
              .from(schema.productVariantVersions)
              .where(eq(schema.productVariantVersions.productVersionId, version.id))
          : [];

        return {
          ...product,
          current_version: version,
          variants,
        };
      })
    );

    return c.json({ data: { products: hydrated } });
  });

  return app;
}
