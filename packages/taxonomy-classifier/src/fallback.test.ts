import { describe, expect, test } from "bun:test";
import { buildIndex } from "./classify.js";
import { classifyWithFallback } from "./fallback.js";
import { deterministicResolver, llmResolver, type ChatProvider } from "./resolver.js";

const leaves = [
  { nodeId: "fashion/clothing/bottoms/jeans", displayName: "Jeans" },
  { nodeId: "electronics/audio-and-headphones/headphones", displayName: "Headphones" },
  { nodeId: "electronics/computers-and-laptops/laptops", displayName: "Laptops" },
];
const aliases = new Map([["jeans", "fashion/clothing/bottoms/jeans"]]);
const index = buildIndex(leaves, aliases, [
  { id: "electronics", name: "Electronics" },
  { id: "fashion", name: "Fashion" },
]);

describe("classifyWithFallback (deterministic resolver)", () => {
  test("high-confidence alias auto-assigns, skips resolver", async () => {
    const r = await classifyWithFallback({ title: "Levi's", sourceCategory: "Jeans" }, index, deterministicResolver);
    expect(r.outcome).toBe("assign");
    expect(r.source).toBe("alias");
  });

  test("true unknown with a department hint -> propose_node (not force-fit)", async () => {
    const r = await classifyWithFallback({ title: "DJI Mavic 3 Drone", sourceCategory: "Electronics > Drones" }, index, deterministicResolver);
    expect(r.outcome).toBe("propose_node");
    expect(r.proposedNode?.parentId).toBe("electronics");
    expect(r.nodeId).toBeNull(); // never a wrong leaf
  });

  test("true unknown with no signal -> abstain", async () => {
    const r = await classifyWithFallback({ title: "Mystery Gadget XYZ", sourceCategory: "misc" }, index, deterministicResolver);
    expect(r.outcome).toBe("abstain");
    expect(r.nodeId).toBeNull();
  });
});

describe("llmResolver (stub provider)", () => {
  const stub: ChatProvider = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async chatCompletion() {
      return { content: '{"decision":"new_node","parentDepartment":"electronics","name":"Drones"}' };
    },
  };
  test("parses an LLM new_node decision", async () => {
    const r = await classifyWithFallback({ title: "DJI Drone", sourceCategory: "aerial" }, index, llmResolver(stub, "test-model"), { autoThreshold: 0.7 });
    expect(r.outcome).toBe("propose_node");
    expect(r.proposedNode).toEqual({ parentId: "electronics", suggestedName: "Drones" });
  });
});
