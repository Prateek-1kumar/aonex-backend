// Anomaly Lab — staging gate. Pure readiness evaluation over an AdapterOutput.
// No I/O. Blocking = completeness against CANONICAL_MINIMUM + any blocking signal.
// Spec §4, §8. `signals` is supplied by the caller (resolver + detector suite).
//
// The fields checked below must stay in lockstep with CANONICAL_MINIMUM in
// ../canonical-minimum.ts (that constant is the spec anchor; the checks here
// are the runtime enforcement). If you add a field there, add its check here.

import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { archetypeEnabledFor } from "@aonex/archetypes";
import { latestObservationValue } from "../observation-helpers.js";
import { evaluateCompleteness } from "./completeness-gate.js";

export interface GateSignal {
  signalKind: string;
  severity: "low" | "medium" | "high" | "critical";
  blocking: boolean;
}

export interface GateInput {
  adapterOutput: AdapterOutput;
  signals: GateSignal[];
  // Phase 1 additions (all optional → legacy callers unaffected):
  archetypeId?: string;
  allowlist?: string;
  threshold?: number;
  identifierExists?: boolean;
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

function hasPrimaryPricing(out: AdapterOutput): boolean {
  // A tier amount/total of 0 is an intentionally valid price (free/sample),
  // so we check `typeof === "number"`, not truthiness.
  return out.pricingObservations.some(
    (p) => isNonEmptyString(p.currency) &&
      p.tiers.some((t) => typeof t.amount === "number" || typeof t.total === "number")
  );
}

function hasIdentifier(out: AdapterOutput): boolean {
  // A HARD identifier present at gate time. For scraped/marketplace sources
  // that's gtin/mpn. For a merchant uploading their own catalog (CSV), their
  // own SKU (primary_identifier) is the hard ID — it identifies the product
  // within the tenant. brand is deliberately NOT an identifier.
  const h = out.identityHint;
  return isNonEmptyString(h.gtin) || isNonEmptyString(h.mpn) || isNonEmptyString(h.primary_identifier);
}

export function evaluateGate(input: GateInput): GateVerdict {
  const { adapterOutput: out, signals } = input;

  // Phase 1: when the archetype flag is on and the product is classified,
  // delegate readiness to the weighted completeness gate. Legacy CANONICAL_MINIMUM
  // path runs verbatim otherwise (spec D4 backward-compat).
  if (input.archetypeId && archetypeEnabledFor(input.archetypeId, input.allowlist)) {
    const c = evaluateCompleteness({
      adapterOutput: out,
      archetypeId: input.archetypeId,
      threshold: input.threshold ?? 0.8,
      identifierExists: input.identifierExists ?? true,
    });
    const blockingSignals = signals.filter((s) => s.blocking);
    return {
      admit: c.admit && blockingSignals.length === 0,
      missingFields: c.missingRequired,
      blockingSignals,
      infoSignals: signals.filter((s) => !s.blocking),
    };
  }

  // ---- Legacy CANONICAL_MINIMUM path (unchanged from pre-Phase 1) ----
  const missingFields: string[] = [];

  if (!isNonEmptyString(latestObservationValue(out, "title"))) missingFields.push("title");
  if (!isNonEmptyString(out.identityHint.brand)) missingFields.push("brand");
  if (!hasPrimaryPricing(out)) missingFields.push("pricing.primary");
  if (!isNonEmptyString(latestObservationValue(out, "category_path"))) missingFields.push("category_path");
  if (!hasIdentifier(out)) missingFields.push("identifier");

  const blockingSignals = signals.filter((s) => s.blocking);
  const infoSignals = signals.filter((s) => !s.blocking);
  const admit = missingFields.length === 0 && blockingSignals.length === 0;

  return { admit, missingFields, blockingSignals, infoSignals };
}
