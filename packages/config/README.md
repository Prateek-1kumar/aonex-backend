# @aonex/config

Shared ESLint and TypeScript configuration presets for the monorepo — placeholder directories for future shared configs.

## Exports

No runtime exports. This package holds configuration scaffolding:

- `eslint/` — ESLint flat-config preset (directory reserved; currently empty)
- `tsconfig/` — TypeScript project reference preset (directory reserved; currently empty)

The active shared tsconfig lives at the repo root as `tsconfig.base.json` (ES2022, strict, `noUncheckedIndexedAccess`, composite/incremental, Bun types).

## How it fits

Referenced by each package's `tsconfig.json` via `extends`. No application code depends on this package at runtime.

## Dependencies

None.
