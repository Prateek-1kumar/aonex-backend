// Public barrel for @aonex/catalog-watchdog. See drift-detector.ts for the
// WHAT/WHY; spec §13.3 + plan §3.10 are the source of truth.

export { detectDrift } from "./drift-detector.js";
export type { DriftReport, WatchdogDeps, WatchdogStats } from "./drift-detector.js";

export { autoFixDrift } from "./auto-fix.js";
export type { AutoFixDeps, AutoFixResult } from "./auto-fix.js";

export { runContinuous, runSweep } from "./continuous.js";
export type { ContinuousDeps } from "./continuous.js";

export { runHourly } from "./hourly.js";

export { runDaily } from "./daily.js";
export type { DailyDeps, DailyStats } from "./daily.js";
