// HLD §14 — Policy Engine public API.
export * from "./types.js";

// Plan B — multi-signal router (canonical going forward).
export { route, clusterKey } from "./router.js";

// Spec §14.3 — pre-routing confidence calibration helper.
export {
  calibrateFacts,
  noopCalibrationLookup,
  type CalibrationKey,
  type CalibrationLookup,
  type CalibrationContext
} from "./calibration.js";
