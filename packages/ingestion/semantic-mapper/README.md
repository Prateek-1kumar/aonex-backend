# @aonex/ingestion-semantic-mapper

Maps extracted facts onto the canonical schema.

Pipeline: deterministic mapping → synonym → embedding candidates →
type/unit/category validation → confidence scorer (`src/pipeline/scorer.ts`).

**Status:** implemented (~400 LOC). Exports `MappedFactSet` and the mapping
entry points via `src/index.ts`. See [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md)
for where this fits in the Ingestion plane.
