import { describe, expect, it } from "vitest";
import { readClient } from "../src/client.js";
import { readEthUsd } from "../src/feed.js";
import { readGasGwei } from "../src/gas.js";
import { readExitLiquidity } from "../src/liquidity.js";
import { ETH_ROUTE, stockRoute } from "../src/routes.js";
import { checkTrade } from "../skills/pre-trade-check/scripts/check-trade.js";
import { stockBoard } from "../skills/tokenized-stock-vs-share/scripts/board.js";
import { poolFlows } from "../skills/explain-this-move/scripts/flows.js";
import { WETH } from "../src/chain.js";

// Live Ethereum mainnet reads. Run with: pnpm test:network (sets TRAIVO_NETWORK_TESTS=1).
// The listed share price comes from a public web endpoint that can rate-limit; tests accept a missing reference.
const live = !!process.env.TRAIVO_NETWORK_TESTS;

describe.skipIf(!live)("live Ethereum mainnet (read-only)", () => {
  const client = readClient();
  it("is chain 1", async () => {
    expect(await client.getChainId()).toBe(1);
  });
  it("reads gas and Chainlink ETH/USD", async () => {
    expect(await readGasGwei(client)).toBeGreaterThan(0);
    expect((await readEthUsd(client))!.price).toBeGreaterThan(100);
  });
  it("reads the tokenized stock board", async () => {
    const board = await stockBoard(client, ["NVDA", "SPCX"]);
    const nvda = board.rows.find((r) => r.symbol === "NVDA")!;
    expect(nvda.mid).toBeGreaterThan(0);
    expect(nvda.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(nvda.exitUsd).toBeGreaterThan(0);
    if (nvda.reference === null) console.warn("share reference unavailable (rate limited?)");
    expect(board.rows.find((r) => r.symbol === "SPCX")!.reference).toBeNull();
  }, 30_000);
  it("checks a small ETH buy against Chainlink with gas rows", async () => {
    const r = await checkTrade(client, { route: ETH_ROUTE, side: "buy", amount: 100, slippageBps: 50 });
    expect(r.quote?.price).toBeGreaterThan(100);
    expect(r.referenceSource).toBe("Chainlink ETH/USD");
    expect(r.checks.map((c) => c.label)).toContain("Price vs wider market");
    expect(r.checks.map((c) => c.label)).toContain("Exit liquidity");
    expect(r.gas.gwei).toBeGreaterThan(0);
  }, 30_000);
  it("checks a tokenized stock buy", async () => {
    const r = await checkTrade(client, { route: stockRoute("NVDA")!, side: "buy", amount: 500, slippageBps: 50 });
    expect(r.quote?.price).toBeGreaterThan(0);
    expect(r.checks.find((c) => c.label === "Contract")!.detail).toMatch(/Ondo/);
  }, 30_000);
  it("reads the WETH/USDC pool's exit liquidity and recent swap flows", async () => {
    const exit = await readExitLiquidity(client, ETH_ROUTE, (await readEthUsd(client))!.price);
    expect(exit!.exitUsd).toBeGreaterThan(1_000_000);
    const flows = await poolFlows(client, { pool: exit!.pool, token: WETH.address, lookback: 50, chunk: 50 });
    expect(flows.quote).toBe("USDC");
    expect(flows.summary.swaps).toBeGreaterThan(0);
    expect(flows.range.hours).toBeGreaterThan(0);
  }, 60_000);
});
