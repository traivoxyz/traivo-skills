import { describe, expect, it } from "vitest";
import { isMain, num, parseFlags, str } from "../src/cli.js";

describe("parseFlags", () => {
  it("parses values, booleans and = syntax", () => {
    const f = parseFlags(["log", "--symbol", "NVDA", "--json", "--stop-pct=3", "--side", "buy"]);
    expect(f).toEqual({ symbol: "NVDA", json: true, "stop-pct": "3", side: "buy" });
    expect(str(f, "symbol")).toBe("NVDA");
    expect(str(f, "json")).toBeUndefined();
    expect(num(f, "stop-pct")).toBe(3);
    expect(num(f, "missing")).toBeUndefined();
  });
  it("rejects non-numbers", () => {
    expect(() => num({ x: "abc" }, "x")).toThrow(/--x must be a number/);
  });
  it("isMain is false for an imported module", () => {
    expect(isMain(import.meta.url)).toBe(false);
  });
});
