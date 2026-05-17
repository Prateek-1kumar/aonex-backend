import { describe, it, expect } from "bun:test";
import { runDomHeuristics } from "./index.js";

const RICH_HTML = `<html><head>
<title>Aonami Vision 55 | Aonami</title>
<meta property="og:title" content="Aonami Vision 55 OLED 4K">
<meta property="og:image" content="https://shop/p.jpg">
<meta property="og:description" content="Premium OLED display with HDR10+ support and Dolby Vision.">
</head><body>
<h1>Aonami Vision 55</h1>
<nav class="breadcrumb"><a>Home</a> / <a>Electronics</a> / <a>Televisions</a> / <span>Aonami Vision 55</span></nav>
<div class="price">$799.00</div>
<select name="size"><option>55"</option><option>65"</option></select>
<table>
  <tr><th>Resolution</th><td>4K</td></tr>
  <tr><th>HDR</th><td>HDR10+</td></tr>
</table>
</body></html>`;

describe("runDomHeuristics", () => {
  it("aggregates facts from all 7 heuristics", () => {
    const { facts } = runDomHeuristics(RICH_HTML);
    const keys = new Set(facts.map((f) => f.rawKey));
    expect(keys.has("title")).toBe(true);
    expect(keys.has("description")).toBe(true);
    expect(keys.has("base_price")).toBe(true);
    expect(keys.has("image_url")).toBe(true);
    expect(keys.has("category_path")).toBe(true);
    expect(keys.has("size")).toBe(true);
    expect(keys.has("resolution")).toBe(true); // from spec table
    expect(facts.length).toBeGreaterThanOrEqual(7);
  });

  it("returns empty facts on empty HTML", () => {
    const { facts } = runDomHeuristics("<html></html>");
    expect(facts).toEqual([]);
  });
});
