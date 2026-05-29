import { test, expect } from "bun:test";
import * as evalpkg from "./index.js";

test("public surface is exported", () => {
  for (const name of ["scoreProduct", "aggregate", "promoteMetrics", "loadGoldenSet", "splitBy", "evaluateGate", "toLabeledSamples", "fieldWeight"]) {
    expect(typeof (evalpkg as Record<string, unknown>)[name]).toBe("function");
  }
});
