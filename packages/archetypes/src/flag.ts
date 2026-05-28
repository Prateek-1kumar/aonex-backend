/** Scoped rollout (spec D4): completeness gating is active only for archetypes in
 *  the allowlist (env AONEX_ARCHETYPE_VERTICALS, comma-separated). `unknown` is
 *  never enabled (falls back to the legacy gate). Second arg is injectable for tests. */
export function archetypeEnabledFor(
  archetypeId: string,
  allowlist: string = process.env.AONEX_ARCHETYPE_VERTICALS ?? ""
): boolean {
  if (archetypeId === "unknown") return false;
  const set = new Set(allowlist.split(",").map((s) => s.trim()).filter(Boolean));
  return set.has(archetypeId);
}
