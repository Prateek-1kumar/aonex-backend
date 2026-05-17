# Runbook — Tier 2 → Tier 1 promotion

When `schema-promotion-scan` (nightly 03:00 UTC) proposes a draft schema,
an admin reviews and either approves (promotes to authoritative) or
rejects. A UI is deferred to Phase 8; for now this runbook uses SQL.

## What the cron writes

The cron runs against `product_versions.attributes_json` aggregates and
inserts a `category_schemas` row with `tier = 'promoted_draft'` and
`active = false` when ALL of:

- ≥ 50 products in the canonical_category
- ≥ 8 attribute keys present in ≥ 80% of those products
- No existing `tier = 'authoritative'` schema for the path

The proposed `required` list is exactly those 8+ consistent keys.

## List pending drafts

```sql
SELECT
  category_path,
  schema_version,
  required_attributes,
  display_name,
  created_at
FROM category_schemas
WHERE tier = 'promoted_draft'
ORDER BY created_at DESC;
```

## Review a single draft

```sql
SELECT json_schema
FROM category_schemas
WHERE category_path = '<the path>'
  AND tier = 'promoted_draft';
```

Inspect the proposed `required` list and `properties`. Open 5–10 sample
products in that category and verify the inferred required attrs are
actually mandatory:

```sql
SELECT title, brand, attributes_json
FROM product_versions
WHERE canonical_category = '<the path>'
ORDER BY confidence_score DESC NULLS LAST
LIMIT 10;
```

## Approve

Hand-refine the schema (add unit/enum/range constraints to each
property), then promote to authoritative:

```sql
UPDATE category_schemas
SET
  tier = 'authoritative',
  active = true,
  json_schema = '<refined JSON>'::jsonb
WHERE category_path = '<the path>'
  AND tier = 'promoted_draft';
```

Then open review tasks for already-approved products in that category so
the new required list gets enforced:

```sql
INSERT INTO review_tasks (
  tenant_id, merchant_id, proposed_diff_id,
  task_type, signal_kind, severity,
  signal_payload, policy_version_id
)
SELECT
  pv.tenant_id,
  pv.merchant_id,
  NULL,                                                      -- no source diff
  'category_schema_drift',                                   -- legacy dual-write
  'category_schema_drift',                                   -- signal_kind
  'low',
  jsonb_build_object(
    'product_version_id', pv.id,
    'category_path', pv.canonical_category,
    'reason', 'New Tier 1 schema requires re-validation'
  ),
  (SELECT id FROM policy_versions WHERE active = true)
FROM product_versions pv
WHERE pv.canonical_category = '<the path>'
  AND pv.category_schema_version IS NULL;
```

## Reject

If the proposed draft is wrong (e.g., the cron was tripped by transient
duplicates), demote back to inferred:

```sql
UPDATE category_schemas
SET tier = 'inferred', active = false
WHERE category_path = '<the path>'
  AND tier = 'promoted_draft';
```

The cron will not re-propose the same draft because the row already
exists at `schema_version = 1`. To re-propose with different data, bump
`schema_version` or delete the row.

## When the cron mis-fires

The default thresholds (50/8/0.8) are conservative but can produce false
positives when:

- A small merchant publishes many products in the same niche category
  (≥ 50 products, but all from one source).
- The category has a high cardinality of optional attributes (color,
  size variants) that happen to be filled consistently.

Tune via env var override at cron registration (`apps/worker/src/jobs/schema-promotion-scan.ts`)
if false positives become noisy.

## Future work

Phase 8 will replace the SQL flow above with an admin UI that:
- Lists pending drafts with sample products inline
- Lets the admin tighten required lists/enums in a JSON editor
- One-click approves with diff-and-backfill review-task creation
- Tracks rejection reasons for audit
