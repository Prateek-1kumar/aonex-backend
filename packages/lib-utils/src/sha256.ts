// SHA-256 helpers — wrap node:crypto so callers don't import it
// directly (composition root rule).

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
