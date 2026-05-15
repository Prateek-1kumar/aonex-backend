import { describe, it, expect } from "bun:test";
import { isCaptchaWall } from "./captcha-detect.js";

describe("isCaptchaWall", () => {
  it("returns true for small body with captcha keyword", () => {
    const body = "<html><body>Robot Check please solve captcha</body></html>";
    expect(isCaptchaWall(body)).toBe(true);
  });

  it("returns false for large normal pages", () => {
    const body = "<html><body>" + "X".repeat(50_000) + "</body></html>";
    expect(isCaptchaWall(body)).toBe(false);
  });

  it("returns false for small body without keyword", () => {
    expect(isCaptchaWall("<html><body>Hello</body></html>")).toBe(false);
  });
});
