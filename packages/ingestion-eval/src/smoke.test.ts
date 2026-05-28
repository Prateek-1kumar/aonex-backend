import { test, expect } from "bun:test";
import { EVAL_PACKAGE } from "./index.js";

test("package is importable", () => {
  expect(EVAL_PACKAGE).toBe("@aonex/ingestion-eval");
});
