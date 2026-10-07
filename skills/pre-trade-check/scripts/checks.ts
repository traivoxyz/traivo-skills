/**
 * Pre-trade check rules, mirroring the checks the Traivo trade screen runs before it shows a sign button.
 * Pure functions: feed them a quote, pool and wallet facts and the gas price, get a pass / warn / fail list back.
 */
import { GAS_BUFFER, SWAP_GAS, gasSharePct, swapGasEth } from "../../../src/gas.js";

export type Level = "pass" | "warn" | "fail";
export type Check = { label: string; detail: string; level: Level };

/** Thresholds used by the Traivo trade screen. Exported so callers can show them, not to be tuned silently. */
export const THRESHOLDS = {
  /** Price impact vs a tiny probe fill: pass below, warn below `impactFailBps`, fail at or above. */
  impactPassBps: 50,
  impactFailBps: 200,
  /** Premium/discount vs the outside reference: pass below, warn below `premiumFailBps`, fail at or above. */
  premiumPassBps: 100,
  premiumFailBps: 300,
  /** A share reference older than this is the last close (US market likely closed). */
  staleReferenceS: 6 * 3600,
  /** Exit liquidity (USDC/WETH in the routed pool, USD): fail below / warn below. */
  exitFailUsd: 2_500,
  exitWarnUsd: 25_000,
  /** Trade size as a share of exit liquidity: fail above / warn above. */
  exitFailShare: 0.2,
  exitWarnShare: 0.05,
  /** Slippage limits above this get a warning. */
  slippagePassBps: 100,
  /** Price impact above this gets an MEV (sandwich) warning. */
  mevWarnBps: 50,
  /** Gas budget per swap and its buffer (see src/gas.ts). */
  swapGas: SWAP_GAS,
  gasBuffer: GAS_BUFFER,
  /** Gas as a % of the trade size: warn above, fail above. */
  gasWarnPct: 1,
  gasFailPct: 5,
} as const;

export type QuoteFacts = {
  /** Input amount: USDC for a buy, asset units for a sell. */
  amountIn: number;
  /** Output amount: asset units for a buy, USDC for a sell. Needed to size a sell in USD. */
  amountOut?: number | null;
  impactBps: number | null;
  /** Premium (+) / discount (−) of the quoted price vs the reference, in bps. Null when there is no reference. */
  premiumBps: number | null;
  /** Seconds since the reference last updated. */
  referenceAge?: number | null;
};

export type CheckOptions = {
  symbol: string;
  side: "buy" | "sell";
  kind: "stock" | "eth" | "token";
  /** Which pool side a seller exits into (the hop that touches the asset). Default "USDC". */
  via?: "USDC" | "WETH";
  slippageBps: number;
  /** Balance of the input asset (USDC for a buy, the asset for a sell). Null/undefined = wallet unknown, check skipped. */
  balance?: number | null;
  /** Native ETH balance. Null/undefined = unknown, gas-balance check skipped. */
  eth?: number | null;
  /** USDC/WETH held by the routed pool, in USD. Null/undefined = not read, check skipped. */
  exitUsd?: number | null;
  /** Current gas price and ETH price. Null/undefined = unknown: gas checks are skipped (or warn when a wallet is known). */
  gas?: { gwei: number; ethUsd: number | null } | null;
  /** Name of the outside reference for non-stock assets. Defaults: Chainlink ETH/USD for ETH. */
  referenceName?: string;
};

const pct = (bps: number, d = 2) => `${(bps / 100).toFixed(d)}%`;
const signedPct = (bps: number) => `${bps >= 0 ? "+" : "−"}${pct(Math.abs(bps))}`;
const fmt = (n: number) => (Math.abs(n) >= 1 ? n.toFixed(4).replace(/\.?0+$/, "") : n.toPrecision(4));
const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;

/** USD size of the trade: USDC in for a buy, USDC out for a sell. Null for a sell without `amountOut`. */
export function tradeUsd(q: QuoteFacts, side: "buy" | "sell"): number | null {
  if (side === "buy") return q.amountIn;
  return q.amountOut != null && q.amountOut > 0 ? q.amountOut : null;
}

