import { formatUnits, parseUnits, type PublicClient } from "viem";
import { quoterAbi } from "./abi.js";
import { UNISWAP_V3, USDC } from "./chain.js";
import { pathFor, type Route } from "./routes.js";

export type Side = "buy" | "sell";

/** USD sizes of the price-impact ladder (same ladder the Traivo trade screen shows). */
export const LADDER_USD = [100, 1_000, 10_000, 50_000] as const;
/** Size of the "tiny" probe trade the impact is measured against. */
export const PROBE_USD = 10;

/** USDC per unit of the asset implied by a fill. Buy: USDC in / asset out. Sell: USDC out / asset in. */
export function fillPrice(side: Side, amountIn: number, amountOut: number): number | null {
  if (!(amountIn > 0) || !(amountOut > 0)) return null;
  return side === "buy" ? amountIn / amountOut : amountOut / amountIn;
}

/** Price impact in bps of `price` vs a tiny probe fill. Positive = worse for the trader. */
export function impactBps(side: Side, price: number | null, probePrice: number | null): number | null {
  if (!price || !probePrice) return null;
  return (side === "buy" ? price / probePrice - 1 : 1 - price / probePrice) * 10_000;
}

/** Premium (+) or discount (−) of `price` over an outside reference, in bps. */
export function premiumBps(price: number | null, reference: number | null): number | null {
  if (!price || !reference || !(reference > 0)) return null;
  return (price / reference - 1) * 10_000;
}

export type Quote = {
  symbol: string;
  side: Side;
  amountIn: number;
  amountOut: number;
  price: number;
  probePrice: number | null;
  impactBps: number | null;
  depth: { usd: number; impactBps: number | null }[];
  fee: number;
  block: string;
};

/** The QuoterV2 call (single hop or path) for selling or buying `route` with `amountIn` raw units. */
export function quoteCall(route: Route, side: Side, amountIn: bigint) {
  if (route.via === "USDC") {
    const tokenIn = side === "buy" ? USDC.address : route.address;
    const tokenOut = side === "buy" ? route.address : USDC.address;
    return {
      address: UNISWAP_V3.quoterV2,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle" as const,
      args: [{ tokenIn, tokenOut, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }] as const,
    };
  }
  return {
    address: UNISWAP_V3.quoterV2,
    abi: quoterAbi,
    functionName: "quoteExactInput" as const,
    args: [pathFor(route, side), amountIn] as const,
  };
}

/**
 * Live QuoterV2 quote (eth_call only) for `amount` (USDC for a buy, asset units for a sell) plus an impact ladder.
 * Returns null when the pool cannot fill the trade.
 */
export async function quoteTrade(
  client: PublicClient,
  route: Route,
  side: Side,
  amount: number,
): Promise<Quote | null> {
  if (!(amount > 0)) return null;
  const buy = side === "buy";
  const inDec = buy ? USDC.decimals : route.decimals;
  const outDec = buy ? route.decimals : USDC.decimals;
  const units = (v: number) => parseUnits(Math.max(v, 10 ** -Math.min(inDec, 9)).toFixed(inDec), inDec);

  const run = async (sizes: number[]) => {
    const res = await client.multicall({
      contracts: sizes.map((v) => quoteCall(route, side, units(v))),
      allowFailure: true,
    });
    return res.map((r, i) => {
      if (r.status !== "success") return null;
      const raw = (r.result as readonly unknown[])[0] as bigint;
      const out = Number(formatUnits(raw, outDec));
      return fillPrice(side, sizes[i] ?? 0, out) === null ? null : out;
    });
  };

  const [first] = await run([amount]);
  if (!first) return null;
  const price = fillPrice(side, amount, first)!;
  // Convert USD sizes to input units: USDC for buys, asset units (at the quoted price) for sells.
  const toIn = (usd: number) => (buy ? usd : usd / price);
  const sizes = [toIn(PROBE_USD), ...LADDER_USD.map(toIn)];
  const [outs, block] = await Promise.all([run(sizes), client.getBlockNumber()]);
  const priceAt = (i: number) => {
    const out = outs[i];
    return out ? fillPrice(side, sizes[i] ?? 0, out) : null;
  };
  const probePrice = priceAt(0);
  return {
    symbol: route.symbol,
    side,
    amountIn: amount,
    amountOut: first,
    price,
    probePrice,
    impactBps: impactBps(side, price, probePrice),
    depth: LADDER_USD.map((usd, k) => ({ usd, impactBps: impactBps(side, priceAt(k + 1), probePrice) })),
    fee: route.fee,
    block: block.toString(),
  };
}

/** The buy side of a two-sided quote is measured by spending this much USDC; the sell side sells one unit. */
export const ASK_USD = 1_000;

/** The two QuoterV2 calls behind a bid/ask: [sell 1 unit → USDC, buy with ASK_USD USDC]. */
export function twoSidedCalls(route: Route) {
  return [
    quoteCall(route, "sell", parseUnits("1", route.decimals)),
    quoteCall(route, "buy", parseUnits(String(ASK_USD), USDC.decimals)),
  ] as const;
}

type CallResult = { status: "success" | "failure"; result?: unknown } | undefined;

/** Bid (USDC for 1 unit) and ask (USDC per unit when buying with ASK_USD) from the two call results. */
export function decodeTwoSided(route: Route, bidRes: CallResult, askRes: CallResult) {
  let bid: number | null = null;
  let ask: number | null = null;
  if (bidRes?.status === "success") {
    const v = Number(formatUnits((bidRes.result as readonly bigint[])[0]!, USDC.decimals));
    bid = v > 0 ? v : null;
  }
  if (askRes?.status === "success") {
    const got = Number(formatUnits((askRes.result as readonly bigint[])[0]!, route.decimals));
    ask = got > 0 ? ASK_USD / got : null;
  }
  return { bid, ask };
}
