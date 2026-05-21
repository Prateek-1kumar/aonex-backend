#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/bootstrap-channels.ts
//
// Catalog redesign Phase 1 — Task 1.12.
// See /Users/prateekkumar/docs/superpowers/plans/2026-05-21-catalog-redesign.md
// lines 898-925.
//
// Bootstraps `channels` (and a default `inventory_locations`) per tenant from
// existing `marketplace_connections` and recent link-derived `source_artifacts`.
// Local-only, idempotent — NO external network calls. Designed to be safe to
// re-run.
//
// Algorithm:
//   1. For each tenant with a Shopify connection (marketplace='shopify'),
//      INSERT a channels row (channel_kind='shopify', region=derived,
//      account_ref=<shop_domain>) iff not already present.
//   2. For each tenant with link_url source_artifacts in the last 30 days,
//      INSERT one channel per (channel_kind from URL domain, region from TLD)
//      iff not already present. Unknown domains are logged + skipped.
//   3. For each Shopify channel created in step 1 (or pre-existing without a
//      location), INSERT a default inventory_locations row
//      (kind='default', external_ref=null). NOTE: a future Phase 8 task will
//      wire the real Shopify Locations API; this script intentionally stays
//      offline.
//
// Idempotency:
//   - channels: uses uq_channels (tenant_id, channel_kind, region, account_ref)
//     with NULLS NOT DISTINCT — onConflictDoNothing handles re-runs.
//   - inventory_locations: no natural unique constraint; we explicitly check
//     for any existing location row per channel before inserting (one default
//     per channel is the invariant we maintain).

import { and, eq, gte, sql } from "drizzle-orm";
import { createDb, schema, type DrizzleClient } from "@aonex/db";

// ---------------------------------------------------------------------------
// Mapping constants — documented heuristics.
// ---------------------------------------------------------------------------

/**
 * Bare-domain → channel_kind mapping. Keys are the registrable apex (or
 * second-level + TLD) — we strip leading "www." and compare. Unknown apex
 * domains are logged + skipped rather than inventing a channel_kind.
 *
 * NOTE: channels.channel_kind is `text`, not the `marketplace` pg enum, so
 * values like 'woolworths'/'jbhifi'/'bunnings' (not in marketplaceEnum) are
 * acceptable here — they're the canonical channel-kind strings per the spec.
 */
const DOMAIN_KIND_RULES: Array<{ match: RegExp; channelKind: string }> = [
  // Amazon — all regional variants collapse to one kind.
  { match: /^amazon\.(com|com\.au|co\.uk|de|fr|in|co\.jp|ca|it|es)$/, channelKind: "amazon" },
  // eBay — same.
  { match: /^ebay\.(com|com\.au|co\.uk|de|fr|in|ca)$/, channelKind: "ebay" },
  { match: /^flipkart\.com$/, channelKind: "flipkart" },
  { match: /^walmart\.com$/, channelKind: "walmart" },
  { match: /^woolworths\.com\.au$/, channelKind: "woolworths" },
  { match: /^jbhifi\.com\.au$/, channelKind: "jbhifi" },
  { match: /^bunnings\.com\.au$/, channelKind: "bunnings" },
  { match: /^catch\.com\.au$/, channelKind: "catch" },
  { match: /^kmart\.com\.au$/, channelKind: "kmart" },
  { match: /^myntra\.com$/, channelKind: "myntra" },
];

/**
 * TLD → region (ISO 3166-1 alpha-2). Deliberately small + explicit; new
 * regions should be added consciously, not inferred.
 */
const TLD_REGION_RULES: Array<{ suffix: string; region: string }> = [
  { suffix: ".com.au", region: "AU" },
  { suffix: ".co.uk", region: "UK" },
  { suffix: ".co.jp", region: "JP" },
  { suffix: ".co.in", region: "IN" },
  { suffix: ".com.sg", region: "SG" },
  { suffix: ".de", region: "DE" },
  { suffix: ".fr", region: "FR" },
  { suffix: ".in", region: "IN" },
  { suffix: ".ca", region: "CA" },
  { suffix: ".it", region: "IT" },
  { suffix: ".es", region: "ES" },
  { suffix: ".com", region: "US" }, // fallback for generic gTLD
];

