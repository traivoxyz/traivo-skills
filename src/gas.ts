import type { PublicClient } from "viem";

/**
 * Ethereum gas budget for one Uniswap swap, the way the Traivo trade screen estimates it: a swap is roughly
 * 150–250k gas, so budget 250k gas with a 1.3× buffer (which also covers a first-time token approval most of
 * the time) at the current gas price.
 */
export const SWAP_GAS = 250_000;
export const GAS_BUFFER = 1.3;

/** ETH needed for `swaps` swaps at `gwei`. */
export function swapGasEth(gwei: number, swaps = 1): number {
  if (!(gwei >= 0) || !(swaps >= 0)) return NaN;
  return SWAP_GAS * gwei * 1e-9 * GAS_BUFFER * swaps;
}

/** USD cost of `swaps` swaps at `gwei` and an ETH price. Null when the ETH price is unknown. */
export function swapGasUsd(gwei: number, ethUsd: number | null | undefined, swaps = 1): number | null {
  if (ethUsd == null || !(ethUsd > 0)) return null;
  return swapGasEth(gwei, swaps) * ethUsd;
}

/** Gas cost as a % of the trade's USD size. Null when either side is unknown or the size is not positive. */
export function gasSharePct(gasUsd: number | null | undefined, tradeUsd: number | null | undefined): number | null {
  if (gasUsd == null || tradeUsd == null || !(tradeUsd > 0)) return null;
  return (gasUsd / tradeUsd) * 100;
}

/** Current gas price in gwei (eth_gasPrice). */
export async function readGasGwei(client: PublicClient): Promise<number> {
  return Number(await client.getGasPrice()) / 1e9;
}
