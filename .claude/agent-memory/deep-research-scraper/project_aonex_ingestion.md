---
name: project_aonex_ingestion
description: Aonex unified product ingestion pipeline — 3 lanes (link/CSV/marketplace), tiered canonical catalog, per-field provenance + confidence
metadata:
  type: project
---

Aonex is designing a unified product ingestion pipeline with three lanes — link extraction, CSV import, marketplace sync — feeding a canonical relational catalog with per-category JSON Schema validation. Outputs are tiered (Tier 1/2/3) with provenance and per-field confidence. Approval workflow uses proposed-diffs, auto-approve thresholds, and an Anomaly Lab for low-confidence review. Multi-tenant B2B SaaS.

**Why:** Audience is the senior engineer designing testing, monitoring, and feedback layers. They want field reconnaissance on quality + ops patterns, NOT Aonex-specific code or architecture.

**How to apply:**
- Frame quality / observability research around the 3-lane + tiered catalog + diff/approval design.
- Always reference per-field confidence + provenance as the unit of measurement (not "row accuracy").
- Multi-tenant slicing (per tenant, per source-type, per category, per domain) is mandatory for any metric.
- See [[reference_extraction_quality_sources]] for authoritative sources to revisit.
