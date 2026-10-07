import { erc20Abi, type PublicClient } from "viem";
import { factoryAbi } from "../../../src/abi.js";
import { STOCK_TOKENS, UNISWAP_V3, USDC, stockToken, type Address } from "../../../src/chain.js";
import { isMain, parseFlags, runCli, str } from "../../../src/cli.js";
import { readClient } from "../../../src/client.js";
import { exitUsd } from "../../../src/liquidity.js";
import { ASK_USD, decodeTwoSided, twoSidedCalls } from "../../../src/quote.js";
import { stockRoute } from "../../../src/routes.js";
import { SHARE_REF_SOURCE, fetchShareRefs, type ShareRef } from "../../../src/share.js";
import { TOKEN_NOTE, assessPremium, midPrice, premiumBps, spreadBps, usSession } from "./premium.js";

export { ASK_USD };

const ZERO = /^0x0{40}$/i;

/**
 * Tokenized stock board: for each Ondo token, the on-chain bid (sell 1 token), ask (buy with $1,000 USDC), mid,
 * spread, the USDC the pool holds (exit liquidity), the listed share's last price and the premium.
 * Two multicalls plus one share-price fetch per ticker; read-only.
 */
export async function stockBoard(
  client: PublicClient,
  only?: string[],
  opts: { fetchFn?: typeof fetch; refs?: Map<string, ShareRef> } = {},
) {
  const wanted = only?.length ? new Set(only.map((s) => stockToken(s)?.symbol ?? s.toUpperCase())) : null;
  const tokens = STOCK_TOKENS.filter((t) => !wanted || wanted.has(t.symbol));
  const routed = tokens.map((t) => ({ t, route: stockRoute(t.symbol) }));
  const live = routed.filter((x) => x.route);

  const calls = live.flatMap(({ t, route }) => [
    ...twoSidedCalls(route!),
    {
      address: UNISWAP_V3.factory,
      abi: factoryAbi,
      functionName: "getPool" as const,
      args: [t.address, USDC.address, route!.fee] as const,
    },
  ]);
  const tickers = tokens.map((t) => t.ticker).filter((x): x is string => !!x);
  const [block, results, refs] = await Promise.all([
    client.getBlockNumber(),
    // The mixed ABI list is not expressible as one viem contract type; results are decoded per call below.
    calls.length ? client.multicall({ contracts: calls as any, allowFailure: true }) : Promise.resolve([]),
    opts.refs ?? fetchShareRefs(tickers, opts.fetchFn),
  ]);

  const pools = live.map((_, i) => {
    const r = results[3 * i + 2];
    const a = r?.status === "success" ? (r.result as Address) : null;
    return a && !ZERO.test(a) ? a : null;
  });
  const withPool = pools.filter((p): p is Address => !!p);
  const held = withPool.length
    ? await client.multicall({
        contracts: withPool.map((pool) => ({
          address: USDC.address,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [pool] as const,
        })),
        allowFailure: true,
      })
    : [];
  const exitByPool = new Map<string, number | null>(
    withPool.map((p, i) => {
      const r = held[i];
      return [p, r?.status === "success" ? exitUsd(USDC.address, r.result as bigint, null) : null];
    }),
  );

  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const session = usSession(now);

  const rows = tokens.map((t) => {
    const i = live.findIndex((x) => x.t === t);
    const route = i >= 0 ? live[i]!.route! : null;
    const { bid, ask } = route ? decodeTwoSided(route, results[3 * i], results[3 * i + 1]) : { bid: null, ask: null };
    const pool = i >= 0 ? (pools[i] ?? null) : null;
    const exit = pool ? (exitByPool.get(pool) ?? null) : null;
    const ref = t.ticker ? refs.get(t.ticker) : undefined;
    const reference = ref?.price ?? null;
    const referenceAge = ref ? nowS - ref.time : null;
    const mid = midPrice(bid, ask);
    const spread = spreadBps(bid, ask);
    const premium = premiumBps(mid, reference);
    return {
      symbol: t.symbol,
      token: t.token,
      name: t.name,
      address: t.address,
      ticker: t.ticker,
      venue: t.fee ? `Uniswap V3 ${t.fee / 10_000}% vs USDC` : "No Uniswap V3 USDC pool (not quoted here)",
      bid,
      ask,
      mid,
      spreadBps: spread,
      pool,
      exitUsd: exit,
      reference,
      referenceAge,
      premiumBps: premium,
      assessment: assessPremium({ premiumBps: premium, referenceAge, session, spreadBps: spread, exitUsd: exit }),
    };
  });
  return { block: block.toString(), session, referenceSource: SHARE_REF_SOURCE, note: TOKEN_NOTE, rows };
}

if (isMain(import.meta.url)) {
  void runCli(async () => {
    const f = parseFlags(process.argv.slice(2));
    const only = str(f, "symbols")?.toUpperCase().split(",").filter(Boolean);
    return stockBoard(readClient(str(f, "rpc")), only);
  });
}
