import { describe, it, expect } from "bun:test";
import { buildExtractionPrompt } from "./prompt-builder.js";

describe("buildExtractionPrompt", () => {
  it("emits gap schema when gaps[] provided", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "irrelevant",
      url: "https://x.com/p",
      gaps: ["material", "fit"],
      categoryCandidates: ["apparel/t_shirts"],
    });
    const sys = msgs[0]!.content;
    expect(sys).toContain('"material"');
    expect(sys).toContain('"fit"');
    expect(sys).not.toContain("LAUNCH_CATEGORIES"); // no hardcoded ref
  });

  it("emits full schema when no gaps", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "...",
      url: "https://x.com/p",
      categoryCandidates: ["apparel/t_shirts"],
    });
    const sys = msgs[0]!.content;
    expect(sys).toContain('"variants"');
    expect(sys).toContain('"option_values"');
  });

  it("includes categoryCandidates in the system prompt", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "...",
      url: "https://x.com/p",
      categoryCandidates: ["apparel/t_shirts", "apparel/shirts"],
    });
    expect(msgs[0]!.content).toContain("apparel/t_shirts");
    expect(msgs[0]!.content).toContain("apparel/shirts");
  });
});
