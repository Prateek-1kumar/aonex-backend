// Recursively strips Nango's `_nango_metadata` from records before checksumming.
// Without this, Nango's per-sync metadata makes every re-sync produce a different
// payload_checksum, silently breaking the staging dedup UNIQUE constraint.

const NANGO_METADATA_KEY = "_nango_metadata";

export function removeNangoMetadata<T>(record: T): T {
  if (record === null || record === undefined) return record;
  if (Array.isArray(record)) {
    return record.map((r) => removeNangoMetadata(r)) as unknown as T;
  }
  if (typeof record !== "object") return record;
  const { [NANGO_METADATA_KEY]: _drop, ...rest } = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    out[k] = removeNangoMetadata(v);
  }
  return out as unknown as T;
}
