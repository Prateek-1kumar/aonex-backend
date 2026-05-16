---
name: pim-vendor-doc-sources
description: Authoritative URLs for PIM/catalog research - Akeneo, Salsify, Amazon SP-API, Pimcore, inriver, Bloomreach, GS1, Shopify
metadata:
  type: reference
---

**Primary docs to hit first for PIM/catalog research (verified live 2026-05-16):**

- **Akeneo:** help.akeneo.com (functional/serenity), docs.akeneo.com (older platform), api.akeneo.com (REST+GraphQL ref). Reference Entities and Family Variants are their key abstractions. Versioning lives in `pim_versioning_version` table.
- **Salsify:** developers.salsify.com (PXM REST+GraphQL), salsify.com/blog/engineering (GraphQL schema conventions post is high-quality).
- **Amazon SP-API Product Type Definitions:** developer-docs.amazon.com/sp-api/docs/product-type-definitions-api and meta-schema at schemas.amazon.com/selling-partners/definitions/product-types/meta-schema/v1. Uses JSON Schema 2019-09 with custom vocabulary. `productTypeVersion=LATEST` default; RELEASE_CANDIDATE for prerelease.
- **Pimcore:** docs.pimcore.com/platform/Pimcore/Objects/ — class definitions generate concrete tables, Object Variants require inheritance enabled.
- **inriver:** community.inriver.com (entity-agnostic "elastic data model"), sivertbertelsen.dk has independent technical reviews.
- **Bloomreach Discovery:** documentation.bloomreach.com/discovery/ — product JSON with variants[] and views[], 1KB attribute value limit.
- **Shopify:** shopify.dev/docs/apps/build/metafields — standard metafield definitions, list-of-data-types is the canonical type reference.
- **Google Merchant Center:** support.google.com/merchants — product data spec, category-specific required attributes (e.g., color required for apparel).
- **GS1 GDSN/GPC:** gs1.org/standards/gpc — 4-tier classification (Segment→Family→Class→Brick); gs1.org/edi-xml/technical-user-guide/gs1-xml-versioning for major/minor/patch versioning conventions.
- **Walmart Global Tech blog:** tech.walmart.com — LLM-based attribute extraction with two-stage extract/verify pipeline (PC→PF→PT taxonomy).
- **Wayfair tech blog:** aboutwayfair.com/careers/tech-blog — Snorkel-based tagging, LLM style classification.

**How to apply:**
- Prefer vendor primary docs over reseller/agency blogs.
- For schema-evolution war stories, Medium has strong 2025-26 incident write-ups (Reliable Data Engineering, Tech with Abhishek authors).
- Independent technical reviews on sivertbertelsen.dk give honest data-model breakdowns of commercial PIMs.
