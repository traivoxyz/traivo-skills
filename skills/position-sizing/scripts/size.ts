import { isMain, num, parseFlags, runCli, str } from "../../../src/cli.js";
import { readClient } from "../../../src/client.js";
import { readEthUsd } from "../../../src/feed.js";
import { gasSharePct, readGasGwei, swapGasUsd } from "../../../src/gas.js";

export type Side = "buy" | "sell";

/** Same bands as the pre-trade check's "Gas vs size" row: gas for one swap as a % of the position. */
export const GAS_WARN_PCT = 1;
export const GAS_FAIL_PCT = 5;

export type SizeInput = {
  entry: number;
  stop: number;
  /** Most the trader accepts losing if the stop is hit, in USD, gas included. */
  maxLoss: number;
  /**
   * Optional round-trip cost buffer in bps of entry (swap fees + expected slippage on entry and exit).
   * Default 0, which matches the Traivo trade screen. Adding it makes the size smaller, never larger.
   */
  costBps?: number;
  /**
   * Optional round-trip Ethereum gas in USD (entry swap + exit swap). It is paid whatever the size, so it comes off
   * the max loss before sizing. Default 0.
   */
  gasUsd?: number;
};

export type SizeResult =
  | { ok: true; sizeTokens: number; sizeUsd: number; riskPerToken: number; lossAtStop: number; gasUsd: number }
  | { ok: false; error: string };

/**
 * Position size so that hitting the stop loses at most `maxLoss` USD:
 * size = (maxLoss − gasUsd) / (|entry − stop| + entry × costBps / 10,000).
 */
export function sizePosition({ entry, stop, maxLoss, costBps = 0, gasUsd = 0 }: SizeInput): SizeResult {
  if (!(entry > 0)) return { ok: false, error: "Need a positive entry price." };
  if (!(maxLoss > 0)) return { ok: false, error: "Need a positive max loss." };
  if (!(costBps >= 0)) return { ok: false, error: "costBps cannot be negative." };
  if (!(gasUsd >= 0)) return { ok: false, error: "gasUsd cannot be negative." };
  const distance = Math.abs(entry - stop);
  if (!(stop > 0) || !(distance > 0))
    return { ok: false, error: "Need a stop that is positive and different from entry." };
  if (gasUsd >= maxLoss)
    return {
      ok: false,
      error: `Round-trip gas (about $${gasUsd.toFixed(2)}) uses up the whole max loss: this trade is too small for Ethereum.`,
    };
  const riskPerToken = distance + (entry * costBps) / 10_000;
  const sizeTokens = (maxLoss - gasUsd) / riskPerToken;
  return {
    ok: true,
    sizeTokens,
    sizeUsd: sizeTokens * entry,
    riskPerToken,
    lossAtStop: sizeTokens * riskPerToken + gasUsd,
    gasUsd,
  };
}

/** Stop and take-profit prices from % distances, the way the trade screen sets them. */
export function levelsFromPct(entry: number, side: Side, stopPct: number, takeProfitPct: number) {
  const stop = side === "buy" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const target = side === "buy" ? entry * (1 + takeProfitPct / 100) : entry * (1 - takeProfitPct / 100);
  return { stop, target };
}

/** Reward per unit of risk. Null when the stop is on the wrong side of entry (no defined risk). */
export function rMultiple(p: { entry: number; stop: number; target: number; side: Side }): number | null {
  const risk = p.side === "buy" ? p.entry - p.stop : p.stop - p.entry;
  const reward = p.side === "buy" ? p.target - p.entry : p.entry - p.target;
  return risk > 0 ? reward / risk : null;
}

export type Plan = {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  r: number | null;
  size: SizeResult;
  /** Gas of the entry swap as a % of the position size (null when no gas was given). */
  gasPct: number | null;
  /** Blocking issues: the plan must not be presented as ready. */
  problems: string[];
  /** Non-blocking warnings the trader must see (gas share between the warn and fail bands). */
  notes: string[];
};

