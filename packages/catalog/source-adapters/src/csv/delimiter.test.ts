import { describe, expect, test } from "bun:test";
import { detectDelimiter } from "./delimiter.js";

describe("detectDelimiter", () => {
  test("plain comma", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
  });

  test("semicolon (European export)", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  test("tab and pipe", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  test("ignores delimiters inside quotes (the old sniffer's bug)", () => {
    // Semicolon-delimited, but the header has a comma inside a quoted field.
    const csv = '"Name, full";Price;Qty\n"Widget, deluxe";9.99;3';
    expect(detectDelimiter(csv)).toBe(";");
  });

  test("picks the consistent delimiter, not the noisiest line", () => {
    // Commas only appear inside a quoted description; semicolons are the real delimiter.
    const csv = 'id;title;desc\n1;Widget;"red, round, small"\n2;Gadget;"a, b, c, d"';
    expect(detectDelimiter(csv)).toBe(";");
  });

  test("empty input falls back to comma", () => {
    expect(detectDelimiter("")).toBe(",");
  });
});
