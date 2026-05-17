import { describe, it, expect } from "bun:test";
import { parseInitialState } from "./initial-state.js";

const INITIAL_STATE_HTML = `<!DOCTYPE html>
<html>
<body>
<script>
window.__INITIAL_STATE__={
  "product": {
    "title": "Aonami Pro Drill",
    "vendor": "Aonami",
    "sellingPrice": 199.99,
    "gtin": "1234567890123",
    "model": "AON-DRILL-1",
    "description": "Professional grade drill"
  }
};
</script>
</body>
</html>`;

const PRELOADED_STATE_HTML = `<!DOCTYPE html>
<html>
<body>
<script>
window.__PRELOADED_STATE__={
  "state": {
    "product": {
      "name": "Redux Drill",
      "brand": "Aonami",
      "price": 149.99
    }
  }
};
</script>
</body>
</html>`;

const EMPTY_HTML = `<!DOCTYPE html>
<html><body><p>No state here</p></body></html>`;

describe("parseInitialState", () => {
  it("happy path — extracts from window.__INITIAL_STATE__", () => {
    const result = parseInitialState(INITIAL_STATE_HTML);
    expect(result.kind).toBe("initial_state");
    expect(result.baselineConfidence).toBe(0.80);
    expect(result.facts.length).toBeGreaterThanOrEqual(5);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
    expect(byKey("gtin")?.extractedValue).toBe("1234567890123");
    expect(byKey("model_number")?.extractedValue).toBe("AON-DRILL-1");
    expect(byKey("description")?.extractedValue).toBe("Professional grade drill");
  });

  it("falls back to window.__PRELOADED_STATE__", () => {
    const result = parseInitialState(PRELOADED_STATE_HTML);
    expect(result.kind).toBe("initial_state");
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Redux Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
    expect(byKey("base_price")?.extractedValue).toBe(149.99);
  });

  it("all facts use extractionMethod=direct", () => {
    const result = parseInitialState(INITIAL_STATE_HTML);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("empty path — no state globals returns empty facts", () => {
    const result = parseInitialState(EMPTY_HTML);
    expect(result.kind).toBe("initial_state");
    expect(result.facts).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    const badHtml = `<script>window.__INITIAL_STATE__={broken json</script>`;
    const result = parseInitialState(badHtml);
    expect(result.kind).toBe("initial_state");
    expect(result.facts).toEqual([]);
  });

  it("walks payload.data.product path", () => {
    const html = `<script>window.__INITIAL_STATE__={"data":{"product":{"name":"Data Drill","price":79.99}}}</script>`;
    const result = parseInitialState(html);
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Data Drill");
    expect(byKey("base_price")?.extractedValue).toBe(79.99);
  });
});
