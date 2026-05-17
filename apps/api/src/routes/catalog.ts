import { Hono } from "hono";
import { and, desc, eq, ne, sql } from "drizzle-orm";
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

  /**
   * GET /products/:id/provenance — per-canonical-field rung breakdown.
   *
   * For each field on the latest product_version, look up which extracted_fact
   * (joined via the proposed_diff's source_fact_set) produced it, and return
   * the rung (extractionMethod), confidence, source_pointer, and parser version.
   * Phase 8 dashboards / Phase 7 selector-health both consume this for debugging.
   */
  app.get("/products/:id/provenance", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const productId = c.req.param("id");

    const product = await deps.db.query.products.findFirst({
      where: (p, { and, eq }) =>
        and(eq(p.id, productId), eq(p.tenantId, tenantId), eq(p.merchantId, merchantId)),
    });
    if (!product) {
      return c.json({ error: { code: "NOT_FOUND", message: "Product not found" } }, 404);
    }

    const version = product.currentVersionId
      ? await deps.db.query.productVersions.findFirst({
          where: (v, { eq }) => eq(v.id, product.currentVersionId as string),
        })
      : null;
    if (!version) {
      return c.json({ data: { product_id: productId, version: null, fields: [] } });
    }

    // Look up the category schema tier (Phase 3) if a path is set.
    let categoryTier: "authoritative" | "inferred" | "promoted_draft" | null = null;
    if (version.canonicalCategory) {
      const schemaRow = await deps.db.query.categorySchemas.findFirst({
        where: (c, { eq }) => eq(c.categoryPath, version.canonicalCategory as string),
        orderBy: (c, { desc }) => [desc(c.schemaVersion)],
      });
      categoryTier =
        (schemaRow?.tier as "authoritative" | "inferred" | "promoted_draft" | null | undefined) ?? null;
    }

    // Walk: product_version → proposed_diff → source_fact_set → extracted_facts.
    // We want per-canonical-path the BEST fact (highest confidence) and its rung,
    // plus the source_type (link_url / templated_csv / marketplace_connector).
    const facts = version.proposedDiffId
      ? await deps.db.execute(sql`
          SELECT
            ef.canonical_path,
            ef.raw_key,
            ef.extracted_value,
            ef.normalized_value,
            ef.source_pointer,
            ef.extraction_method,
            ef.confidence::float8 AS confidence,
            ef.mapping_method,
            er.extractor_version,
            er.mapper_version,
            sa.source_type
          FROM extracted_facts ef
          JOIN extracted_fact_sets efs ON efs.id = ef.fact_set_id
          JOIN extraction_runs er ON er.id = efs.extraction_run_id
          JOIN source_artifacts sa ON sa.id = er.artifact_id
          JOIN proposed_diffs pd ON pd.source_fact_set_id = efs.id
          WHERE pd.id = ${version.proposedDiffId}
          ORDER BY ef.canonical_path NULLS LAST, ef.confidence DESC
        `)
      : [];

    // Reduce to one row per canonical_path: best confidence wins.
    const seen = new Set<string>();
    const fields: Array<{
      canonical_path: string | null;
      raw_key: string;
      extracted_value: unknown;
      normalized_value: unknown;
      source_pointer: string;
      extraction_method: string;
      rung: string;
      confidence: number;
      mapping_method: string | null;
      extractor_version: string;
      mapper_version: string;
    }> = [];
    for (const row of facts as unknown as Array<{
      canonical_path: string | null;
      raw_key: string;
      extracted_value: unknown;
      normalized_value: unknown;
      source_pointer: string;
      extraction_method: string;
      confidence: number;
      mapping_method: string | null;
      extractor_version: string;
      mapper_version: string;
    }>) {
      const key = row.canonical_path ?? `_unmapped_${row.raw_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Derive the "rung" from sourcePointer (Phase 6 prefixes facts with rung tags)
      const sp = row.source_pointer ?? "";
      let rung = row.extraction_method;
      if (sp.startsWith("dom_heuristic:")) rung = "dom_heuristic";
      else if (sp.startsWith("vision:")) rung = "vision_llm";
      else if (sp.startsWith("json_ld")) rung = "json_ld";
      else if (sp.startsWith("nuxt:") || sp.startsWith("window.__NUXT__")) rung = "nuxt";
      else if (sp.startsWith("og:") || sp.startsWith("opengraph")) rung = "opengraph";
      else if (sp.startsWith("schema:") || sp.startsWith("rdfa:")) rung = "rdfa";
      else if (sp.includes("amazon")) rung = "per_site_parser:amazon";
      else if (sp.includes("ebay")) rung = "per_site_parser:ebay";
      else if (sp.includes("walmart")) rung = "per_site_parser:walmart";
      else if (sp.includes("bestbuy") || sp.includes(".specs-table") || sp.includes(".priceView")) rung = "per_site_parser:bestbuy";
      else if (sp.includes("croma") || sp.includes(".pd-title")) rung = "per_site_parser:croma";

      fields.push({
        canonical_path: row.canonical_path,
        raw_key: row.raw_key,
        extracted_value: row.extracted_value,
        normalized_value: row.normalized_value,
        source_pointer: row.source_pointer,
        extraction_method: row.extraction_method,
        rung,
        confidence: row.confidence,
        mapping_method: row.mapping_method,
        extractor_version: row.extractor_version,
        mapper_version: row.mapper_version,
      });
    }

    // Source-type aggregation: which lanes contributed to this product?
    const sourceTypes = Array.from(
      new Set(
        (facts as unknown as Array<{ source_type: string }>).map((f) => f.source_type)
      )
    );

    return c.json({
      data: {
        product_id: productId,
        version_id: version.id,
        category_path: version.canonicalCategory,
        category_schema_version: version.categorySchemaVersion,
        category_tier: categoryTier,
        source_types: sourceTypes,
        fields,
      },
    });
  });

  return app;
}
