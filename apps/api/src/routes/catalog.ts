import { Hono } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { MerchantId, TenantId } from "@aonex/types";
import { convertFromFacts, type SkuJson } from "@aonex/ingestion-enrichment";

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

    // Rich-only mode: when persisted images is empty (rows promoted before
    // the image-leak fix), recompute thumbnails from extractedFacts so the
    // list view lights up without re-ingesting. We do this in a single batched
    // query for all stale rows to keep the list endpoint O(1) DB roundtrips
    // regardless of product count.
    const staleRows = hydrated.filter(
      (r) =>
        r.current_version &&
        Array.isArray(r.current_version.images) &&
        r.current_version.images.length === 0 &&
        r.current_version.proposedDiffId
    );

    if (staleRows.length > 0) {
      const diffIds = staleRows.map((r) => r.current_version!.proposedDiffId as string);
      const diffs = await deps.db
        .select({ id: schema.proposedDiffs.id, factSetId: schema.proposedDiffs.sourceFactSetId })
        .from(schema.proposedDiffs)
        .where(inArray(schema.proposedDiffs.id, diffIds));

      const factSetIds = diffs.map((d) => d.factSetId).filter((id): id is string => Boolean(id));

      if (factSetIds.length > 0) {
        // Single query: all image_url / images facts for every stale row.
        const factRows = await deps.db
          .select()
          .from(schema.extractedFacts)
          .where(
            and(
              inArray(schema.extractedFacts.factSetId, factSetIds),
              inArray(schema.extractedFacts.rawKey, ["image_url", "images"])
            )
          );

        // Index facts by factSetId.
        const byFactSet = new Map<string, typeof factRows>();
        for (const f of factRows) {
          const arr = byFactSet.get(f.factSetId) ?? [];
          arr.push(f);
          byFactSet.set(f.factSetId, arr);
        }

        // Index diff → factSet.
        const diffToFactSet = new Map(diffs.map((d) => [d.id, d.factSetId]));

        for (const row of staleRows) {
          const diffId = row.current_version!.proposedDiffId as string;
          const factSetId = diffToFactSet.get(diffId);
          if (!factSetId) continue;
          const facts = byFactSet.get(factSetId) ?? [];

          // Prefer plural "images" array fact if present; else aggregate image_url facts.
          const plural = facts.find((f) => f.rawKey === "images");
          const pluralValue = plural?.normalizedValue ?? plural?.extractedValue;
          let images: Array<{ url: string; altText?: string }> = [];
          if (Array.isArray(pluralValue)) {
            images = pluralValue.flatMap((it) => {
              if (!it || typeof it !== "object") return [];
              const obj = it as Record<string, unknown>;
              const url = typeof obj.url === "string" ? obj.url : null;
              if (!url) return [];
              const alt = obj.altText ?? obj.alt ?? obj.alt_text;
              return [
                typeof alt === "string" && alt.trim()
                  ? { url, altText: alt }
                  : { url },
              ];
            });
          }
          if (images.length === 0) {
            images = facts
              .filter((f) => f.rawKey === "image_url")
              .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))
              .flatMap((f) => {
                const v = (f.normalizedValue ?? f.extractedValue) as unknown;
                const url = typeof v === "string" ? v : null;
                if (!url || !/^https?:\/\//i.test(url)) return [];
                return [{ url }];
              });
          }
          // Dedupe + cap at 12 for list rendering.
          const seen = new Set<string>();
          const deduped: Array<{ url: string; altText?: string }> = [];
          for (const img of images) {
            if (seen.has(img.url)) continue;
            seen.add(img.url);
            deduped.push(img);
            if (deduped.length >= 12) break;
          }
          if (deduped.length > 0 && row.current_version) {
            row.current_version = { ...row.current_version, images: deduped };
          }
        }
      }
    }

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

  /**
   * GET /products/:id/sku — rebuild the rich SkuJson for a catalog product.
   *
   * Walks: product → currentVersionId → proposedDiff → sourceFactSet →
   * extractedFacts → convertFromFacts(facts, sourceUrl). Computed on-demand
   * (rather than persisted on product_versions) so no DB migration is needed
   * and the rendering always reflects the latest enrichment logic.
   */
  app.get("/products/:id/sku", async (c) => {
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

    if (!product.currentVersionId) {
      return c.json({ data: { sku: null } });
    }

    const version = await deps.db.query.productVersions.findFirst({
      where: (v, { eq }) => eq(v.id, product.currentVersionId as string),
    });
    if (!version || !version.proposedDiffId) {
      return c.json({ data: { sku: null } });
    }

    const diff = await deps.db.query.proposedDiffs.findFirst({
      where: (d, { eq }) => eq(d.id, version.proposedDiffId as string),
    });
    if (!diff?.sourceFactSetId) {
      return c.json({ data: { sku: null } });
    }

    let sku: SkuJson | null = null;
    try {
      const factRows = await deps.db
        .select()
        .from(schema.extractedFacts)
        .where(eq(schema.extractedFacts.factSetId, diff.sourceFactSetId));

      const facts = factRows.map((r) => ({
        rawKey: r.rawKey,
        canonicalPath: r.canonicalPath ?? null,
        extractedValue: r.extractedValue,
        normalizedValue: r.normalizedValue,
        unit: r.unit ?? null,
        sourcePointer: r.sourcePointer ?? "",
        extractionMethod: r.extractionMethod ?? null,
        mappingMethod: r.mappingMethod ?? null,
        mappingCandidates: r.mappingCandidates ?? null,
        sourceAlternatives: r.sourceAlternatives ?? null,
        confidence: r.confidence != null ? Number(r.confidence) : 0,
        approved: r.approved ?? false,
      }));

      // Recover sourceUrl from the diff's source artifact (via extraction_run).
      const factSet = await deps.db.query.extractedFactSets.findFirst({
        where: (f, { eq }) => eq(f.id, diff.sourceFactSetId as string),
      });
      let finalUrl = "";
      let ogImage: string | null = null;
      if (factSet?.extractionRunId) {
        const run = await deps.db.query.extractionRuns.findFirst({
          where: (r, { eq }) => eq(r.id, factSet.extractionRunId),
        });
        if (run?.artifactId) {
          const artifact = await deps.db.query.sourceArtifacts.findFirst({
            where: (a, { eq }) => eq(a.id, run.artifactId),
          });
          finalUrl = artifact?.sourceExternalId ?? "";
          ogImage =
            ((artifact?.rawData as { ogImage?: string | null } | null) ?? {}).ogImage ?? null;
        }
      }

      sku = convertFromFacts(facts as never, finalUrl, { ogImage });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[catalog] failed to rebuild SkuJson:", err);
    }

    return c.json({ data: { sku } });
  });

  return app;
}
