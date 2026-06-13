import { describe, expect, test } from "bun:test";
import { scoreClassification, aggregateClassification, precisionRecall } from "./score-taxonomy.js";

// fashion/clothing/bottoms/jeans ancestry
const anc = (id: string): string[] => {
  const parts = id.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
};

describe("scoreClassification", () => {
  const gold = "fashion/clothing/bottoms/jeans";
  test("exact", () => expect(scoreClassification(gold, gold, anc)).toEqual({ exact: true, credit: 1 }));
  test("ancestor → 0.5", () => expect(scoreClassification("fashion/clothing/bottoms", gold, anc).credit).toBe(0.5));
  test("same department → 0.25", () => expect(scoreClassification("fashion/footwear/sneakers", gold, anc).credit).toBe(0.25));
  test("wrong department → 0", () => expect(scoreClassification("electronics/audio-and-headphones/headphones", gold, anc).credit).toBe(0));
  test("abstain → 0", () => expect(scoreClassification(null, gold, anc)).toEqual({ exact: false, credit: 0 }));
});

describe("aggregateClassification", () => {
  test("top1 / weighted / abstained", () => {
    const agg = aggregateClassification([
      { exact: true, credit: 1, predicted: "a" },
      { exact: false, credit: 0.5, predicted: "b" },
      { exact: false, credit: 0, predicted: null },
      { exact: false, credit: 0.25, predicted: "c" },
    ]);
    expect(agg.top1).toBe(0.25);
    expect(agg.weighted).toBeCloseTo(0.4375, 4);
    expect(agg.abstained).toBe(0.25);
  });
});

describe("precisionRecall", () => {
  test("abstains lower recall but not precision", () => {
    // 4 items: 2 exact, 1 wrong-but-predicted, 1 abstain.
    const pr = precisionRecall([
      { exact: true, credit: 1, predicted: "a" },
      { exact: true, credit: 1, predicted: "b" },
      { exact: false, credit: 0, predicted: "c" },
      { exact: false, credit: 0, predicted: null },
    ]);
    expect(pr.precision).toBeCloseTo(2 / 3, 6); // 2 correct of 3 committed
    expect(pr.recall).toBe(0.5); // 2 correct of 4 total
    expect(pr).toMatchObject({ predicted: 3, correct: 2, total: 4 });
  });

  test("empty -> zeros, no divide-by-zero", () => {
    expect(precisionRecall([])).toMatchObject({ precision: 0, recall: 0 });
  });
});
