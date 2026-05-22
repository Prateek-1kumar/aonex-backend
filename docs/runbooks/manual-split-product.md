# Manual Split Product Runbook

**When to run.** A previous `mergeProducts` was performed in error, OR distinct products were incorrectly identified as one, AND the inverse cannot be achieved via `unmergeProduct` (e.g. the merge revision is too old or the source-of-truth has drifted).

**Authorization required:** written rationale + actor identification + on-call sign-off. Manual catalog ops are auditable and require the same discipline as merge/unmerge.

**Reference:** spec §18.2 ("Split"). Implementation: `packages/catalog/catalog-service/src/merge.ts` (`splitProduct`). Tests: `merge.test.ts` §S1–§S10.

## Cardinal invariant

`splitProduct` MOVES observations from source → new product but NEVER physically moves revisions. The source's `catalog_product_revisions` rows stay attached to the source product_id forever — moving them would corrupt the immutability guarantee. "Full history" of the new product is recovered via a UNION query (see post-checks).

## Pre-checks

1. **Identify the source product_id** + the observations that should be split out. Capture the filter dimension(s): source, source_record_id, attribute_code, channel, locale, or value.

2. **Confirm the filter is correct.** Run a dry-run query against the source product's values JSONB. Example for a source-based split:
   ```sql
   SELECT attr, channel, locale, jsonb_array_elements(observations) AS observation
   FROM (
     SELECT
       attr_kv.key AS attr,
       channel_kv.key AS channel,
       locale_kv.key AS locale,
       locale_kv.value AS observations
     FROM catalog_products,
       jsonb_each(values) attr_kv,
       jsonb_each(attr_kv.value) channel_kv,
       jsonb_each(channel_kv.value) locale_kv
     WHERE product_id = '<source_product_id>'::uuid
   ) leaves
   WHERE EXISTS (
     SELECT 1 FROM jsonb_array_elements(observations) obs
     WHERE obs->>'source' = ANY(ARRAY['amazon:link'])
   );
   ```
   Verify the result set matches your expectation. If not, refine the filter.

3. **Confirm the new identity.** Decide:
   - `primary_identifier` (must be unique within tenant — verify with
     `SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND primary_identifier = $2`).
   - `identity` JSONB shape (gtin/mpn/brand/etc.). The identity-policy gate does NOT run for splits (callers are admin-driven), so it is YOUR responsibility to ensure the identity is sensible.
   - Optional `family` and `status` (default `'draft'`).

4. **Snapshot pre-split state** for post-check comparison:
   ```sql
   SELECT
     product_id, primary_identifier, status,
     jsonb_pretty(values) AS values,
     jsonb_pretty(winning_values) AS winning_values
   FROM catalog_products WHERE product_id = '<source_product_id>'::uuid;

   SELECT count(*) AS pricing_count
   FROM catalog_pricing_observations WHERE product_id = '<source_product_id>'::uuid;

   SELECT count(*) AS inventory_count
   FROM catalog_inventory_observations WHERE product_id = '<source_product_id>'::uuid;

   SELECT count(*) AS revision_count
   FROM catalog_product_revisions WHERE product_id = '<source_product_id>'::uuid;
   ```

5. **On-call sign-off** captured in your incident ticket. Splits are NOT idempotent — calling twice creates two new products. Pause before invoking.

## Invocation

From a Node REPL or admin shell with the catalog-service package available:

```ts
import { splitProduct } from "@aonex/catalog-service";
import { db } from "./db.js";

const result = await splitProduct({
  db,
  tenantId: "<tenant_uuid>",
  sourceProductId: "<source_product_id>",
  observationFilter: {
    // Primary use case — split by source. Most splits look like this.
    sources: ["amazon:link"],
    // Optional narrows (all AND-combined):
    // sourceRecordIds: ["sku-A"],
    // attributeCodes: ["title"],          // JSONB only; pricing/inventory NOT moved.
    // valueEquals: "Some Title",          // JSONB only; pricing/inventory NOT moved.
    // channelCodes: ["amazon-us"],        // JSONB only (matches values[attr][channel] key).
    // channelIds: ["<channel_uuid>"],     // Side-tables only.
    // localeCodes: ["en_US"],             // JSONB AND pricing rows (inventory has no locale).
  },
  newIdentity: {
    primaryIdentifier: "PROD-XYZ-NEW",
    identity: { gtin: "0123456789012", brand: "ACME", identity_strength: 1.0 },
    status: "draft"
  },
  actor: "<operator_email>@aonex.com",
  rationale: "Incident #1234 — Amazon variant was incorrectly merged into Flipkart parent; restoring as distinct product."
});

console.log(JSON.stringify(result, null, 2));
```

### Filter semantics (load-bearing)

- ALL specified fields must match (AND). Unspecified fields do not constrain.
- An **empty filter** (no fields set) is rejected at the boundary with an error. To "move everything" use `mergeProducts` or a different operation; splitProduct requires explicit selection.
- `attributeCodes` and `valueEquals` are JSONB-content-specific. If either is set, pricing/inventory rows are NOT moved (those tables have no attribute_code/value columns). Splits that should also move side-tables must use source/channel/locale dimensions.
- `channelCodes` filters the values JSONB key (e.g. `"amazon-us"`). For side-tables, use `channelIds` (UUIDs); they may both appear together.

