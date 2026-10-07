import { erc20Abi, formatUnits, getAddress, isAddress, type PublicClient } from "viem";
import { USDC, stockToken, type Address } from "../../../src/chain.js";
import { isMain, num, parseFlags, runCli, str } from "../../../src/cli.js";
import { readClient } from "../../../src/client.js";
import { readEthUsd } from "../../../src/feed.js";
import { readGasGwei } from "../../../src/gas.js";
import { readExitLiquidity } from "../../../src/liquidity.js";
import { premiumBps, quoteTrade } from "../../../src/quote.js";
import { ETH_ROUTE, stockRoute, tokenRoute, type Route } from "../../../src/routes.js";
import { SHARE_REF_SOURCE, fetchShareRef } from "../../../src/share.js";
import { preTradeChecks, verdict } from "./checks.js";

async function routeFromFlags(client: PublicClient, f: ReturnType<typeof parseFlags>): Promise<Route> {
  const symbol = (str(f, "symbol") ?? "").toUpperCase();
  if (symbol === "ETH") return ETH_ROUTE;
  const stock = symbol ? stockRoute(symbol) : null;
  if (stock) return stock;
  if (symbol && stockToken(symbol))
    throw new Error(`${symbol} has no Uniswap V3 USDC pool; this helper cannot quote it.`);
  const token = str(f, "token");
  const fee = num(f, "fee");
  const via = str(f, "via") ?? "USDC";
  if (!token || !isAddress(token) || fee === undefined || (via !== "USDC" && via !== "WETH"))
    throw new Error("for any other token pass --token <0x…> --fee <100|500|3000|10000> --via <USDC|WETH>");
  const address = getAddress(token);
  const [decimals, sym] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => symbol || "TOKEN"),
  ]);
  return tokenRoute({ symbol: sym, address, decimals: Number(decimals), fee, via });
}

/**
 * Read-only pre-trade check for one swap on Ethereum. Reference: the listed share for tokenized stocks, Chainlink
 * ETH/USD for ETH, a caller-supplied price for anything else. Never signs or sends anything.
 */
export async function checkTrade(
  client: PublicClient,
  args: {
    route: Route;
    side: "buy" | "sell";
    amount: number;
    slippageBps: number;
    wallet?: Address;
    reference?: number;
    referenceName?: string;
    fetchFn?: typeof fetch;
  },
) {
  const { route, side, amount } = args;
  const ethFeed = await readEthUsd(client);
  const ethUsd = ethFeed?.price ?? null;
  const [quote, gwei, exit] = await Promise.all([
    quoteTrade(client, route, side, amount),
    readGasGwei(client).catch(() => null),
    readExitLiquidity(client, route, ethUsd),
  ]);

  let reference: number | null = args.reference ?? null;
  let referenceAge: number | null = null;
  let referenceSource: string | null = reference != null ? (args.referenceName ?? "caller-supplied") : null;
  const now = Math.floor(Date.now() / 1000);
  if (reference === null && route.kind === "stock") {
    const ticker = stockToken(route.symbol)?.ticker;
    const ref = ticker ? await fetchShareRef(ticker, args.fetchFn) : null;
    if (ref) {
      reference = ref.price;
      referenceAge = now - ref.time;
      referenceSource = `${ticker} on ${SHARE_REF_SOURCE}`;
    }
  }
  if (reference === null && route.kind === "eth" && ethFeed) {
    reference = ethFeed.price;
    referenceAge = now - ethFeed.updatedAt;
    referenceSource = "Chainlink ETH/USD";
  }

  let balance: number | null = null;
  let eth: number | null = null;
  if (args.wallet) {
    const inToken = side === "buy" ? USDC.address : route.address;
    const inDec = side === "buy" ? USDC.decimals : route.decimals;
    const [raw, wei] = await Promise.all([
      route.kind === "eth" && side === "sell"
        ? client.getBalance({ address: args.wallet })
        : client.readContract({ address: inToken, abi: erc20Abi, functionName: "balanceOf", args: [args.wallet] }),
      client.getBalance({ address: args.wallet }),
    ]);
    balance = Number(formatUnits(raw, inDec));
    eth = Number(formatUnits(wei, 18));
  }
  const checks = preTradeChecks(
    quote && {
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      impactBps: quote.impactBps,
      premiumBps: premiumBps(quote.price, reference),
      referenceAge,
    },
    {
      symbol: route.symbol,
      side,
      kind: route.kind,
      via: route.via,
      slippageBps: args.slippageBps,
      balance,
      eth,
      exitUsd: exit?.exitUsd ?? null,
      gas: gwei == null ? null : { gwei, ethUsd },
      referenceName: args.referenceName,
    },
  );
  return {
    verdict: verdict(checks),
    checks,
    quote,
    reference,
    referenceAge,
    referenceSource,
    pool: exit?.pool ?? null,
    exitUsd: exit?.exitUsd ?? null,
    gas: { gwei, ethUsd },
    block: quote?.block ?? null,
  };
}

if (isMain(import.meta.url)) {
  void runCli(async () => {
    const f = parseFlags(process.argv.slice(2));
    const client = readClient(str(f, "rpc"));
    const side = (str(f, "side") ?? "buy") as "buy" | "sell";
    if (side !== "buy" && side !== "sell") throw new Error("--side must be buy or sell");
    const amount = num(f, "amount");
    if (!(amount && amount > 0)) throw new Error("--amount must be positive (USDC for a buy, asset units for a sell)");
    const wallet = str(f, "wallet");
    if (wallet && !isAddress(wallet)) throw new Error("--wallet must be a 0x address");
    return checkTrade(client, {
      route: await routeFromFlags(client, f),
      side,
      amount,
      slippageBps: num(f, "slippage-bps") ?? 50,
      wallet: wallet ? getAddress(wallet) : undefined,
      reference: num(f, "reference"),
      referenceName: str(f, "reference-name"),
    });
  });
}
