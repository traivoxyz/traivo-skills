/**
 * Logging a call so it can be graded later, and grading it the way Traivo's public scorecard does:
 *  - win if the price reaches the target before the stop, loss if it reaches the stop first;
 *  - still open after the horizon (7 days by default) → closed at the price then: win if that return is > 0;
 *  - prices are samples (about once a minute in Traivo's grader), so a wick between samples can be missed;
 *  - returns ignore fees and slippage.
 */

export type Side = "buy" | "sell";

export const DEFAULT_HORIZON_S = 7 * 86_400;

/** Everything needed to grade a call later from public data. */
export type Call = {
  symbol: string;
  side: Side;
  /** Price the call is graded from (on-chain mid at logging time), in USD. */
  entry: number;
  /** Block the entry price was read at, as a decimal string. */
  block: string;
  /** Unix seconds when the call was logged. */
  createdAt: number;
  stop: number;
  target: number;
  horizonS: number;
  /** Where the entry price came from, e.g. "uniswap-v3 mid" (so a verifier can re-read it). */
  priceSource: string;
  /** Optional outside reference at logging time (listed share for tokenized stocks, Chainlink ETH/USD for ETH). */
  reference?: number | null;
};

export type CallInput = {
  symbol: string;
  side: Side;
  entry: number;
  block: string | bigint;
  createdAt: number;
  stopPct: number;
  takeProfitPct: number;
  horizonS?: number;
  priceSource: string;
  reference?: number | null;
};

/** Build a call record. Stop and target are fixed now, from % distances, exactly as the scorecard stores them. */
export function makeCall(i: CallInput): Call {
  const problems = callProblems(i);
  if (problems.length) throw new Error(problems.join(" "));
  const stop = i.side === "buy" ? i.entry * (1 - i.stopPct / 100) : i.entry * (1 + i.stopPct / 100);
  const target = i.side === "buy" ? i.entry * (1 + i.takeProfitPct / 100) : i.entry * (1 - i.takeProfitPct / 100);
  return {
    symbol: i.symbol.toUpperCase(),
    side: i.side,
    entry: i.entry,
    block: i.block.toString(),
    createdAt: i.createdAt,
    stop,
    target,
    horizonS: i.horizonS ?? DEFAULT_HORIZON_S,
    priceSource: i.priceSource,
    reference: i.reference ?? null,
  };
}

/** Why a call cannot be logged (empty = fine). A call without a stop, target, block or time cannot be graded. */
export function callProblems(i: Partial<CallInput>): string[] {
  const p: string[] = [];
  if (!i.symbol) p.push("Missing symbol.");
  if (i.side !== "buy" && i.side !== "sell") p.push("Side must be buy or sell.");
  if (!(Number(i.entry) > 0)) p.push("Entry must be a positive price read from a named source.");
  if (i.block === undefined || i.block === null || !/^\d+$/.test(i.block.toString()))
    p.push("Missing block number for the entry price.");
  if (!(Number(i.createdAt) > 0)) p.push("Missing timestamp.");
  if (!(Number(i.stopPct) > 0)) p.push("Stop distance must be > 0%.");
  if (i.side === "buy" && Number(i.stopPct) >= 100) p.push("A buy stop of 100% or more is not a stop.");
  if (!(Number(i.takeProfitPct) > 0)) p.push("Take-profit distance must be > 0%.");
  if (i.horizonS !== undefined && !(i.horizonS > 0)) p.push("Horizon must be positive.");
  if (!i.priceSource) p.push("Name the price source.");
  return p;
}

export type Grade =
  | { status: "open" }
  | { status: "win" | "loss"; reason: "tp" | "sl" | "expiry"; exit: number; returnPct: number; resolvedAt: number };

/** Return of the call at `price`, in %, from the caller's side (positive = the call was right). */
export function callReturnPct(c: Pick<Call, "side" | "entry">, price: number): number {
  return (c.side === "buy" ? price / c.entry - 1 : 1 - price / c.entry) * 100;
}

/**
 * Grade a call against ONE price sample at time `t`. Same rule order as the scorecard grader:
 * target hit → win; else stop hit → loss; else past horizon → win if return > 0, otherwise loss; else open.
 */
export function gradeAt(c: Call, price: number, t: number): Grade {
  if (!(price > 0)) return { status: "open" };
  const ret = callReturnPct(c, price);
  const tp = c.side === "buy" ? price >= c.target : price <= c.target;
  const sl = c.side === "buy" ? price <= c.stop : price >= c.stop;
  const expired = t >= c.createdAt + c.horizonS;
  if (!tp && !sl && !expired) return { status: "open" };
  return {
    status: tp ? "win" : sl ? "loss" : ret > 0 ? "win" : "loss",
    reason: tp ? "tp" : sl ? "sl" : "expiry",
    exit: price,
    returnPct: ret,
    resolvedAt: t,
  };
}

/** Replay time-ordered price samples; the first sample that resolves the call decides it. */
export function gradePath(c: Call, samples: readonly { t: number; price: number }[]): Grade {
  const ordered = [...samples].filter((s) => s.t >= c.createdAt).sort((a, b) => a.t - b.t);
  for (const s of ordered) {
    const g = gradeAt(c, s.price, s.t);
    if (g.status !== "open") return g;
  }
  return { status: "open" };
}

/** Summary that counts every resolved call, misses included. Win rate is null until something resolved. */
export function summarize(grades: readonly Grade[]) {
  const resolved = grades.filter((g): g is Exclude<Grade, { status: "open" }> => g.status !== "open");
  const wins = resolved.filter((g) => g.status === "win").length;
  return {
    calls: grades.length,
    open: grades.length - resolved.length,
    wins,
    losses: resolved.length - wins,
    winRate: resolved.length ? wins / resolved.length : null,
    avgReturnPct: resolved.length ? resolved.reduce((s, g) => s + g.returnPct, 0) / resolved.length : null,
  };
}
