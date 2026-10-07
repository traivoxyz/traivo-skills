import { erc20Abi, formatUnits, getAddress, isAddress, type PublicClient } from "viem";
import { poolAbi, swapEvent } from "../../../src/abi.js";
import { ETHEREUM, USDC, WETH, type Address } from "../../../src/chain.js";
import { isMain, num, parseFlags, runCli, str } from "../../../src/cli.js";
import { readClient } from "../../../src/client.js";

/** One decoded pool swap, signed from the pool's point of view (+ = into the pool). */
export type RawSwap = { recipient: string; amount0: bigint; amount1: bigint; blockNumber: bigint; txHash: string };

export type FlowSummary = {
  swaps: number;
  buys: number;
  sells: number;
  /** Quote-token volume bought with (buys) and received from sells. */
  buyQuote: number;
  sellQuote: number;
  /** buyQuote − sellQuote: positive = net buying in this window. */
  netQuote: number;
  /** Largest recipients by absolute quote volume. Recipients can be routers, not end wallets. */
  topRecipients: { address: string; buyQuote: number; sellQuote: number; swaps: number }[];
  /** Blocks of the first and last swap seen (null when there were none). */
  firstSwapBlock: string | null;
  lastSwapBlock: string | null;
};

/**
 * Summarize swaps of `token` in a pool. `tokenIsToken0` says which side the token is on.
 * A buy is a swap where the token LEFT the pool (its amount is negative).
 */
export function summarizeSwaps(
  swaps: readonly RawSwap[],
  o: { tokenIsToken0: boolean; quoteDecimals: number; top?: number },
): FlowSummary {
  let buys = 0;
  let sells = 0;
  let buyQuote = 0;
  let sellQuote = 0;
  const by = new Map<string, { buyQuote: number; sellQuote: number; swaps: number }>();
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const s of swaps) {
    const tokenAmt = o.tokenIsToken0 ? s.amount0 : s.amount1;
    const quoteAmt = o.tokenIsToken0 ? s.amount1 : s.amount0;
    const q = Math.abs(Number(formatUnits(quoteAmt < 0n ? -quoteAmt : quoteAmt, o.quoteDecimals)));
    const key = s.recipient.toLowerCase();
    const r = by.get(key) ?? { buyQuote: 0, sellQuote: 0, swaps: 0 };
    r.swaps++;
    if (tokenAmt < 0n) {
      buys++;
      buyQuote += q;
      r.buyQuote += q;
    } else if (tokenAmt > 0n) {
      sells++;
      sellQuote += q;
      r.sellQuote += q;
    }
    by.set(key, r);
    if (min === null || s.blockNumber < min) min = s.blockNumber;
    if (max === null || s.blockNumber > max) max = s.blockNumber;
  }
  const topRecipients = [...by.entries()]
    .map(([address, v]) => ({ address, ...v }))
    .sort((a, b) => b.buyQuote + b.sellQuote - (a.buyQuote + a.sellQuote))
    .slice(0, o.top ?? 5);
  return {
    swaps: swaps.length,
    buys,
    sells,
    buyQuote,
    sellQuote,
    netQuote: buyQuote - sellQuote,
    topRecipients,
    firstSwapBlock: min?.toString() ?? null,
    lastSwapBlock: max?.toString() ?? null,
  };
}

/** Blocks covering `hours` on Ethereum (about one block every 12 s). */
export function blocksForHours(hours: number): number {
  if (!(hours > 0)) return 0;
  return Math.ceil((hours * 3600) / ETHEREUM.blockTimeS);
}

/** Block ranges [from, to] (inclusive) of at most `chunk` blocks covering the last `lookback` blocks up to `head`. */
export function blockChunks(head: bigint, lookback: bigint, chunk: bigint): [bigint, bigint][] {
  if (lookback <= 0n || chunk <= 0n) return [];
  const start = head - lookback + 1n > 0n ? head - lookback + 1n : 0n;
  const out: [bigint, bigint][] = [];
  for (let from = start; from <= head; from += chunk)
    out.push([from, from + chunk - 1n < head ? from + chunk - 1n : head]);
  return out;
}

