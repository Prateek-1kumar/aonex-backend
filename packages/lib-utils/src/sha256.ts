// SHA-256 helpers — wrap node:crypto so callers don't import it
// directly (composition root rule).

import { createHash } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash a JSON-shaped value canonically — guaranteed stable across
 * key ordering and undefined-vs-omitted differences.
 */
export function sha256Canonical(value: unknown): string {
  const { canonicalStringify } = require("./canonical-stringify.js") as typeof import("./canonical-stringify.js");
  return sha256Hex(canonicalStringify(value));
}
