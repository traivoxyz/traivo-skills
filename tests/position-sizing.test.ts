import { describe, expect, it } from "vitest";
import { buildPlan, levelsFromPct, rMultiple, sizePosition } from "../skills/position-sizing/scripts/size.js";
import { gasSharePct, swapGasEth, swapGasUsd } from "../src/gas.js";

describe("sizePosition", () => {
  it("sizes so the stop loses exactly max loss", () => {
    const r = sizePosition({ entry: 100, stop: 97, maxLoss: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sizeTokens).toBeCloseTo(16.6667, 4);
    expect(r.sizeUsd).toBeCloseTo(1666.667, 3);
    expect(r.riskPerToken).toBe(3);
    expect(r.lossAtStop).toBeCloseTo(50, 10);
  });
  it("works for a short (stop above entry)", () => {
    const r = sizePosition({ entry: 50, stop: 55, maxLoss: 100 });
    expect(r.ok && r.sizeTokens).toBe(20);
  });
  it("a cost buffer only makes the size smaller", () => {
    const plain = sizePosition({ entry: 100, stop: 97, maxLoss: 50 });
    const costed = sizePosition({ entry: 100, stop: 97, maxLoss: 50, costBps: 100 });
    expect(plain.ok && costed.ok).toBe(true);
    if (!plain.ok || !costed.ok) return;
    expect(costed.riskPerToken).toBe(4);
    expect(costed.sizeTokens).toBeCloseTo(12.5, 10);
    expect(costed.sizeTokens).toBeLessThan(plain.sizeTokens);
  });
  it.each([
    [{ entry: 0, stop: 1, maxLoss: 10 }, /entry/],
    [{ entry: 100, stop: 100, maxLoss: 10 }, /stop/],
    [{ entry: 100, stop: -1, maxLoss: 10 }, /stop/],
    [{ entry: 100, stop: 90, maxLoss: 0 }, /max loss/],
    [{ entry: 100, stop: 90, maxLoss: 10, costBps: -1 }, /costBps/],
    [{ entry: 100, stop: 90, maxLoss: 10, gasUsd: -1 }, /gasUsd/],
    [{ entry: 100, stop: 90, maxLoss: 10, gasUsd: 10 }, /too small for Ethereum/],
  ])("rejects %j", (input, msg) => {
    const r = sizePosition(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe("Ethereum gas", () => {
  it("prices one swap at 250k gas × gwei × 1.3", () => {
    expect(swapGasEth(10)).toBeCloseTo(0.00325, 12);
    expect(swapGasUsd(10, 3000)).toBeCloseTo(9.75, 9);
    expect(swapGasUsd(10, 3000, 2)).toBeCloseTo(19.5, 9);
    expect(swapGasUsd(10, null)).toBeNull();
    expect(gasSharePct(9.75, 975)).toBeCloseTo(1, 9);
    expect(gasSharePct(1, 0)).toBeNull();
  });
  it("takes round-trip gas off the max loss before sizing", () => {
    const r = sizePosition({ entry: 100, stop: 97, maxLoss: 50, gasUsd: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sizeTokens).toBeCloseTo(15, 10);
    expect(r.lossAtStop).toBeCloseTo(50, 10);
    expect(r.gasUsd).toBe(5);
  });
});

describe("levelsFromPct / rMultiple", () => {
  it("mirrors levels for buys and sells", () => {
    expect(levelsFromPct(100, "buy", 3, 6)).toEqual({ stop: 97, target: 106 });
    expect(levelsFromPct(100, "sell", 3, 6)).toEqual({ stop: 103, target: 94 });
  });
  it("computes R", () => {
    expect(rMultiple({ entry: 100, stop: 97, target: 106, side: "buy" })).toBe(2);
    expect(rMultiple({ entry: 100, stop: 103, target: 94, side: "sell" })).toBe(2);
    expect(rMultiple({ entry: 100, stop: 98, target: 101, side: "buy" })).toBe(0.5);
  });
  it("returns null when the stop is on the wrong side", () => {
    expect(rMultiple({ entry: 100, stop: 101, target: 110, side: "buy" })).toBeNull();
    expect(rMultiple({ entry: 100, stop: 99, target: 90, side: "sell" })).toBeNull();
  });
});

describe("buildPlan", () => {
  it("builds a clean plan", () => {
    const p = buildPlan({ side: "buy", entry: 100, stop: 97, target: 106, maxLoss: 50 });
    expect(p.problems).toEqual([]);
    expect(p.notes).toEqual([]);
    expect(p.r).toBe(2);
    expect(p.size.ok).toBe(true);
    expect(p.gasPct).toBeNull();
  });
  it("warns when one swap's gas is over 1% of the position, blocks over 5%", () => {
    // max loss 50, 3% stop: $1,667 position without gas.
    const cheap = buildPlan({ side: "buy", entry: 100, stop: 97, target: 106, maxLoss: 50, gasUsd: 2 });
    expect(cheap.notes).toEqual([]);
    expect(cheap.problems).toEqual([]);
    const warn = buildPlan({ side: "buy", entry: 100, stop: 97, target: 106, maxLoss: 50, gasUsd: 40 });
    if (!warn.size.ok) throw new Error("expected a size");
    expect(warn.size.sizeUsd).toBeCloseTo(333.33, 2);
    expect(warn.gasPct).toBeCloseTo(6, 6);
    expect(warn.problems[0]).toMatch(/too small to be worth it on Ethereum/);
    const note = buildPlan({ side: "buy", entry: 100, stop: 97, target: 106, maxLoss: 50, gasUsd: 25 });
    expect(note.problems).toEqual([]);
    expect(note.notes[0]).toMatch(/Gas is about 1\.5% of this position per swap/);
  });
  it("lists every inconsistency", () => {
    const p = buildPlan({ side: "buy", entry: 100, stop: 105, target: 95, maxLoss: 50 });
    expect(p.problems).toEqual(["Stop must be below entry for a buy.", "Target must be above entry for a buy."]);
    expect(p.r).toBeNull();
    const s = buildPlan({ side: "sell", entry: 100, stop: 95, target: 105, maxLoss: 0 });
    expect(s.problems).toEqual([
      "Stop must be above entry for a sell.",
      "Target must be below entry for a sell.",
      "Need a positive max loss.",
    ]);
  });
});
