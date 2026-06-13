// SHA-256 helpers wrapping node:crypto: hex digest of a string/Buffer and a
// canonical-JSON digest that is stable across key order and undefined values.

import { createHash } from "node:crypto";
import { canonicalStringify } from "./canonical-stringify.js";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash a JSON-shaped value canonically — guaranteed stable across
 * key ordering and undefined-vs-omitted differences.
 */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
