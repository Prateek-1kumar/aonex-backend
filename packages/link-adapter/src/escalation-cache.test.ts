import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEscalationCache } from "./escalation-cache.js";

let dir: string;
let cache: FileEscalationCache;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "esc-"));
  cache = new FileEscalationCache(join(dir, "esc.json"));
});

describe("FileEscalationCache", () => {
  it("persists escalation state across instances", async () => {
    await cache.set("https://x.com/p", { escalatedTo: "browser", reasons: ["captcha"], costCredits: 0 });
    const c2 = new FileEscalationCache(join(dir, "esc.json"));
    expect(await c2.get("https://x.com/p")).toMatchObject({ escalatedTo: "browser" });
  });

  it("returns null for unknown URL", async () => {
    expect(await cache.get("https://nope")).toBeNull();
  });

  it("handles concurrent set/get without crashing", async () => {
    await Promise.all([
      cache.set("a", { escalatedTo: "browser", reasons: [], costCredits: 0 }),
      cache.set("b", { escalatedTo: "unblock", reasons: [], costCredits: 5 })
    ]);
    expect((await cache.get("b"))?.escalatedTo).toBe("unblock");
  });
});
