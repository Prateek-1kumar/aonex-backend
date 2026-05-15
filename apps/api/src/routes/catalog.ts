import { Hono } from "hono";
import { and, desc, eq, ne } from "drizzle-orm";
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
      .where(
        and(
          eq(schema.products.tenantId, tenantId),
          eq(schema.products.merchantId, merchantId),
          ne(schema.products.status, "deleted")
        )
      )
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

  // Delete a catalog product. Soft-delete: status flips to 'deleted' so
  // the row drops out of the list (hard delete would fail because
  // product_versions / variants reference it ON DELETE RESTRICT). The row
  // stays in the DB for audit + foreign-key integrity.
  app.delete("/products/:id", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const id = c.req.param("id");

    const result = await deps.db
      .update(schema.products)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(
        and(
          eq(schema.products.id, id),
          eq(schema.products.tenantId, tenantId),
          eq(schema.products.merchantId, merchantId)
        )
      )
      .returning({ id: schema.products.id });

    if (result.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "Product not found" } }, 404);
    }
    return c.json({ data: { id: result[0]!.id, status: "deleted" } });
  });

  return app;
}