/**
 * Shopify region heuristic. `shop_domain` is almost always
 * `<slug>.myshopify.com` with no country signal in the bare hostname; we
 * default to 'AU' (the primary aonex tenant region today). If the
 * connection's metadata grows a `country` / `region` hint in the future,
 * derive from there before falling back to this default.
 */
const SHOPIFY_DEFAULT_REGION = "AU";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function deriveRegionFromHostname(hostname: string): string | null {
  const host = hostname.toLowerCase();
  for (const { suffix, region } of TLD_REGION_RULES) {
    if (host.endsWith(suffix)) return region;
  }
  return null;
}

function deriveChannelKindFromHostname(hostname: string): string | null {
  const apex = stripWww(hostname);
  for (const { match, channelKind } of DOMAIN_KIND_RULES) {
    if (match.test(apex)) return channelKind;
  }
  return null;
}

function deriveShopifyRegion(shopDomain: string | null): string {
  // Future hook: parse connection metadata for an explicit region. For now we
  // can't reliably read country from a *.myshopify.com hostname, so fall back
  // to the default.
  void shopDomain;
  return SHOPIFY_DEFAULT_REGION;
}

function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Shopify channels.
// ---------------------------------------------------------------------------

async function bootstrapShopifyChannels(db: DrizzleClient): Promise<number> {
  // Pull distinct (tenant_id, shop_domain) from active-ish marketplace
  // connections. We don't filter by status — even pending/refresh_failing
  // tenants should have a channel registered so downstream observations can
  // attach. revoked/deleted are excluded.
  const rows = await db
    .selectDistinct({
      tenantId: schema.marketplaceConnections.tenantId,
      shopDomain: schema.marketplaceConnections.shopDomain,
    })
    .from(schema.marketplaceConnections)
    .where(eq(schema.marketplaceConnections.marketplace, "shopify"));

  const candidates = rows.filter((r) => {
    if (!r.shopDomain) {
      console.warn(
        `[bootstrap-channels] skipping shopify connection for tenant=${r.tenantId} — no shop_domain set yet`
      );
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    console.log("[bootstrap-channels] Found 0 Shopify connections; no channels created");
    return 0;
  }

  let created = 0;
  for (const row of candidates) {
    const shopDomain = row.shopDomain!;
    const region = deriveShopifyRegion(shopDomain);
    const inserted = await db
      .insert(schema.channels)
      .values({
        tenantId: row.tenantId,
        channelKind: "shopify",
        region,
        accountRef: shopDomain,
        displayName: `Shopify (${shopDomain})`,
      })
      .onConflictDoNothing({
        target: [
          schema.channels.tenantId,
          schema.channels.channelKind,
          schema.channels.region,
          schema.channels.accountRef,
        ],
      })
      .returning({ channelId: schema.channels.channelId });
    if (inserted.length > 0) created += 1;
  }
  console.log(
    `[bootstrap-channels] Shopify: examined ${candidates.length} connections, created ${created} channels`
  );
  return created;
}

// ---------------------------------------------------------------------------
// Step 2: Link-derived channels.
// ---------------------------------------------------------------------------

async function bootstrapLinkChannels(db: DrizzleClient): Promise<number> {
  // "Last 30 days" measured against received_at — that's the indexed
  // ingestion-side timestamp. modified_at is null for link_url today.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      tenantId: schema.sourceArtifacts.tenantId,
      sourceExternalId: schema.sourceArtifacts.sourceExternalId,
    })
    .from(schema.sourceArtifacts)
    .where(
      and(
        eq(schema.sourceArtifacts.sourceType, "link_url"),
        gte(schema.sourceArtifacts.receivedAt, cutoff)
      )!
    );

  if (rows.length === 0) {
    console.log(
      "[bootstrap-channels] Found 0 link_url source_artifacts in the last 30 days; no link channels created"
    );
    return 0;
  }

  // Deduplicate (tenant_id, channelKind, region) in-process before insert.
  type Key = string;
  const seen = new Map<Key, { tenantId: string; channelKind: string; region: string; sampleHost: string }>();
  const unknownDomains = new Set<string>();

  for (const row of rows) {
    const host = parseHostname(row.sourceExternalId);
    if (!host) {
      console.warn(
        `[bootstrap-channels] skipping artifact for tenant=${row.tenantId} — unparseable URL: ${row.sourceExternalId}`
      );
      continue;
    }
    const channelKind = deriveChannelKindFromHostname(host);
    const region = deriveRegionFromHostname(host);
    if (!channelKind || !region) {
      unknownDomains.add(stripWww(host));
      continue;
    }
    const key = `${row.tenantId}::${channelKind}::${region}`;
    if (!seen.has(key)) {
      seen.set(key, { tenantId: row.tenantId, channelKind, region, sampleHost: host });
    }
  }

  if (unknownDomains.size > 0) {
    console.log(
      `[bootstrap-channels] skipped ${unknownDomains.size} unknown domain(s) (no mapping): ${Array.from(unknownDomains).sort().join(", ")}`
    );
  }

  if (seen.size === 0) {
    console.log(
      "[bootstrap-channels] No mappable link_url domains found; no link channels created"
    );
    return 0;
  }

  let created = 0;
  for (const entry of seen.values()) {
    const inserted = await db
      .insert(schema.channels)
      .values({
        tenantId: entry.tenantId,
        channelKind: entry.channelKind,
        region: entry.region,
        accountRef: null,
        displayName: `${entry.channelKind} (${entry.region})`,
      })
      .onConflictDoNothing({
        target: [
          schema.channels.tenantId,
          schema.channels.channelKind,
          schema.channels.region,
          schema.channels.accountRef,
        ],
      })
      .returning({ channelId: schema.channels.channelId });
    if (inserted.length > 0) created += 1;
  }
  console.log(
    `[bootstrap-channels] Link: examined ${rows.length} artifacts → ${seen.size} (tenant,kind,region) buckets, created ${created} channels`
  );
  return created;
}

