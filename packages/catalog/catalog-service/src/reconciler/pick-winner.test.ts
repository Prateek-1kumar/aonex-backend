// Tests for the pure `pickWinner` projection (plan §3.3).
//
// No DB; no async. Each case constructs observations + rules in memory and
// asserts the winner / explanation.

import { describe, expect, test } from "bun:test";
import {
  RECONCILER_VERSION,
  globMatch,
  pickWinner,
  type PickWinnerObservation,
  type SourcePriorityRule
} from "./pick-winner.js";

// Small helper — keeps the test bodies focused on the case under test.
function obs(
  source: string,
  value: unknown,
  observedAt: Date,
  overrides: Partial<PickWinnerObservation> = {}
): PickWinnerObservation {
  return {
    source,
    sourceRecordId: overrides.sourceRecordId ?? `${source}#1`,
    value,
    confidence: overrides.confidence ?? 1.0,
    observedAt
  };
}

describe("pickWinner (plan §3.3)", () => {
  test("RECONCILER_VERSION is the v1 string", () => {
    expect(RECONCILER_VERSION).toBe("1.0.0");
  });

  test("priority 1 source beats priority 2 even if observed later", () => {
    const observations = [
      obs("shopify:connector", 99, new Date("2026-05-01")),
      obs("ebay:link", 101, new Date("2026-05-02")) // newer but worse priority
    ];
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 10,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: "shopify-*",
        priority: 1
      },
      {
        ruleId: 11,
        attributeCode: null,
        sourceGlob: "ebay:*",
        channelScope: "ebay-*",
        priority: 2
      }
    ];

    const winner = pickWinner({
      observations,
      rules,
      channel: "shopify-store-au",
      attributeCode: "pricing"
    });

    expect(winner).not.toBeNull();
    expect(winner!.value).toBe(99);
    expect(winner!.explanation.ruleId).toBe(10);
    expect(winner!.explanation.priority).toBe(1);
    expect(winner!.explanation.sourceGlob).toBe("shopify:*");
  });

  test("most-recent wins on tied priority", () => {
    const older = new Date("2026-05-01T00:00:00Z");
    const newer = new Date("2026-05-10T00:00:00Z");
    const observations = [
      obs("csv:upload-a", "OLD", older),
      obs("csv:upload-b", "NEW", newer)
    ];
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 20,
        attributeCode: null,
        sourceGlob: "csv:*",
        channelScope: null,
        priority: 5
      }
    ];

    const winner = pickWinner({
      observations,
      rules,
      channel: "_unscoped",
      attributeCode: "title"
    });

    expect(winner!.value).toBe("NEW");
  });

  test("channel-scoped rule beats wildcard-scoped rule on equal priority", () => {
    // Both rules match the observation; the explicit channel scope is more
    // specific and should win the tie. We don't include rule order influence
    // by listing wildcard first.
    const observations = [obs("shopify:connector", "AU-price", new Date("2026-05-01"))];
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 30,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: null, // matches anything
        priority: 1
      },
      {
        ruleId: 31,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: "shopify-store-au", // explicit, most-specific
        priority: 1
      }
    ];

    const winner = pickWinner({
      observations,
      rules,
      channel: "shopify-store-au",
      attributeCode: "pricing"
    });

    expect(winner!.value).toBe("AU-price");
    expect(winner!.explanation.ruleId).toBe(31);
  });

  test("returns null when no observations", () => {
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 99,
        attributeCode: null,
        sourceGlob: "*",
        channelScope: null,
        priority: 1
      }
    ];
    expect(
      pickWinner({
        observations: [],
        rules,
        channel: "shopify-store-au",
        attributeCode: "title"
      })
    ).toBeNull();
  });

  test("observation with no matching rule loses to one with a matching rule", () => {
    const observations = [
      obs("shopify:connector", "rules-matched", new Date("2026-05-01")),
      // No rule will match this source — should get effective priority Infinity
      // and lose despite being newer.
      obs("unknown:weird", "no-rule", new Date("2026-06-01"))
    ];
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 40,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: null,
        priority: 100 // even very low priority should still beat unmatched
      }
    ];

    const winner = pickWinner({
      observations,
      rules,
      channel: "shopify-store-au",
      attributeCode: "title"
    });

    expect(winner!.value).toBe("rules-matched");
    expect(winner!.explanation.ruleId).toBe(40);
  });

  test("all observations unmatched: still returns a winner (newest by observedAt)", () => {
    // Effective priority Infinity for both → tie-break by recency.
    const older = new Date("2026-05-01");
    const newer = new Date("2026-05-02");
    const observations = [
      obs("weird:a", "older", older),
      obs("weird:b", "newer", newer)
    ];

    const winner = pickWinner({
      observations,
      rules: [],
      channel: "shopify-store-au",
      attributeCode: "title"
    });

    expect(winner!.value).toBe("newer");
    expect(winner!.explanation.ruleId).toBe("wildcard");
    expect(winner!.explanation.sourceGlob).toBe("*");
  });

  test("attributeCode-scoped rule only applies to its attribute", () => {
    // The pricing-only rule should be filtered out when attributeCode='title'.
    const observations = [obs("shopify:connector", "T", new Date("2026-05-01"))];
    const pricingRule: SourcePriorityRule = {
      ruleId: 50,
      attributeCode: "pricing",
      sourceGlob: "shopify:*",
      channelScope: null,
      priority: 1
    };
    const titleRule: SourcePriorityRule = {
      ruleId: 51,
      attributeCode: "title",
      sourceGlob: "shopify:*",
      channelScope: null,
      priority: 7
    };

    const winner = pickWinner({
      observations,
      rules: [pricingRule, titleRule],
      channel: "shopify-store-au",
      attributeCode: "title"
    });

    // pricingRule must NOT win; titleRule should.
    expect(winner!.explanation.ruleId).toBe(51);
    expect(winner!.explanation.priority).toBe(7);
  });

  test("explanation.ruleId reflects the rule that actually won", () => {
    const observations = [
      obs("shopify:connector", "shopify-value", new Date("2026-05-01")),
      obs("csv:upload", "csv-value", new Date("2026-05-02"))
    ];
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 1001,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: null,
        priority: 1
      },
      {
        ruleId: 1002,
        attributeCode: null,
        sourceGlob: "csv:*",
        channelScope: null,
        priority: 3
      }
    ];

    const winner = pickWinner({
      observations,
      rules,
      channel: "_unscoped",
      attributeCode: "title"
    });

    expect(winner!.value).toBe("shopify-value");
    expect(winner!.explanation).toEqual({
      ruleId: 1001,
      sourceGlob: "shopify:*",
      priority: 1
    });
  });

  test("channel-scope glob does not match unrelated channel", () => {
    // Rule scoped to ebay-* must NOT match shopify-store-au, so the matching
    // observation gets no rule and falls to effective Infinity.
    const observations = [obs("shopify:connector", "value", new Date("2026-05-01"))];
    const rules: SourcePriorityRule[] = [
      {
        ruleId: 60,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: "ebay-*", // doesn't match shopify-store-au
        priority: 1
      }
    ];

    const winner = pickWinner({
      observations,
      rules,
      channel: "shopify-store-au",
      attributeCode: "title"
    });

    expect(winner!.value).toBe("value");
    expect(winner!.explanation.ruleId).toBe("wildcard");
  });
});

