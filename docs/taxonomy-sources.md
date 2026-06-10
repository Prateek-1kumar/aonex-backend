# Taxonomy reference sources & licenses (P0 Task 1)

Decision record for the multi-source attribute-schema merge. Sources are ingested **once as a seed**
into our own tables; not a runtime dependency.

| Source | Use | License / terms | Verdict |
| --- | --- | --- | --- |
| **Shopify Standard Product Taxonomy** | primary attribute sets + value sets; tree-depth reference | **MIT** (confirmed in repo `LICENSE`) — commercial use OK, keep copyright notice | ✅ **Use.** Pin stable release **2026-02** (we initially pulled `-unstable`; switch to the pinned stable). |
| **Google Product Taxonomy** | `export` mapping (feed correctness) | Published by Google for Merchant Center; freely used/vendored industry-wide | ✅ **Use** (it is our export target regardless). v2021-09-21 (frozen). |
| **Amazon category requirements** | reference checklist for required/recommended attributes in priority verticals | Not an openly-licensed dataset | ⚠️ **Checklist only** — use attribute *names/ideas* to sanity-check completeness; do **not** vendor raw Amazon data. |
| **GS1 GPC** | optional enrichment of attribute coverage | Royalty-free for **GS1 members**; non-member redistribution terms unclear | ⛔ **Deferred** for P0 — do not vendor until membership/terms confirmed. The Shopify+Google floor is sufficient. |

**Net P0 merge floor:** Shopify (MIT, primary) + Google (free, export) + Amazon (checklist). GS1 GPC
revisited later if we confirm clean access. This satisfies the spec rule "any source with restrictive
terms is dropped from the merge; the remaining ones still give a strong floor."

Pinned Shopify release: **2026-02** — files vendored under `seed/taxonomy/refs/shopify/` at seed time.
