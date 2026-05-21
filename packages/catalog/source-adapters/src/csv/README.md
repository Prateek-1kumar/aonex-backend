# CSV Adapter

Maps a tenant-uploaded canonical CSV into canonical observations consumed by the
catalog reconciler.

`sourceKind: "csv"`. The adapter is the second-class onboarding path (alongside
link extraction and Shopify connector) — a tenant who lacks a connector and
can't share marketplace links can still bootstrap their catalog by uploading a
CSV that follows the template here (`template.csv`).

## File encoding

UTF-8 only. The adapter passes the raw string straight to `csv-parse/sync`. If
your editor saves UTF-16 / Latin-1 / Windows-1252 the byte order mark and
non-ASCII characters will be mangled — re-export from a spreadsheet as
"CSV (UTF-8)" before uploading.

## Header (required)

The first row is the header. The adapter looks up columns *by name*, so column
order is irrelevant — but every column listed in `template.csv` is expected to
exist (missing optional columns are tolerated, missing required columns throw).

```csv
primary_identifier,gtin,mpn,brand,title,category,description_long,currency,list_price,sale_price,weight_value,weight_unit,variant_color,variant_size,variant_gtin,variant_sku,variant_inventory_qty
```

## Column reference

### Required

| Column | Notes |
| --- | --- |
| `primary_identifier` | Tenant's stable parent id. Groups variant rows under one logical product. Any non-empty string — typically the parent SKU or a UUID. Must be present on **every** row. |

In addition, at least one of `title` or `brand` must be present on the first
row of each `primary_identifier` group. This is enforced by the catalog
reconciler downstream — the adapter doesn't reject rows that lack both — but
uploads without either yield products with no displayable identity.

### Parent-level (one row per parent — first row wins)

When multiple rows share the same `primary_identifier`, the adapter reads the
following columns *only from the first row in the group*. Repeating these
values on subsequent rows is harmless but ignored — they are NOT re-emitted
per row.

| Column | Meaning | Emitted as |
| --- | --- | --- |
| `gtin` | GTIN-13/14/UPC/EAN. | `identity.gtin` parent observation at `_unscoped` channel + locale (identity attributes are global). |
| `mpn` | Manufacturer Part Number. | `identity.mpn` parent observation at `_unscoped`. |
| `brand` | Brand name. | `brand` parent observation at `_unscoped`. |
| `title` | Display title. | `title` parent observation, channel-scoped. |
| `category` | Free-text category or category path. | `category` parent observation, channel-scoped. |
| `description_long` | Long-form description / marketing copy. | `description_long` parent observation, channel-scoped. |
| `weight_value` + `weight_unit` | Weight value with explicit unit (`kg`, `g`, `lb`, `oz`). Emitted as a single `weight` observation. | `weight` parent observation; unit preserved in `extras.unit`. |

### Parent-level pricing

| Column | Meaning |
| --- | --- |
| `currency` | ISO 4217 code (`AUD`, `USD`, `INR`, etc.). Per-row; if blank, `ctx.channelDefaultCurrency` is used. If both are blank, the adapter throws. |
| `list_price` | Numeric list price in `currency`. |
| `sale_price` | Numeric sale price in `currency`. |

`list_price` and `sale_price` are emitted as tiers of a single
`PricingObservation` per parent (in the first-row group). Variants inherit
the parent's pricing in v1 — see "Variant pricing" below.

### Variant-level (one row per variant)

A row is treated as a variant row if **any** of `variant_color`,
`variant_size`, `variant_gtin`, `variant_sku`, or `variant_inventory_qty` is
non-empty.

| Column | Meaning | Emitted as |
| --- | --- | --- |
| `variant_color` | Variant color (e.g. `Black`). | Axis in `variantAxes.color`. |
| `variant_size` | Variant size (e.g. `8`, `XL`). | Axis in `variantAxes.size`. |
| `variant_gtin` | Per-variant GTIN. | `identity.gtin` variant observation at `_unscoped`. |
| `variant_sku` | Per-variant SKU. | `identity.sku` variant observation, channel-scoped. |
| `variant_inventory_qty` | Integer on-hand quantity. | `InventoryObservation` per variant. |

### Variant pricing (v1)

Variants inherit the parent row's `list_price`, `sale_price`, and `currency`.
A separate pricing observation is emitted per variant carrying the same tiers
+ currency as the parent but with `variantAxes` set. v1 does NOT support
per-variant price overrides — adding `variant_list_price` / `variant_sale_price`
columns is a future enhancement.

## Grouping rules

- Rows are grouped by `primary_identifier`.
- Within a group, the **first row** contributes parent-level observations
  (title, brand, gtin, mpn, category, description_long, weight, parent pricing).
  Subsequent rows' parent-level columns are ignored.
- Every row that has any `variant_*` field set contributes a variant identity
  + inventory observation. If the first row in the group itself has variant
  fields, it contributes BOTH parent and variant observations.
- A `primary_identifier` group with zero rows carrying variant fields produces
  a parent-only product (no variants).

## Errors

| Condition | Behaviour |
| --- | --- |
| Header missing `primary_identifier` column | Throws `csvAdapter: missing required column "primary_identifier"`. |
| A row has an empty `primary_identifier` value | Throws `csvAdapter: row N: empty primary_identifier`. (N is 1-indexed, excluding the header.) |
| Currency blank on the parent row AND `ctx.channelDefaultCurrency` is null | Throws `csvAdapter: row N: pricing currency missing...`. |
| `list_price` / `sale_price` / `weight_value` / `variant_inventory_qty` non-numeric | Throws `csvAdapter: row N: ... is not a number`. |

## Source tag

The adapter stamps every observation with `source = "csv:<filename>"`. The
seed `source_glob = "csv:*"` from Task 1.11 matches any such source. The
filename is taken verbatim from `CsvAdapterInput.filename` — pick a tenant-
recognisable name when uploading (e.g. `shomed-products-2026-05.csv`) so the
provenance is human-readable in the canonical store.

`sourceRecordId` is `primary_identifier` for parent observations and
`variant_sku ?? variant_gtin ?? primary_identifier` for variant observations.

## Channel code

`CsvAdapterInput.channelCode` is optional and defaults to `"csv"`. The
`_unscoped` channel is used for global identity attributes (gtin, mpn, brand).