## Post-checks

1. **`result.newProductId`** exists in `catalog_products` with the expected identity:
   ```sql
   SELECT product_id, primary_identifier, identity, status, tenant_id, merchant_id
   FROM catalog_products WHERE product_id = '<result.newProductId>'::uuid;
   ```

2. **Observation counts match expectation:** `result.observationsMoved + pricingObservationsMoved + inventoryObservationsMoved` is what you predicted from the pre-check query.

3. **`product_lineage` row exists**:
   ```sql
   SELECT * FROM product_lineage WHERE lineage_id = <result.lineageId>;
   ```
   Should show `operation='split'`, `origin_product_id=<source>`, `product_id=<new>`, `split_filter=<your filter>`, `rationale`, `actor`.

4. **`catalog.product.split` event emitted**:
   ```sql
   SELECT * FROM catalog_events WHERE event_id = <result.eventId>;
   ```
   `event_type='catalog.product.split'`, `product_id=<new>`, payload carries `sourceProductId`, `newProductId`, `splitFilter`, `actor`, `rationale`, `lineageId`, `sourceRevisionId`, `newRevisionId`.

5. **`winning_values` on both products** is current. `splitProduct` calls `projectSync` for the union of touched attribute codes on BOTH source and new before committing — verify by reading the rows:
   ```sql
   SELECT product_id, jsonb_pretty(winning_values)
   FROM catalog_products
   WHERE product_id IN ('<source>'::uuid, '<new>'::uuid);
   ```

6. **Source's prior revisions are unchanged in count** (only a `manual_split` revision was added — never moved):
   ```sql
   SELECT count(*) FROM catalog_product_revisions
   WHERE product_id = '<source>'::uuid;
   -- should equal <pre-split count> + 1
   ```

7. **Two `manual_split` revision rows exist** (one on source, one on new):
   ```sql
   SELECT product_id, revision_id, revision_reason, diff
   FROM catalog_product_revisions
   WHERE revision_reason = 'manual_split'
     AND revision_id IN (<result.splitRevisionIds.source>, <result.splitRevisionIds.new>);
   ```
   The new product's row carries `diff.lineage_pointer.source_revision = <source revision id>` (spec §18.2 step 6).

8. **Full-history union query.** This is the canonical query for reading the new product's complete history (forward revisions + the source-attached history that logically belongs to it):
   ```sql
   SELECT revision_id, product_id, revision_reason, ingested_at, diff
   FROM catalog_product_revisions
   WHERE product_id = '<new>'::uuid
   UNION ALL
   SELECT revision_id, product_id, revision_reason, ingested_at, diff
   FROM catalog_product_revisions
   WHERE product_id = '<source>'::uuid
   ORDER BY ingested_at;
   ```
   **v1 limitation:** a revision row has no per-observation breakdown, so the source-side selection cannot be filtered to "only revisions logically belonging to the new product." The union returns ALL revisions of source + all revisions of new and lets the consumer decide. This is documented in spec §18.2 and tested in `merge.test.ts §S8`.

9. **`_current` rows on source** were deleted as part of split (filter-aware deletion is complex; the async reconciler rebuilds from observation layout). Confirm:
   ```sql
   SELECT count(*) FROM catalog_pricing_current WHERE product_id = '<source>'::uuid;
   -- expected: 0 (will repopulate when the async reconciler next runs)
   ```

## Roll-back

There is **no `unsplit` operation in v1.** Splits are designed to be permanent — the spec accepts this asymmetry because the merge / unmerge pair already covers reversible duplicate collapse. If the split was wrong, options are:

- **Merge inverse.** Run `mergeProducts(sourceProductId, [newProductId], actor, rationale)` to merge the new product back into source. Caveat: a new lineage row will appear; the original `operation='split'` row stays for the audit trail.
- **Manual SQL.** Re-INSERT specific observations via raw SQL. Requires DBA approval and an incident ticket. Side-table rows can be moved back by `UPDATE catalog_pricing_observations SET product_id = '<source>' WHERE product_id = '<new>'` (similar for inventory). Revision rows must NOT be touched.

> **Composition hazard.** If the source product was previously the winner of a `mergeProducts` call and you split observations that were originally moved in by that merge, a subsequent `unmergeProduct` of the original merge will NOT restore those split-off observations to the original loser — they'll stay on the post-split new product. Plan splits AFTER unmerge-window expiry, or accept the new lineage as authoritative.

## Record-keeping

Append this entry to the incident log (`docs/incidents/...` or your team's equivalent):

- Date / actor / rationale.
- `sourceProductId` → `newProductId`.
- Observation counts: `result.observationsMoved`, `result.pricingObservationsMoved`, `result.inventoryObservationsMoved`.
- `result.lineageId`, `result.eventId`, `result.splitRevisionIds.source`, `result.splitRevisionIds.new`.
- Link to the `splitProduct` invocation logs and on-call sign-off.
