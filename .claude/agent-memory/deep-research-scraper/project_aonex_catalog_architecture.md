---
name: aonex-catalog-architecture-decisions
description: Aonex committed catalog architecture - 4-layer model, Tiered Maturity, Hybrid GPT, immutable versions - for future research framing
metadata:
  type: project
---

Aonex (multi-tenant B2B SaaS, multi-million SKU catalog) has committed to the following catalog design and is NOT seeking architecture proposals, only field reconnaissance on what mature PIMs do:

**Committed decisions (do not re-litigate):**
1. **4-layer model:** Layer 1 typed universal core columns + Layer 2 typed variant columns + Layer 3 jsonb category-specific attributes validated by per-category JSON Schemas + Layer 4 marketplace listings.
2. **Tiered Schema Maturity:** Tier 1 authoritative (hand-curated, strict validation), Tier 2 inferred (LLM-extracted, permissive), Tier 3 promoted (Tier 2 → Tier 1 graduation by background job).
3. **Hybrid Google Product Taxonomy paths** with selective schema authoring at leaves.
4. **Immutable `product_versions`** with proposed_diff approval flow.

**Why:** Combines relational performance for hot-path queries with jsonb flexibility for the long tail; tiered maturity lets LLM extraction populate categories before formal specs exist.

**How to apply:**
- When asked for research/comparisons, deliver field intel on Akeneo/Salsify/Amazon/etc. — do NOT propose alternative Aonex architectures.
- Frame recommendations as "for our committed 4-layer + Tiered model, pattern X from system Y maps best because Z."
- Cite vendor docs preferred (Akeneo help, Salsify developers, Amazon SP-API, GS1, Shopify dev docs).
- Related stack signals (from prior sessions): Postgres jsonb, LLM-based ingestion pipeline (track 1 ingestion, JSON-LD/NEXT_DATA extraction).
