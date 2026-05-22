// Catalog redesign — reconciler `pickWinner` (pure projection).
//
// Pure function: given a list of observations for ONE attribute (e.g.
// `title`, `pricing`, `brand`) at ONE channel/locale leaf, project them down
// to a single winning value by applying source_priority rules and
// recency-on-tie. No DB, no I/O, no async — this lives at the heart of both
// the sync (Task 3.4) and async (Task 3.5/3.6) reconciler paths.
//
// See plan §3.3 and spec §15 for the source of truth on the algorithm.
//
// Algorithm:
//   1. No observations → return null.
//   2. Drop rules that don't apply to `input.attributeCode`
//      (rule.attributeCode === null || rule.attributeCode === input.attributeCode).
//   3. For each observation, find the BEST matching rule:
//        - rule.sourceGlob matches obs.source (glob `*`)
//        - rule.channelScope matches input.channel (null = matches anything;
//          globs like "shopify-*" allowed)
//        - sort matching rules by priority asc (1 wins over 100)
//        - tie-break by channel-scope specificity:
//            explicit (no `*`) > glob (`shopify-*`) > null
//          approximated via a numeric specificity score so we can sort.
//      If no rule matches, this observation gets effective priority +Infinity.
//   4. Sort observations by:
//        - rule priority asc
//        - then channel-scope specificity desc (more-specific wins ties)
//        - then observedAt desc (newer wins on remaining ties)
//   5. Return top observation's value + a WinnerExplanation tag.
//
// On bumping RECONCILER_VERSION: any change to the projection logic above
// (new tie-breaker, new rule shape, glob semantics, etc.) MUST bump the
// constant so `winning_values[*]._meta.reconcilerVersion` stamps reflect the
// new behaviour. Major bump for behavioural changes; minor for refactors that
// preserve every output for every input. v1 starts at "1.0.0".

/** Current reconciler logic version — bump on any behavioural change. */
export const RECONCILER_VERSION = "1.0.0";

export interface PickWinnerObservation {
  source: string;
  sourceRecordId: string;
  value: unknown;
  confidence: number;
  observedAt: Date;
}

export interface SourcePriorityRule {
  /** Matches source_priority.rule_id. Use -1 to denote a synthetic fallback. */
  ruleId: number;
  /** `null` = applies to all attributes; otherwise the exact attribute_code. */
  attributeCode: string | null;
  /** Glob over observation.source — e.g. `"shopify:*"`, `"csv:*"`, `"*"`. */
  sourceGlob: string;
  /** Glob over input.channel — `null` matches any channel; `"shopify-*"` is a glob. */
  channelScope: string | null;
  /** Lower = higher priority. priority 1 beats priority 100. */
  priority: number;
}

export interface WinnerExplanation {
  /** The winning rule's id, or the literal string `"wildcard"` when no rule matched. */
  ruleId: number | "wildcard";
  sourceGlob: string;
  priority: number;
}

export interface PickWinnerInput {
  observations: PickWinnerObservation[];
  rules: SourcePriorityRule[];
  /** Channel leaf — e.g. `"shopify-store-au"`, `"_unscoped"`. */
  channel: string;
  /** Attribute leaf — e.g. `"title"`, `"pricing"`, `"brand"`. */
  attributeCode: string;
}

export interface PickWinnerResult {
  value: unknown;
  /**
   * The original observation that produced the winning value. Reference-equal
   * to one of the entries in `input.observations` — callers can use this to
   * recover side-channel fields (DB row, sourceRecordId, etc.) without
   * re-deriving identity from `value` + `observedAt` (ambiguous on ties).
   */
  observation: PickWinnerObservation;
  explanation: WinnerExplanation;
}

// ---- Glob matching ---------------------------------------------------------

/**
 * Tiny glob matcher: only `*` is a wildcard (matches zero or more characters).
 * All other regex metacharacters are escaped. Anchored — must match the full
 * target. Pure; safe to use on arbitrary user input.
 *
 * Exported for direct testing of the glob primitive.
 */
export function globMatch(glob: string, target: string): boolean {
  if (glob === "*") return true;
  if (glob === target) return true;

  // Escape regex metacharacters, then re-introduce `*` -> `.*`.
  const pattern = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${pattern}$`).test(target);
}

// ---- Channel-scope specificity --------------------------------------------

/**
 * Channel-scope specificity score — higher = more specific. Used to break
 * ties when two rules at the same priority both match an observation.
 *   - `null`            → 0   (matches anything; least specific)
 *   - glob with `*`     → 1   (e.g. `"shopify-*"`)
 *   - explicit string   → 2   (e.g. `"shopify-store-au"`)
 *
 * This is a deliberately coarse heuristic — sufficient for v1 where rules
 * are hand-authored and rarely overlap. A future iteration could rank by
 * count of literal segments / inverse glob breadth.
 */
function channelScopeSpecificity(scope: string | null): number {
  if (scope === null) return 0;
  return scope.includes("*") ? 1 : 2;
}

// ---- Rule <> observation matching ------------------------------------------

interface ObservationRank {
  obs: PickWinnerObservation;
  rulePriority: number;
  ruleId: number | "wildcard";
  sourceGlob: string;
  channelSpecificity: number;
}

function ruleMatches(
  rule: SourcePriorityRule,
  obs: PickWinnerObservation,
  channel: string
): boolean {
  if (!globMatch(rule.sourceGlob, obs.source)) return false;
  if (rule.channelScope !== null && !globMatch(rule.channelScope, channel)) {
    return false;
  }
  return true;
}

// ---- Public API ------------------------------------------------------------

/**
 * Project a bag of observations down to a single winning value for one
 * (attribute, channel) leaf. Returns `null` iff `observations` is empty.
 *
 * Pure — depends only on its inputs. See module header for the algorithm.
 */
export function pickWinner(input: PickWinnerInput): PickWinnerResult | null {
  if (input.observations.length === 0) return null;

  // Step 2: rules applicable to this attribute.
  const applicableRules = input.rules.filter(
    (r) => r.attributeCode === null || r.attributeCode === input.attributeCode
  );

  // Step 3: rank each observation by its best-matching rule.
  const ranked: ObservationRank[] = input.observations.map((obs) => {
    const matching = applicableRules
      .filter((r) => ruleMatches(r, obs, input.channel))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // More-specific channel scope wins ties on equal priority.
        return (
          channelScopeSpecificity(b.channelScope) -
          channelScopeSpecificity(a.channelScope)
        );
      });
    const best = matching[0];
    if (!best) {
      return {
        obs,
        rulePriority: Number.POSITIVE_INFINITY,
        ruleId: "wildcard" as const,
        sourceGlob: "*",
        channelSpecificity: -1
      };
    }
    return {
      obs,
      rulePriority: best.priority,
      ruleId: best.ruleId,
      sourceGlob: best.sourceGlob,
      channelSpecificity: channelScopeSpecificity(best.channelScope)
    };
  });

  // Step 4: sort observations — lowest priority, then most-specific scope,
  // then newest observedAt.
  ranked.sort((a, b) => {
    if (a.rulePriority !== b.rulePriority) {
      return a.rulePriority - b.rulePriority;
    }
    if (a.channelSpecificity !== b.channelSpecificity) {
      return b.channelSpecificity - a.channelSpecificity;
    }
    return b.obs.observedAt.getTime() - a.obs.observedAt.getTime();
  });

  const top = ranked[0]!;
  return {
    value: top.obs.value,
    observation: top.obs,
    explanation: {
      ruleId: top.ruleId,
      sourceGlob: top.sourceGlob,
      priority: top.rulePriority
    }
  };
}
