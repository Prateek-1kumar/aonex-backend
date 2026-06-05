#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/backfill-completeness-scores.ts
//
// Catalog enrichment Phase 0 — populate completeness_score + score_breakdown for
// existing catalog_products. Going forward the reconciler (projectSync) keeps
// them fresh on every winning_values change; this one-shot covers rows written
// before that wiring existed. Idempotent: recomputes and overwrites.

import { sql, eq } from "drizzle-orm";
import { createDb, schema } from "@aonex/db";
import { computeCompletenessScore } from "@aonex/catalog-service";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { client, close } = createDb(databaseUrl);
try {
  const rows = await client
    .select({
      productId: schema.catalogProducts.productId,
      family: schema.catalogProducts.family,
      identifiers: schema.catalogProducts.identifiers,
      winningValues: schema.catalogProducts.winningValues,
      genPrice: sql<string | null>`gen_primary_price`,
      genCurrency: sql<string | null>`gen_primary_currency`,
      genGtin: sql<string | null>`gen_gtin`,
      genTitle: sql<string | null>`gen_title`,
    })
    .from(schema.catalogProducts);

  let updated = 0;
  for (const r of rows) {
    const identifiers = r.identifiers;
    const hasIdentifier =
      r.genGtin != null || (Array.isArray(identifiers) && identifiers.length > 0);
    const score = computeCompletenessScore({
      family: r.family ?? null,
      winningValues: (r.winningValues ?? {}) as Record<string, unknown>,
      hasPrice: r.genPrice != null,
      hasCurrency: r.genCurrency != null,
      hasIdentifier,
      hasTitle: r.genTitle != null,
    });
    await client
      .update(schema.catalogProducts)
      .set({
        completenessScore: score.percent.toFixed(2),
        scoreBreakdown: score,
      })
      .where(eq(schema.catalogProducts.productId, r.productId));
    updated++;
  }
  console.log(`Backfilled completeness_score for ${updated} products`);
} catch (err) {
  console.error("Failed to backfill scores:", err);
  process.exit(2);
} finally {
  await close();
}
