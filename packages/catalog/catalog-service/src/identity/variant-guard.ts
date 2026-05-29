// Phase 2: variant/region merge guard (spec D2). Auto-merge cannot cross
// physically-distinct variants (128GB vs 256GB phones) or regions (IN vs US).

const VARIANT_AXES = ["storage", "size", "color", "ram", "region"] as const;
type VariantKeys = Partial<Record<(typeof VARIANT_AXES)[number], string>>;

/** Two products conflict (must NOT auto-merge) if any shared variant axis differs.
 *  When one side has no value for an axis, that axis cannot conflict — only
 *  declared-on-both-sides mismatches block. Case-insensitive trim. */
export function variantConflict(a: VariantKeys, b: VariantKeys): boolean {
  for (const axis of VARIANT_AXES) {
    const av = a[axis]?.toLowerCase().trim();
    const bv = b[axis]?.toLowerCase().trim();
    if (av && bv && av !== bv) return true;
  }
  return false;
}
