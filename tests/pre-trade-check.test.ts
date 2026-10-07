import { describe, expect, it } from "vitest";
import golden from "./golden/pre-trade-checks.json";
import {
  THRESHOLDS,
  preTradeChecks,
  verdict,
  type CheckOptions,
  type QuoteFacts,
} from "../skills/pre-trade-check/scripts/checks.js";

const base: CheckOptions = { symbol: "NVDA", side: "buy", kind: "stock", slippageBps: 50 };
const levelOf = (checks: ReturnType<typeof preTradeChecks>, label: string) =>
  checks.find((c) => c.label === label)?.level;

describe("golden vectors", () => {
  for (const g of golden) {
    it(g.name, () => {
      const checks = preTradeChecks(g.quote as QuoteFacts, g.options as CheckOptions);
      expect(Object.fromEntries(checks.map((c) => [c.label, c.level]))).toEqual(g.levels);
      expect(verdict(checks)).toBe(g.verdict);
    });
  }
});

describe("preTradeChecks thresholds", () => {
  const q = (o: Partial<QuoteFacts>): QuoteFacts => ({
    amountIn: 100,
    impactBps: 0,
    premiumBps: 0,
    referenceAge: 0,
    ...o,
  });

  it("mirrors the trade screen constants", () => {
    expect(THRESHOLDS).toMatchObject({
      impactPassBps: 50,
      impactFailBps: 200,
      premiumPassBps: 100,
      premiumFailBps: 300,
      slippagePassBps: 100,
      exitFailUsd: 2_500,
      exitWarnUsd: 25_000,
      exitFailShare: 0.2,
      exitWarnShare: 0.05,
      swapGas: 250_000,
      gasBuffer: 1.3,
      gasWarnPct: 1,
      gasFailPct: 5,
    });
  });
  it.each([
    [49.99, "pass"],
    [50, "warn"],
    [199.99, "warn"],
    [200, "fail"],
  ])("impact %d bps → %s", (impactBps, level) => {
    expect(levelOf(preTradeChecks(q({ impactBps }), base), "Liquidity depth")).toBe(level);
  });
  it.each([
    [99.9, "pass"],
    [-100, "warn"],
    [299, "warn"],
    [-300, "fail"],
  ])("premium %d bps → %s", (premiumBps, level) => {
    expect(levelOf(preTradeChecks(q({ premiumBps }), base), "Price vs real share")).toBe(level);
  });
  it("flags a last-close reference in the detail without changing the level", () => {
    const c = preTradeChecks(q({ premiumBps: 10, referenceAge: 6 * 3600 + 1 }), base).find(
      (x) => x.label === "Price vs real share",
    )!;
    expect(c.level).toBe("pass");
    expect(c.detail).toMatch(/last close/);
    const fresh = preTradeChecks(q({ premiumBps: 10, referenceAge: 6 * 3600 }), base).find(
      (x) => x.label === "Price vs real share",
    )!;
    expect(fresh.detail).not.toMatch(/last close/);
  });
  it("formats signed premiums", () => {
    expect(preTradeChecks(q({ premiumBps: -25 }), base).find((x) => x.label === "Price vs real share")!.detail).toMatch(
      /^−0\.25%/,
    );
  });
  it("names the outside reference for non-stock assets (Chainlink ETH/USD by default for ETH)", () => {
    const eth = { ...base, kind: "eth" as const, symbol: "ETH" };
    expect(preTradeChecks(q({ premiumBps: 5 }), eth).find((x) => x.label === "Price vs wider market")!.detail).toMatch(
      /vs Chainlink ETH\/USD for ETH/,
    );
    const c = preTradeChecks(q({ premiumBps: 5 }), { ...eth, referenceName: "the perp mid" });
    expect(c.find((x) => x.label === "Price vs wider market")!.detail).toMatch(/the perp mid for ETH/);
  });
  it("says the listed share is the last close when the reference is old", () => {
    const d = preTradeChecks(q({ premiumBps: 10, referenceAge: 6 * 3600 + 1 }), base).find(
      (x) => x.label === "Price vs real share",
    )!.detail;
    expect(d).toMatch(/vs the listed share \(last close/);
  });
  it("applies the exit liquidity floors and share of pool", () => {
    const lvl = (exitUsd: number, amountIn = 100) =>
      levelOf(preTradeChecks(q({ amountIn }), { ...base, exitUsd }), "Exit liquidity");
    expect(lvl(2_499)).toBe("fail");
    expect(lvl(2_500)).toBe("warn");
    expect(lvl(24_999)).toBe("warn");
    expect(lvl(25_000)).toBe("pass");
    expect(lvl(100_000, 5_000)).toBe("pass");
    expect(lvl(100_000, 5_001)).toBe("warn");
    expect(lvl(100_000, 20_001)).toBe("fail");
  });
  it("sizes a sell by its USDC out for exit and gas checks, and skips the share when out is unknown", () => {
    const sell = { ...base, side: "sell" as const, exitUsd: 30_000, gas: { gwei: 2, ethUsd: 4000 } };
    const known = preTradeChecks(q({ amountIn: 1, amountOut: 50 }), sell);
    expect(known.find((c) => c.label === "Exit liquidity")!.detail).toMatch(/0\.2% of it/);
    expect(levelOf(known, "Gas vs size")).toBe("fail");
    const unknown = preTradeChecks(q({ amountIn: 1 }), sell);
    expect(unknown.find((c) => c.label === "Exit liquidity")!.detail).not.toMatch(/of it/);
    expect(levelOf(unknown, "Gas vs size")).toBeUndefined();
  });
  it("prices Ethereum gas as 250k gas × gwei × 1.3", () => {
    const c = preTradeChecks(q({ amountIn: 10_000 }), { ...base, eth: 1, gas: { gwei: 10, ethUsd: 3000 } });
    expect(c.find((x) => x.label === "Gas")!.detail).toMatch(/About 0\.00325 ETH \(\$9\.75\) at 10\.00 gwei/);
    expect(levelOf(c, "Gas vs size")).toBeUndefined();
  });
  it("warns when impact could not be measured", () => {
    expect(levelOf(preTradeChecks(q({ impactBps: null }), base), "Liquidity depth")).toBe("warn");
  });
  it("skips balance and gas when the wallet is unknown", () => {
    const labels = preTradeChecks(q({}), base).map((c) => c.label);
    expect(labels).not.toContain("Balance");
    expect(labels).not.toContain("Gas");
  });
  it("gas needs strictly more than the swap's gas", () => {
    const gas = { gwei: 1, ethUsd: null };
    expect(levelOf(preTradeChecks(q({}), { ...base, eth: 0.000325, gas }), "Gas")).toBe("fail");
    expect(levelOf(preTradeChecks(q({}), { ...base, eth: 0.00033, gas }), "Gas")).toBe("pass");
    expect(levelOf(preTradeChecks(q({}), { ...base, eth: 0.00033, gas }), "Gas vs size")).toBeUndefined();
  });
  it("fails with no quote", () => {
    const c = preTradeChecks(null, base);
    expect(c).toHaveLength(1);
    expect(verdict(c)).toBe("fail");
  });
  it("verdict ranks fail > warn > pass", () => {
    expect(verdict([])).toBe("pass");
    expect(
      verdict([
        { label: "a", detail: "", level: "warn" },
        { label: "b", detail: "", level: "pass" },
      ]),
    ).toBe("warn");
    expect(
      verdict([
        { label: "a", detail: "", level: "warn" },
        { label: "b", detail: "", level: "fail" },
      ]),
    ).toBe("fail");
  });
});
