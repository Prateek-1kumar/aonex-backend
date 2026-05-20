# @aonex/types

Shared branded ID types, domain enums, and cross-cutting value types used across every package in the monorepo.

## Exports

- **Branded IDs** — `TenantId`, `MerchantId`, `ConnectionId`, `ArtifactId`, `WebhookId`, `ProductId`, `ProductVersionId`, `ProductVariantId`, `ProposedDiffId`, `ExtractionRunId`, `FactSetId`, `CategoryPath`, `CanonicalKey` — each exposes `.parse()` (validates) and `.unsafeFrom()` (cast)
- **Marketplace** — `MARKETPLACES`, `Marketplace`, `isMarketplace()`, `MARKETPLACE_PHASE`
- **Other** — `GatewayError`, job/retry/JWT/webhook types, env-var types

## How it fits

Zero-dependency leaf package. Every other `@aonex/*` package imports from here to avoid primitive obsession at compile time.

## Dependencies

None (only `zod` as an external dependency).