/**
 * Read Swap logs of a Uniswap V3 pool on Ethereum over the last `lookback` blocks and summarize them. Read-only.
 * Public RPCs serve logs for recent blocks only (a few thousand back); deeper windows need an archive-capable RPC.
 */
export async function poolFlows(
  client: PublicClient,
  args: { pool: Address; token: Address; lookback: number; chunk: number },
) {
  const [t0, t1, head] = await Promise.all([
    client.readContract({ address: args.pool, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: args.pool, abi: poolAbi, functionName: "token1" }),
    client.getBlockNumber(),
  ]);
  const tokenIsToken0 = t0.toLowerCase() === args.token.toLowerCase();
  if (!tokenIsToken0 && t1.toLowerCase() !== args.token.toLowerCase())
    throw new Error("pool does not contain the token");
  const quote = getAddress(tokenIsToken0 ? t1 : t0);
  const quoteDecimals =
    quote.toLowerCase() === USDC.address.toLowerCase()
      ? USDC.decimals
      : quote.toLowerCase() === WETH.address.toLowerCase()
        ? WETH.decimals
        : Number(await client.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }));
  const swaps: RawSwap[] = [];
  const chunks = blockChunks(head, BigInt(args.lookback), BigInt(args.chunk));
  for (const [fromBlock, toBlock] of chunks) {
    const logs = await client.getLogs({ address: args.pool, event: swapEvent, fromBlock, toBlock });
    for (const l of logs)
      swaps.push({
        recipient: l.args.recipient ?? "0x",
        amount0: l.args.amount0 ?? 0n,
        amount1: l.args.amount1 ?? 0n,
        blockNumber: l.blockNumber ?? 0n,
        txHash: l.transactionHash ?? "",
      });
  }
  const quoteSymbol =
    quote.toLowerCase() === USDC.address.toLowerCase()
      ? "USDC"
      : quote.toLowerCase() === WETH.address.toLowerCase()
        ? "WETH"
        : quote;
  // Describe the window in time from block timestamps, not from an assumed block time.
  const first = chunks[0]?.[0];
  const [fromTs, toTs] = await Promise.all([
    first === undefined ? null : client.getBlock({ blockNumber: first }).then((b) => Number(b.timestamp)),
    client.getBlock({ blockNumber: head }).then((b) => Number(b.timestamp)),
  ]);
  const range = {
    fromBlock: first?.toString() ?? null,
    toBlock: head.toString(),
    fromTime: fromTs === null ? null : new Date(fromTs * 1000).toISOString(),
    toTime: new Date(toTs * 1000).toISOString(),
    hours: fromTs === null ? null : Number(((toTs - fromTs) / 3600).toFixed(2)),
  };
  return {
    pool: args.pool,
    token: args.token,
    quote: quoteSymbol,
    range,
    summary: summarizeSwaps(swaps, { tokenIsToken0, quoteDecimals }),
  };
}

if (isMain(import.meta.url)) {
  void runCli(async () => {
    const f = parseFlags(process.argv.slice(2));
    const pool = str(f, "pool");
    const token = str(f, "token");
    if (!pool || !isAddress(pool) || !token || !isAddress(token))
      throw new Error(
        "usage: --pool <0x…> --token <0x…> [--blocks 3000 | --hours 10] [--chunk 1000] [--rpc <log-capable RPC>]",
      );
    const hours = num(f, "hours");
    return poolFlows(readClient(str(f, "rpc")), {
      pool: getAddress(pool),
      token: getAddress(token),
      lookback: num(f, "blocks") ?? (hours !== undefined ? blocksForHours(hours) : 3_000),
      chunk: num(f, "chunk") ?? 1_000,
    });
  });
}
