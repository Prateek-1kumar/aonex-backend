# Golden set

Each `<id>.json` is one labeled product (see `src/types.ts#GoldenProduct`).
The matching recorded raw HTML lives at `rawHtmlPath` (added in Phase 0 when we
capture real fetches). Phase 0 also records `<id>.extracted.json` — the extractor
output the CLI scores against these labels.

## Add a product
1. Capture the page HTML deterministically (Phase 0 capture script) → `<id>.html`.
2. Hand-label the business-critical fields (price, identity, title, brand, category).
3. Pick `split`: `regression` (stable, never changes) or `holdout` (sampled weekly
   from live traffic, never tuned on — guards against the eval lying).
4. Run `bun run test --filter=@aonex/ingestion-eval` — the loader must report 0 errors.

## Target
~200–300 products weighted toward the pain: unknown sites, JS-heavy pages,
multi-product pages, and the catalogs of churning clients. Seed is 2; grow it.
