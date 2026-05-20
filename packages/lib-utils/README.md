# @aonex/lib-utils

General-purpose utility functions shared across the monorepo — hashing, URL normalization, unit conversion, backoff, and clock helpers.

## Exports

- `sha256Hex(input)` / `sha256Canonical(value)` — SHA-256 helpers for content addressing
- `canonicalizeUrl(input)` — strips tracking params, normalizes hostname and path; `domainOf(input)`
- `convertToCanonical(value, unit, dim)` / `canonicalUnitFor(dim)` — unit conversion (length, mass, volume, energy, power, frequency)
- `backoffWithJitter(attempt, baseMs, capMs)` / `sleep(ms, signal?)` — full-jitter exponential backoff
- `canonicalStringify(value)` — key-stable JSON serialization
- `removeNangoMetadata(obj)` — strips internal Nango fields before storing

## How it fits

Used by `apps/api`, `apps/worker`, and most `@aonex/*` domain packages. Pure functions with no side effects; safe to import anywhere.

## Dependencies

None (`@aonex/*`-free; only Node built-ins).