export function preTradeChecks(q: QuoteFacts | null | undefined, o: CheckOptions): Check[] {
  if (!q)
    return [
      { label: "Quote", detail: "No live quote: the pool could not fill this trade. Do not trade.", level: "fail" },
    ];
  const T = THRESHOLDS;
  const out: Check[] = [];
  const impact = q.impactBps ?? 0;
  out.push({
    label: "Liquidity depth",
    detail:
      q.impactBps == null
        ? "Price impact could not be measured (probe quote failed)."
        : `Price impact at this size is ${pct(impact, 3)}.`,
    level:
      q.impactBps == null ? "warn" : impact < T.impactPassBps ? "pass" : impact < T.impactFailBps ? "warn" : "fail",
  });

  const stock = o.kind === "stock";
  if (q.premiumBps != null) {
    const p = Math.abs(q.premiumBps);
    const stale = (q.referenceAge ?? 0) > T.staleReferenceS;
    const refName = o.referenceName ?? (o.kind === "eth" ? "Chainlink ETH/USD" : "the outside reference price");
    out.push({
      label: stock ? "Price vs real share" : "Price vs wider market",
      detail: stock
        ? `${signedPct(q.premiumBps)} vs the listed share${stale ? " (last close: US market likely closed)" : ""}.`
        : `${signedPct(q.premiumBps)} vs ${refName} for ${o.symbol}.`,
      level: p < T.premiumPassBps ? "pass" : p < T.premiumFailBps ? "warn" : "fail",
    });
  } else
    out.push({
      label: "Price reference",
      detail: stock
        ? "No listed share price to compare against."
        : "No outside market lists this token; the on-chain pool is the only price.",
      level: "warn",
    });

  const size = tradeUsd(q, o.side);
  if (o.exitUsd != null) {
    const e = o.exitUsd;
    const share = size != null && e > 0 ? size / e : null;
    const side = (o.via ?? "USDC") === "USDC" || o.kind === "eth" ? "USDC" : "WETH";
    out.push({
      label: "Exit liquidity",
      detail: `The pool holds about ${usd(e)} of ${side} to sell back into${share != null ? ` (this trade is ${(share * 100).toFixed(1)}% of it)` : ""}.`,
      level:
        e < T.exitFailUsd || (share ?? 0) > T.exitFailShare
          ? "fail"
          : e < T.exitWarnUsd || (share ?? 0) > T.exitWarnShare
            ? "warn"
            : "pass",
    });
  }

  out.push({
    label: "Slippage limit",
    detail: `Trade reverts if it fills more than ${pct(o.slippageBps)} worse than quoted.`,
    level: o.slippageBps <= T.slippagePassBps ? "pass" : "warn",
  });

  if (impact > T.mevWarnBps)
    out.push({
      label: "MEV exposure",
      detail: "Large relative to the pool: split it into smaller fills to cut sandwich risk.",
      level: "warn",
    });

  if (o.balance != null)
    out.push({
      label: "Balance",
      detail:
        o.balance >= q.amountIn ? "Enough in the wallet." : `Wallet has ${fmt(o.balance)}, needs ${fmt(q.amountIn)}.`,
      level: o.balance >= q.amountIn ? "pass" : "fail",
    });

  if (o.gas) {
    const needEth = swapGasEth(o.gas.gwei);
    const costUsd = o.gas.ethUsd != null && o.gas.ethUsd > 0 ? needEth * o.gas.ethUsd : null;
    if (o.eth != null) {
      const spendingEth = o.kind === "eth" && o.side === "sell";
      const left = spendingEth ? o.eth - q.amountIn : o.eth;
      out.push({
        label: "Gas",
        detail:
          left > needEth
            ? `About ${needEth.toFixed(5)} ETH${costUsd != null ? ` (${usd(costUsd)})` : ""} at ${o.gas.gwei.toFixed(2)} gwei; the wallet has enough.`
            : spendingEth
              ? "Keep enough ETH back for gas (sell slightly less)."
              : `The wallet needs about ${needEth.toFixed(5)} ETH for gas.`,
        level: left > needEth ? "pass" : "fail",
      });
    }
    const share = gasSharePct(costUsd, size);
    if (share != null && share > T.gasWarnPct)
      out.push({
        label: "Gas vs size",
        detail: `Gas is about ${share.toFixed(1)}% of this trade on Ethereum. Bigger, fewer trades cost less per dollar.`,
        level: share > T.gasFailPct ? "fail" : "warn",
      });
  } else if (o.eth != null)
    out.push({
      label: "Gas",
      detail: "Gas price unknown: could not check that the wallet holds enough ETH for gas.",
      level: "warn",
    });

  out.push(
    stock
      ? {
          label: "Contract",
          detail:
            "Ondo Global Markets tokenized stock with a verified Uniswap USDC pool. It tracks the share; it is not the share.",
          level: "pass",
        }
      : o.kind === "eth"
        ? {
            label: "Contract",
            detail: "Native ETH, swapped through the canonical WETH9 used by the Uniswap router.",
            level: "pass",
          }
        : {
            label: "Contract",
            detail: "Token with live Uniswap liquidity, not reviewed. Run rug-guard-review before sizing up.",
            level: "warn",
          },
  );
  return out;
}

/** Overall verdict: any fail blocks the trade; any warn must be shown to the trader before they sign. */
export function verdict(checks: readonly Check[]): Level {
  if (checks.some((c) => c.level === "fail")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}
