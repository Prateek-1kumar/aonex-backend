// Anomaly Lab — staging gate. Pure readiness evaluation over an AdapterOutput.
// No I/O. Blocking = completeness against CANONICAL_MINIMUM + any blocking signal.
// Spec §4, §8. `signals` is supplied by the caller (resolver + detector suite).

import type { AdapterOutput } from "@aonex/catalog-source-adapters";

export interface GateSignal {
  signalKind: string;
  severity: "low" | "medium" | "high" | "critical";
  blocking: boolean;
}

export interface GateInput {
  adapterOutput: AdapterOutput;
  signals: GateSignal[];
}

export interface GateVerdict {
  admit: boolean;
  missingFields: string[];
  blockingSignals: GateSignal[];
  infoSignals: GateSignal[];
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function attrValue(out: AdapterOutput, attributeCode: string): unknown {
  let latest: { observedAt: Date; value: unknown } | undefined;
  for (const o of out.observations) {
    if (o.attributeCode !== attributeCode) continue;
    if (!latest || o.observedAt > latest.observedAt) latest = o;
  }
  return latest?.value;
}

function hasPrimaryPricing(out: AdapterOutput): boolean {
  return out.pricingObservations.some(
    (p) => isNonEmptyString(p.currency) &&
      p.tiers.some((t) => typeof t.amount === "number" || typeof t.total === "number")
  );
}

function hasIdentifier(out: AdapterOutput): boolean {
  const h = out.identityHint;
  return isNonEmptyString(h.gtin) || isNonEmptyString(h.mpn) || isNonEmptyString(h.brand);
}

export function evaluateGate(input: GateInput): GateVerdict {
  const { adapterOutput: out, signals } = input;
  const missingFields: string[] = [];

  if (!isNonEmptyString(attrValue(out, "title"))) missingFields.push("title");
  if (!isNonEmptyString(out.identityHint.brand)) missingFields.push("brand");
  if (!hasPrimaryPricing(out)) missingFields.push("pricing.primary");
  if (!isNonEmptyString(attrValue(out, "category_path"))) missingFields.push("category_path");
  if (!hasIdentifier(out)) missingFields.push("identifier");

  const blockingSignals = signals.filter((s) => s.blocking);
  const infoSignals = signals.filter((s) => !s.blocking);
  const admit = missingFields.length === 0 && blockingSignals.length === 0;

  return { admit, missingFields, blockingSignals, infoSignals };
}