describe("globMatch", () => {
  test("'shopify:*' matches 'shopify:connector' but not 'amazon:link'", () => {
    expect(globMatch("shopify:*", "shopify:connector")).toBe(true);
    expect(globMatch("shopify:*", "shopify:")).toBe(true); // zero-char match
    expect(globMatch("shopify:*", "amazon:link")).toBe(false);
  });

  test("plain '*' matches anything", () => {
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("*", "shopify:connector")).toBe(true);
  });

  test("exact string matches itself only", () => {
    expect(globMatch("shopify-store-au", "shopify-store-au")).toBe(true);
    expect(globMatch("shopify-store-au", "shopify-store-uk")).toBe(false);
  });

  test("regex metacharacters in the glob are treated literally", () => {
    // A `.` in the glob must match only literal `.`, not any char.
    expect(globMatch("shopify.connector", "shopify.connector")).toBe(true);
    expect(globMatch("shopify.connector", "shopifyXconnector")).toBe(false);
  });

  test("internal '*' matches zero or more chars", () => {
    expect(globMatch("shopify-*-au", "shopify-store-au")).toBe(true);
    expect(globMatch("shopify-*-au", "shopify--au")).toBe(true);
    expect(globMatch("shopify-*-au", "shopify-store-uk")).toBe(false);
  });
});
