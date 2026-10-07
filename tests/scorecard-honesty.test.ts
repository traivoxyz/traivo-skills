import { describe, expect, it } from "vitest";
import golden from "./golden/scorecard-grades.json";
import {
  DEFAULT_HORIZON_S,
  callProblems,
  callReturnPct,
  gradeAt,
  gradePath,
  makeCall,
  summarize,
  type Call,
  type Grade,
} from "../skills/scorecard-honesty/scripts/call.js";

const input = {
  symbol: "nvda",
  side: "buy" as const,
  entry: 100,
  block: 1234n,
  createdAt: 1_000_000,
  stopPct: 3,
  takeProfitPct: 6,
  priceSource: "Uniswap V3 mid",
};

describe("makeCall", () => {
  it("produces the exact record shape the grader needs", () => {
    expect(makeCall(input)).toEqual({
      symbol: "NVDA",
      side: "buy",
      entry: 100,
      block: "1234",
      createdAt: 1_000_000,
      stop: 97,
      target: 106,
      horizonS: DEFAULT_HORIZON_S,
      priceSource: "Uniswap V3 mid",
      reference: null,
    });
  });
  it("mirrors stop and target for a sell", () => {
    const c = makeCall({ ...input, side: "sell" });
    expect([c.stop, c.target]).toEqual([103, 94]);
  });
  it("refuses to log an ungradeable call", () => {
    expect(() => makeCall({ ...input, stopPct: 0 })).toThrow(/Stop distance/);
  });
  it("lists every missing field", () => {
    expect(callProblems({})).toEqual([
      "Missing symbol.",
      "Side must be buy or sell.",
      "Entry must be a positive price read from a named source.",
      "Missing block number for the entry price.",
      "Missing timestamp.",
      "Stop distance must be > 0%.",
      "Take-profit distance must be > 0%.",
      "Name the price source.",
    ]);
    expect(callProblems({ ...input, stopPct: 100 })).toEqual(["A buy stop of 100% or more is not a stop."]);
    expect(callProblems({ ...input, block: "latest" })).toEqual(["Missing block number for the entry price."]);
    expect(callProblems({ ...input, horizonS: 0 })).toEqual(["Horizon must be positive."]);
  });
});

describe("golden grading vectors", () => {
  const call = golden.call as Call;
  for (const g of golden.cases) {
    it(g.name, () => {
      expect(gradePath(call, g.samples)).toMatchObject(g.grade);
    });
  }
});

describe("gradeAt", () => {
  const buy = makeCall(input);
  const sell = makeCall({ ...input, side: "sell" });
  it("checks the target before the stop on the same sample (stop == target edge)", () => {
    const weird: Call = { ...buy, stop: 100, target: 100 };
    expect(gradeAt(weird, 100, buy.createdAt + 1)).toMatchObject({ status: "win", reason: "tp" });
  });
  it("grades shorts the other way", () => {
    expect(gradeAt(sell, 94, sell.createdAt + 1)).toMatchObject({ status: "win", reason: "tp" });
    expect(gradeAt(sell, 103, sell.createdAt + 1)).toMatchObject({ status: "loss", reason: "sl" });
    expect(gradeAt(sell, 99, sell.createdAt + sell.horizonS)).toMatchObject({ status: "win", reason: "expiry" });
  });
  it("ignores non-positive prices", () => {
    expect(gradeAt(buy, 0, buy.createdAt + buy.horizonS)).toEqual({ status: "open" });
  });
  it("returns are from the caller's side", () => {
    expect(callReturnPct(buy, 110)).toBeCloseTo(10, 10);
    expect(callReturnPct(sell, 110)).toBeCloseTo(-10, 10);
  });
});

describe("summarize", () => {
  it("counts misses and open calls; no win rate before anything resolves", () => {
    const g: Grade[] = [
      { status: "win", reason: "tp", exit: 106, returnPct: 6, resolvedAt: 1 },
      { status: "loss", reason: "sl", exit: 97, returnPct: -3, resolvedAt: 2 },
      { status: "loss", reason: "expiry", exit: 100, returnPct: 0, resolvedAt: 3 },
      { status: "open" },
    ];
    expect(summarize(g)).toEqual({ calls: 4, open: 1, wins: 1, losses: 2, winRate: 1 / 3, avgReturnPct: 1 });
    expect(summarize([{ status: "open" }])).toMatchObject({ winRate: null, avgReturnPct: null });
  });
});
