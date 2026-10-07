import { erc20Abi, formatUnits, type PublicClient } from "viem";
import { factoryAbi } from "./abi.js";
import { UNISWAP_V3, USDC, WETH, type Address } from "./chain.js";
import { quoteTokenOf, type Route } from "./routes.js";

const ZERO = /^0x0{40}$/i;

/** The Uniswap V3 pool of the hop that touches the asset (factory.getPool), or null when it does not exist. */
export async function routedPool(client: PublicClient, route: Route): Promise<Address | null> {
  const pool = await client.readContract({
    address: UNISWAP_V3.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [route.address, quoteTokenOf(route), route.fee],
  });
  return ZERO.test(pool) ? null : pool;
}

/**
 * Exit liquidity of a pool in USD: the USDC or WETH it holds (USDC = $1, WETH at `ethUsd`). That is what a seller can
 * actually get out. The asset side is ignored on purpose: a pool full of the token and empty of USDC/WETH looks deep
 * but cannot absorb a sell.
 */
export function exitUsd(quoteToken: Address, rawBalance: bigint, ethUsd: number | null): number | null {
  const isUsdc = quoteToken.toLowerCase() === USDC.address.toLowerCase();
  const isWeth = quoteToken.toLowerCase() === WETH.address.toLowerCase();
  if (isUsdc) return Number(formatUnits(rawBalance, USDC.decimals));
  if (isWeth && ethUsd != null && ethUsd > 0) return Number(formatUnits(rawBalance, WETH.decimals)) * ethUsd;
  return null;
}

/** Read the routed pool's exit liquidity. Null when the pool or the ETH price (for WETH pools) is unknown. */
export async function readExitLiquidity(
  client: PublicClient,
  route: Route,
  ethUsd: number | null,
): Promise<{ pool: Address; exitUsd: number | null } | null> {
  const pool = await routedPool(client, route).catch(() => null);
  if (!pool) return null;
  const other = quoteTokenOf(route);
  const raw = await client
    .readContract({ address: other, abi: erc20Abi, functionName: "balanceOf", args: [pool] })
    .catch(() => null);
  return { pool, exitUsd: raw == null ? null : exitUsd(other, raw, ethUsd) };
}
