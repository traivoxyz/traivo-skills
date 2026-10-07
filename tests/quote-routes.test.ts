import { describe, expect, it } from "vitest";
import { fillPrice, impactBps, premiumBps } from "../src/quote.js";
import { ETH_ROUTE, pathFor, stockRoute, tokenRoute } from "../src/routes.js";
import { STOCK_TOKENS, USDC, WETH, stockToken } from "../src/chain.js";
import { ASK_USD, decodeTwoSided, twoSidedCalls } from "../src/quote.js";

describe("quote math", () => {
  it("fillPrice is USDC per unit on both sides", () => {
    expect(fillPrice("buy", 200, 0.8)).toBe(250);
    expect(fillPrice("sell", 2, 500)).toBe(250);
    expect(fillPrice("buy", 0, 1)).toBeNull();
    expect(fillPrice("sell", 1, 0)).toBeNull();
  });
  it("impact is positive when the fill is worse", () => {
    expect(impactBps("buy", 101, 100)).toBeCloseTo(100, 8);
    expect(impactBps("sell", 99, 100)).toBeCloseTo(100, 8);
    expect(impactBps("buy", 100, null)).toBeNull();
  });
  it("premium is signed", () => {
    expect(premiumBps(101, 100)).toBeCloseTo(100, 8);
    expect(premiumBps(99, 100)).toBeCloseTo(-100, 8);
    expect(premiumBps(99, 0)).toBeNull();
    expect(premiumBps(null, 100)).toBeNull();
  });
});

describe("routes", () => {
  it("stock routes use the pool fee tier and accept the share ticker or the token symbol", () => {
    expect(stockRoute("nvda")).toMatchObject({ symbol: "NVDA", fee: 3000, via: "USDC", kind: "stock", decimals: 18 });
    expect(stockRoute("NVDAon")).toMatchObject({ symbol: "NVDA" });
    expect(stockRoute("NOPE")).toBeNull();
    expect(stockToken("spcx")?.ticker).toBeNull();
    expect(stockToken("aaplon")?.symbol).toBe("AAPL");
  });
  it("every tokenized stock has a unique checksummable address and an Ondo token symbol", () => {
    const addrs = STOCK_TOKENS.map((t) => t.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
    for (const a of addrs) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    for (const t of STOCK_TOKENS) expect(t.token).toBe(`${t.symbol}on`);
  });
  it("encodes a direct USDC path", () => {
    const r = stockRoute("NVDA")!;
    const hex = (a: string) => a.toLowerCase().slice(2);
    expect(pathFor(r, "buy")).toBe(`0x${hex(USDC.address)}000bb8${hex(r.address)}`);
    expect(pathFor(r, "sell")).toBe(`0x${hex(r.address)}000bb8${hex(USDC.address)}`);
  });
  it("encodes a USDC → WETH → token path and its reverse", () => {
    const t = tokenRoute({
      symbol: "X",
      address: "0x00000000000000000000000000000000000000aa",
      decimals: 18,
      fee: 10000,
      via: "WETH",
    });
    const hex = (a: string) => a.toLowerCase().slice(2);
    expect(pathFor(t, "buy")).toBe(`0x${hex(USDC.address)}0001f4${hex(WETH.address)}002710${hex(t.address)}`);
    expect(pathFor(t, "sell")).toBe(`0x${hex(t.address)}002710${hex(WETH.address)}0001f4${hex(USDC.address)}`);
    expect(ETH_ROUTE.fee).toBe(500);
  });
});

describe("two-sided quotes", () => {
  const r = stockRoute("NVDA")!;
  it("sells one unit and buys with ASK_USD of USDC", () => {
    const [bid, ask] = twoSidedCalls(r);
    expect(bid.functionName).toBe("quoteExactInputSingle");
    expect(bid.args[0]).toMatchObject({ tokenIn: r.address, tokenOut: USDC.address, amountIn: 10n ** 18n });
    expect(ask.args[0]).toMatchObject({ tokenIn: USDC.address, tokenOut: r.address, amountIn: 1_000_000_000n });
    expect(ASK_USD).toBe(1_000);
  });
  it("decodes bid and ask, null on failure or zero", () => {
    const ok = (v: bigint) => ({ status: "success" as const, result: [v, 0n, 0, 0n] });
    expect(decodeTwoSided(r, ok(180_000_000n), ok(5n * 10n ** 18n))).toEqual({ bid: 180, ask: 200 });
    expect(decodeTwoSided(r, { status: "failure" }, ok(0n))).toEqual({ bid: null, ask: null });
  });
  it("uses a path quote for WETH-routed tokens", () => {
    const t = tokenRoute({
      symbol: "X",
      address: "0x00000000000000000000000000000000000000aa",
      decimals: 9,
      fee: 3000,
      via: "WETH",
    });
    const [bid] = twoSidedCalls(t);
    expect(bid.functionName).toBe("quoteExactInput");
    expect(bid.args[1]).toBe(10n ** 9n);
  });
});
