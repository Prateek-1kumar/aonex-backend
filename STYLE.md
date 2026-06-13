# STYLE.md — Refactor Style Guide (read this first)

This is a **behavior-preserving cleanliness pass**. The running program must be
byte-for-byte equivalent in behavior before and after. Every change must be
justifiable as: comment, doc, naming, file organization, dead-code removal,
formatting, or test organization — nothing else.

## RULE ZERO — No behavior change (non-negotiable)
Do NOT change: control flow, conditions, numeric constants, default values,
thresholds, LLM prompt strings, SQL, DB migrations, env var names, queue/job names,
API request/response shapes, or any public function/type signature (unless a rename
is propagated repo-wide AND all checks stay green). No bug fixes, no features, no
dependency or architecture changes. If you spot a real bug, DO NOT fix it — record it
in `REFRACTOR_NOTES.md` and move on.

## Comments — the standard (apply identically everywhere)

1. **File header**: every source file opens with a `//` docblock of **AT MOST 3–4
   lines** — what the file is + its single responsibility + (only if non-obvious) one
   "why"/invariant line. No phase/ticket/spec citations ("Phase 6", "P2 Task 9",
   "HLD §10", "Spec §14.3", "Task 5"), no ASCII art, no changelog/author/date.
   In files starting with `"use client"` or a shebang, that line stays first; the
   header goes immediately after it.

   Example:
   ```ts
   // Grounded enrichment engine: fills a leaf's attribute schema from the product's
   // own data, then deterministically verifies + calibrates each value.
   // Pure + provider-injected (no DB/network beyond the injected ChatProvider).
   ```

2. **No other inline comments.** Remove every inline `//` comment and every ASCII
   divider (e.g. `// ─── … ───`, `// ===== … =====`). Two exceptions ONLY:

   - **Preserve public-API JSDoc.** Keep `/** … */` blocks on *exported* functions,
     types, interfaces, enums, and their members (these are IDE-surfaced API docs).
     Tighten verbose JSDoc prose, but keep the documentation and any `@param`/`@returns`.

   - **Fold load-bearing "why" into the header.** If an inline comment carried a
     genuine invariant / workaround / footgun / deliberate trade-off (e.g. an ACL
     import invariant, a "confidence is independent of mapping" note, a deliberate
     short-circuit), compress it into the file's top header within the 3–4 line budget.
     Drop the rest. Note anything meaningful-but-dropped in `REFRACTOR_NOTES.md`.

3. **Restate-the-code comments are deleted** ("// loop over rows", "// set status",
   "// Index by nodeId", "// Wire up children").

## Dead code / TODOs
- Remove commented-out code and stale TODO/FIXME. List each removal in
  `REFRACTOR_NOTES.md` (file + what it said).
- Remove genuinely dead code (unexported, unused, unreferenced) ONLY after a repo-wide
  search confirms it. If uncertain, leave it and note it in `REFRACTOR_NOTES.md`.

## Naming & structure
- Rename only for clarity, and only with a repo-wide, reference-complete update that
  keeps all checks green. Prefer leaving exported/public names alone.
- A file that clearly mixes two unrelated responsibilities AND is large MAY be split
  into co-located files — only if mechanical, reference-complete, and checks stay green.
  When in doubt, do NOT split.

## Formatting
- Rely on the configured linter (`eslint`) as the gate. `eslint --fix` is allowed only
  where its changes are minimal and safe.
- **Do NOT run a blanket `prettier --write`** — there is no prettier config, so a global
  reformat would explode the diff with non-semantic churn. Keep diffs to comment / doc /
  dead-code / test-org lines only.

## Tests
- Co-located `*.test.ts` using `bun:test`. Keep tests in their own files (never inline).
- The header rule applies to test files too (≤4-line header, no inline comments).
- DO NOT weaken or delete assertions that pin real behavior. You MAY add small,
  obviously-correct tests that document existing behavior — never tests that change it.
- Remove dead/duplicate/skipped tests only if truly dead; note removals.

## Per-file checklist
- [ ] Header trimmed to ≤4 lines, no phase/ticket/spec/ASCII noise, accurate to code.
- [ ] All inline comments removed; public-API JSDoc preserved; load-bearing why folded into header.
- [ ] Commented-out code and stale TODOs removed (noted in REFRACTOR_NOTES.md).
- [ ] Dead code removed (repo-wide-search confirmed) or left + noted.
- [ ] Names clear; no signature changes unless fully propagated + green.
- [ ] Scoped typecheck + test green (at baseline parity for the package).
- [ ] `git diff` contains NO logic / constant / string / SQL / signature change.

## Gates
- `bun run typecheck` (turbo + `tsc -p scripts`) — must stay GREEN.
- `bun run lint` (turbo eslint) — must stay GREEN.
- Scoped per package: `npx turbo run typecheck test --filter=<@aonex/pkg>`.
- Many tests require live Postgres+Redis and fail without them — that's the BASELINE,
  not a regression. Match the per-package baseline counts in `REFRACTOR_NOTES.md`.
