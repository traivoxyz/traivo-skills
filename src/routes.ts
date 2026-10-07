import { STOCK_DECIMALS, USDC, WETH, stockToken, type Address } from "./chain.js";

/**
 * How an asset is swapped against USDC on Uniswap V3 (Ethereum):
 *  - "stock": tokenized stock (Ondo Global Markets token), direct USDC pool.
 *  - "eth": native ETH through the WETH/USDC 0.05% pool.
 *  - "token": any other token with a direct USDC pool or a USDC → WETH → token path.
 */
export type Route = {
  symbol: string;
  address: Address;
  decimals: number;
  kind: "stock" | "eth" | "token";
  via: "USDC" | "WETH";
  /** Fee tier of the hop that touches the token. */
  fee: number;
};

export function stockRoute(symbol: string): Route | null {
  const t = stockToken(symbol);
  if (!t?.fee) return null;
  return { symbol: t.symbol, address: t.address, decimals: STOCK_DECIMALS, kind: "stock", via: "USDC", fee: t.fee };
}

export const ETH_ROUTE: Route = {
  symbol: "ETH",
  address: WETH.address,
  decimals: 18,
  kind: "eth",
  via: "USDC",
  fee: WETH.fee,
};

export function tokenRoute(t: {
  symbol: string;
  address: Address;
  decimals: number;
  fee: number;
  via: "USDC" | "WETH";
}): Route {
  return { ...t, kind: "token" };
}

/** The other token of the pool that touches the asset (what a seller receives from that hop). */
export const quoteTokenOf = (r: Route): Address => (r.via === "USDC" ? USDC.address : WETH.address);

/** Uniswap V3 path bytes (tokenIn → … → tokenOut) for exactInput / quoteExactInput. */
export function pathFor(r: Route, side: "buy" | "sell"): `0x${string}` {
  const hex = (a: string) => a.toLowerCase().replace(/^0x/, "");
  const fee = (f: number) => f.toString(16).padStart(6, "0");
  const hops: (string | number)[] =
    r.via === "USDC" ? [USDC.address, r.fee, r.address] : [USDC.address, WETH.fee, WETH.address, r.fee, r.address];
  const seq = side === "buy" ? hops : [...hops].reverse();
  return `0x${seq.map((x) => (typeof x === "number" ? fee(x) : hex(x))).join("")}`;
}