/** A complete trade plan: entry, stop, target, R multiple and size, with every inconsistency listed. */
export function buildPlan(input: {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  maxLoss: number;
  costBps?: number;
  /** Round-trip gas in USD (entry + exit swaps). */
  gasUsd?: number;
}): Plan {
  const { side, entry, stop, target } = input;
  const problems: string[] = [];
  const notes: string[] = [];
  if (side === "buy" && stop >= entry) problems.push("Stop must be below entry for a buy.");
  if (side === "sell" && stop <= entry) problems.push("Stop must be above entry for a sell.");
  if (side === "buy" && target <= entry) problems.push("Target must be above entry for a buy.");
  if (side === "sell" && target >= entry) problems.push("Target must be below entry for a sell.");
  const r = rMultiple({ entry, stop, target, side });
  const size = sizePosition({
    entry,
    stop,
    maxLoss: input.maxLoss,
    costBps: input.costBps,
    gasUsd: input.gasUsd,
  });
  if (!size.ok) problems.push(size.error);
  // Bands apply to one swap (the entry), like the pre-trade check; the round trip is twice that.
  const gasPct = size.ok && input.gasUsd ? gasSharePct(input.gasUsd / 2, size.sizeUsd) : null;
  if (gasPct != null && gasPct > GAS_FAIL_PCT)
    problems.push(
      `Gas is about ${gasPct.toFixed(1)}% of this position per swap: too small to be worth it on Ethereum.`,
    );
  else if (gasPct != null && gasPct > GAS_WARN_PCT)
    notes.push(`Gas is about ${gasPct.toFixed(1)}% of this position per swap on Ethereum.`);
  return { side, entry, stop, target, r, size, gasPct, problems, notes };
}

if (isMain(import.meta.url)) {
  void runCli(async () => {
    const f = parseFlags(process.argv.slice(2));
    const side = (str(f, "side") ?? "buy") as Side;
    if (side !== "buy" && side !== "sell") throw new Error("--side must be buy or sell");
    const entry = num(f, "entry");
    const maxLoss = num(f, "max-loss");
    if (entry === undefined || maxLoss === undefined)
      throw new Error(
        "usage: --entry <price> --max-loss <usd> (--stop <price> | --stop-pct <pct>) [--target <price> | --tp-pct <pct>] [--side buy|sell] [--cost-bps <bps>] [--gas-usd <round trip> | --gwei <g> --eth-usd <p> | --live-gas]",
      );
    const stopPct = num(f, "stop-pct");
    const tpPct = num(f, "tp-pct");
    const fromPct = levelsFromPct(entry, side, stopPct ?? 0, tpPct ?? 0);
    const stop = num(f, "stop") ?? (stopPct !== undefined ? fromPct.stop : undefined);
    if (stop === undefined) throw new Error("give --stop or --stop-pct");
    const target = num(f, "target") ?? (tpPct !== undefined ? fromPct.target : undefined);
    const costBps = num(f, "cost-bps");

    let gasUsd = num(f, "gas-usd");
    let gas: { gwei: number; ethUsd: number | null } | null = null;
    if (gasUsd === undefined && f["live-gas"]) {
      const client = readClient(str(f, "rpc"));
      const [gwei, eth] = await Promise.all([readGasGwei(client), readEthUsd(client)]);
      gas = { gwei, ethUsd: eth?.price ?? null };
    } else if (gasUsd === undefined && num(f, "gwei") !== undefined)
      gas = { gwei: num(f, "gwei")!, ethUsd: num(f, "eth-usd") ?? null };
    if (gas) {
      const roundTrip = swapGasUsd(gas.gwei, gas.ethUsd, 2);
      if (roundTrip == null) throw new Error("need an ETH price (--eth-usd) to value gas");
      gasUsd = roundTrip;
    }

    if (target === undefined)
      return {
        side,
        entry,
        stop,
        gas,
        size: sizePosition({ entry, stop, maxLoss, costBps, gasUsd }),
        note: "No target given, so no R multiple. A plan needs an exit on both sides.",
      };
    return { gas, ...buildPlan({ side, entry, stop, target, maxLoss, costBps, gasUsd }) };
  });
}
