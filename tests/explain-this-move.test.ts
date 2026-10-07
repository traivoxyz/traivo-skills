import { describe, expect, it } from "vitest";
import {
  blockChunks,
  blocksForHours,
  summarizeSwaps,
  type RawSwap,
} from "../skills/explain-this-move/scripts/flows.js";
import {
  composeExplanation,
  explainProblems,
  promiseProblems,
  sentenceCount,
  type ExplainInput,
} from "../skills/explain-this-move/scripts/answer.js";

const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const tok = (n: number) => BigInt(n) * 10n ** 18n;
const swap = (recipient: string, tokenDelta: bigint, quoteDelta: bigint, block: number): RawSwap => ({
  recipient,
  amount0: tokenDelta,
  amount1: quoteDelta,
  blockNumber: BigInt(block),
  txHash: `0x${block}`,
});

describe("summarizeSwaps", () => {
  // token is token0, quote (USDC) is token1; pool view: + = into the pool
  const swaps = [
    swap("0xA", -tok(10), usdc(1000), 5), // buy 1000
    swap("0xA", -tok(5), usdc(500), 7), // buy 500
    swap("0xB", tok(3), -usdc(290), 6), // sell 290
  ];
  it("splits buys and sells and nets the quote volume", () => {
    const s = summarizeSwaps(swaps, { tokenIsToken0: true, quoteDecimals: 6 });
    expect(s).toMatchObject({
      swaps: 3,
      buys: 2,
      sells: 1,
      buyQuote: 1500,
      sellQuote: 290,
      netQuote: 1210,
      firstSwapBlock: "5",
      lastSwapBlock: "7",
    });
    expect(s.topRecipients[0]).toEqual({ address: "0xa", buyQuote: 1500, sellQuote: 0, swaps: 2 });
  });
  it("handles the token on the token1 side", () => {
    const flipped = swaps.map((x) => ({ ...x, amount0: x.amount1, amount1: x.amount0 }));
    expect(summarizeSwaps(flipped, { tokenIsToken0: false, quoteDecimals: 6 }).netQuote).toBe(1210);
  });
  it("is empty for no swaps", () => {
    expect(summarizeSwaps([], { tokenIsToken0: true, quoteDecimals: 6 })).toMatchObject({
      swaps: 0,
      netQuote: 0,
      firstSwapBlock: null,
      topRecipients: [],
    });
  });
});

describe("blockChunks", () => {
  it("covers the window in inclusive chunks", () => {
    expect(blockChunks(1000n, 250n, 100n)).toEqual([
      [751n, 850n],
      [851n, 950n],
      [951n, 1000n],
    ]);
  });
  it("converts hours to Ethereum blocks (12 s each)", () => {
    expect(blocksForHours(1)).toBe(300);
    expect(blocksForHours(10)).toBe(3_000);
    expect(blocksForHours(0.01)).toBe(3);
    expect(blocksForHours(0)).toBe(0);
  });
  it("clamps at block 0 and rejects empty input", () => {
    expect(blockChunks(5n, 100n, 10n)).toEqual([[0n, 5n]]);
    expect(blockChunks(5n, 0n, 10n)).toEqual([]);
  });
});

const good: ExplainInput = {
  symbol: "XYZ",
  lead: "Net buying in the main pool drove most of the move. One wallet accounts for most of it.",
  window: "blocks 100–200",
  claims: [
    { kind: "onchain", text: "Net +1,210 USDC of buys", source: "pool 0xabc, blocks 100–200" },
    { kind: "news", text: "No dated news in the window", source: "news search, 2026-10-07" },
  ],
  unknowns: ["Whether the buyer is one person or a router aggregating many"],
};

describe("explain answer", () => {
  it("renders the canonical layout", () => {
    const md = composeExplanation(good);
    expect(md.split("\n")[0]).toBe(good.lead);
    expect(md).toMatch(/\*\*On-chain flows\*\*\n- Net \+1,210 USDC of buys \(source: pool 0xabc/);
    expect(md).toMatch(/\*\*What is not known\*\*/);
    expect(md.indexOf("On-chain flows")).toBeLessThan(md.indexOf("News"));
    expect(md.trimEnd().endsWith("Not financial advice.")).toBe(true);
  });
  it("rejects unsourced, unbounded or overconfident answers", () => {
    const bad: ExplainInput = {
      ...good,
      lead: "It pumped. Whales bought. It is guaranteed to continue. Buy now.",
      window: "",
      claims: [{ kind: "wallet", text: "Smart money", source: "" }],
      unknowns: [],
    };
    const p = explainProblems(bad);
    expect(p).toContain("Lead must be one or two sentences.");
    expect(p).toContain("State the time or block window the evidence covers.");
    expect(p).toContain("Claim 1 has no source.");
    expect(p).toContain("List at least one thing that is unknown (there always is one).");
    expect(p.some((x) => x.includes("guarantee"))).toBe(true);
    expect(() => composeExplanation(bad)).toThrow();
    expect(explainProblems({ ...good, claims: [] })).toContain(
      "No evidence: say there is no clear cause instead of guessing.",
    );
  });
  it("detects promise wording", () => {
    expect(promiseProblems("This is risk-free")).toHaveLength(1);
    expect(promiseProblems("It will definitely go up")).toHaveLength(1);
    expect(promiseProblems("Price may fall further")).toEqual([]);
  });
  it("counts sentences without splitting decimals or abbreviations", () => {
    expect(sentenceCount("Price rose 2.5% vs. the share. Volume doubled.")).toBe(2);
    expect(sentenceCount("One sentence only")).toBe(1);
  });
});