// ---------------------------------------------------------------------------
// Step 3: Default inventory_locations for Shopify channels.
// ---------------------------------------------------------------------------

async function bootstrapDefaultLocations(db: DrizzleClient): Promise<number> {
  // For each Shopify channel that has NO inventory_locations row, insert one
  // default. We deliberately do NOT hit Shopify's Locations API here — that's
  // a Phase 8 follow-up. Default location uses kind='default',
  // external_ref=null so the future API-driven sync can distinguish bootstrap
  // rows from real ones.
  const shopifyChannels = await db
    .select({
      channelId: schema.channels.channelId,
      tenantId: schema.channels.tenantId,
    })
    .from(schema.channels)
    .where(eq(schema.channels.channelKind, "shopify"));

  if (shopifyChannels.length === 0) {
    console.log("[bootstrap-channels] No Shopify channels; no default locations created");
    return 0;
  }

  // Find channels that already have any inventory_location — those are skipped.
  const channelIds = shopifyChannels.map((c) => c.channelId);
  const existing = await db
    .select({ channelId: schema.inventoryLocations.channelId })
    .from(schema.inventoryLocations)
    .where(sql`${schema.inventoryLocations.channelId} = ANY(${channelIds})`);
  const channelsWithLocations = new Set(existing.map((e) => e.channelId));

  const toInsert = shopifyChannels.filter((c) => !channelsWithLocations.has(c.channelId));
  if (toInsert.length === 0) {
    console.log(
      `[bootstrap-channels] Locations: all ${shopifyChannels.length} Shopify channels already have a location; 0 created`
    );
    return 0;
  }

  const inserted = await db
    .insert(schema.inventoryLocations)
    .values(
      toInsert.map((c) => ({
        channelId: c.channelId,
        tenantId: c.tenantId,
        kind: "default",
        externalRef: null,
        displayName: "Default Location",
      }))
    )
    .returning({ locationId: schema.inventoryLocations.locationId });

  console.log(
    `[bootstrap-channels] Locations: ${shopifyChannels.length} Shopify channels, ${toInsert.length} needed defaults, created ${inserted.length}`
  );
  return inserted.length;
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const { client, close } = createDb(databaseUrl);
  try {
    const shopifyCreated = await bootstrapShopifyChannels(client);
    const linkCreated = await bootstrapLinkChannels(client);
    const locationsCreated = await bootstrapDefaultLocations(client);
    console.log(
      `[bootstrap-channels] Done: ${shopifyCreated} shopify channels, ${linkCreated} link channels, ${locationsCreated} default locations`
    );
  } catch (err) {
    console.error("[bootstrap-channels] Failed:", err);
    process.exit(2);
  } finally {
    await close();
  }
}

await main();
