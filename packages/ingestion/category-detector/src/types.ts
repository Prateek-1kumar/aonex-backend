// HLD §9 — Category Detector output types.

export interface DetectionResult {
  /** Null when no rule matches with confidence ≥ threshold */
  categoryPath: string | null;
  /** 0..1 — below 0.70 the worker routes to Anomaly Lab per HLD §9 */
  confidence: number;
  /** Human-readable explanation for audit trail */
  evidence: string;
}
