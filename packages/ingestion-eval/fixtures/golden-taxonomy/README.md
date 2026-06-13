# Golden taxonomy + enrichment set

The **answer key** for the taxonomy classifier and the enrichment engine. Each
entry pairs a deliberately messy product `input` with the human-verified `gold`
truth. The evals score against this set; a number is only as trustworthy as the
labels here, so labels are **human-verified**, never auto-generated.

## Layout

One file per department under `products/` (electronics, fashion, home-and-kitchen,
beauty, general, out-of-taxonomy). `scripts/eval/load-golden-yaml.ts` globs +
flattens them. Add a file → it's picked up automatically. Split by department so
the set stays reviewable and merge-conflict-free as it grows.

## Entry shape

```yaml
- id: e01                                   # unique across ALL files
  input:                                    # what the pipeline receives (messy on purpose)
    title: "Apple iPhone 15 128GB Black"
    brand: Apple
    sourceCategory: "Cell Phones"
    attrs: { storage: 128GB }               # any already-known attrs
  gold:
    node_id: electronics/.../mobile-phones  # the correct canonical leaf, or ABSTAIN
    attrs: { brand: Apple, storage: 128GB }  # expected NORMALIZED, enum-conforming values
```

### Rules for `gold.attrs`

- Use the **canonical normalized value** (enum casing, e.g. `Large (L)`, `Black`,
  `5G`), not the raw input form.
- Only include values that are **extractable/groundable from the input** (title,
  brand, source category, known attrs). The enrichment eval scores attribute
  accuracy against the *auto-applied* (grounded) set; inference-only values like
  `iPhone 15 → os: iOS` are not auto-applied, so listing them would unfairly
  penalize the score. Test extraction here, not world knowledge.
- `ABSTAIN` entries (no valid leaf exists) carry **no** `gold.attrs`.

## Certify conformance

```
set -a; . ./.env; set +a
bun run validate-golden
```

This checks every `gold.node_id` is a real leaf and every `gold.attrs` key/enum/
unit conforms to the **live** leaf schema (`loadLeafSchemas` — the same schema the
eval scores against). It catches the *conformance* class of errors mechanically,
so human review only has to confirm *truthfulness* (is the iPhone actually 128GB?).

## Status & path to ~150

Currently **75** entries (a department-balanced expansion of the original 36, with
`gold.attrs` backfilled where extractable). To reach ~150: keep adding entries to
the per-department files (or new department files), favouring the deep-spine
categories that have historically misclassified, then run `validate-golden` after
each batch and have a human confirm truthfulness before the labels count.
