// Strip Nango's `_nango_metadata` from records before checksumming.
// Without this, every re-sync produces a different payload_checksum
// (Nango stamps `lastModifiedAt`, etc. into metadata) and the staging
// dedup UNIQUE constraint silently breaks.
//
// Mirrors `runner-sdk/lib/sync.ts:124-135` in Nango. (LLD §4 / Q4.)

const NANGO_METADATA_KEY = "_nango_metadata";

export function removeNangoMetadata<T>(record: T): T {
  if (record === null || record === undefined) return record;
  if (Array.isArray(record)) {
    return record.map((r) => removeNangoMetadata(r)) as unknown as T;
  }
  if (typeof record !== "object") return record;
  const { [NANGO_METADATA_KEY]: _drop, ...rest } = record as Record<string, unknown>;
  // recurse into nested values — metadata may live deep
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    out[k] = removeNangoMetadata(v);
  }
  return out as unknown as T;
}
