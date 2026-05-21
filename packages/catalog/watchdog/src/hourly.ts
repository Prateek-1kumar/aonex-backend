// Catalog redesign Phase 3.10 — hourly tier (spec §13.3, plan §3.10).
//
// Same shape as continuous but: window = 1 hour, sample = 10%. Catches drift
// that slipped past the continuous sampler.
//
// Reuses `runSweep` from continuous.ts — only the window literal + sample
// divisor differ.

import type { ContinuousDeps } from "./continuous.js";
import { runSweep } from "./continuous.js";
import type { WatchdogStats } from "./drift-detector.js";

export async function runHourly(deps: ContinuousDeps): Promise<WatchdogStats> {
  return runSweep(deps, "1 hour", deps.sampleDivisor ?? 10);
}
