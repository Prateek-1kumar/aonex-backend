import { describe, expect, test } from "bun:test";
import { checkConsistency } from "./consistency.js";
import type { ChatProvider, FieldResult } from "./types.js";

function field(key: string, value: unknown, over: Partial<FieldResult> = {}): FieldResult {
  return {
    key,
    tier: "required",
    kind: "spec",
    raw: value,
    normalized: value,
    status: "ok",
    grounding: "grounded",
    support: 1,
    modelConfidence: 0.9,
    calibratedConfidence: 0.9,
    accepted: true,
    proposable: true,
    action: "fill",
    ...over,
  };
}

/** Provider that returns a fixed body and records whether it was called. */
function stub(content: string): ChatProvider & { calls: number } {
  const p = {
    calls: 0,
    async chatCompletion() {
      p.calls++;
      return { content, model: "stub" };
    },
  };
  return p;
}

describe("checkConsistency", () => {
  test("skips the LLM call when fewer than 2 fields are considered", async () => {
    const provider = stub("{}");
    const out = await checkConsistency([field("size", "Large")], { provider, model: "x" });
    expect(out).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  test("returns a hard conflict between two contradicting fields", async () => {
    const provider = stub(
      JSON.stringify({ conflicts: [{ keys: ["size", "description"], reason: "Large vs 'fits petite'", severity: "hard" }] })
    );
    const out = await checkConsistency(
      [field("size", "Large"), field("description", "Slim cut, fits petite frames", { kind: "content" })],
      { provider, model: "x" }
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("hard");
    expect(out[0]!.keys).toEqual(["size", "description"]);
  });

  test("drops conflicts that reference unknown field keys", async () => {
    const provider = stub(JSON.stringify({ conflicts: [{ keys: ["ghost"], reason: "n/a", severity: "soft" }] }));
    const out = await checkConsistency([field("size", "Large"), field("color", "Black")], { provider, model: "x" });
    expect(out).toEqual([]);
  });

  test("only audits accepted/proposable fields", async () => {
    const provider = stub(JSON.stringify({ conflicts: [] }));
    // Two fields, but one is suppressed (not accepted, not proposable) -> only 1 considered -> no call.
    const out = await checkConsistency(
      [field("size", "Large"), field("color", "Black", { accepted: false, proposable: false })],
      { provider, model: "x" }
    );
    expect(out).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  test("returns [] on non-JSON model output instead of throwing", async () => {
    const provider = stub("I cannot help with that.");
    const out = await checkConsistency([field("size", "Large"), field("color", "Black")], { provider, model: "x" });
    expect(out).toEqual([]);
  });
});
