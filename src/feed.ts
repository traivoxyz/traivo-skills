import { formatUnits, type PublicClient } from "viem";
import { feedAbi } from "./abi.js";
import { CHAINLINK_ETH_USD, FEED_DECIMALS, type Address } from "./chain.js";

export type FeedRead = { price: number; updatedAt: number } | null;

/** Read a Chainlink feed's latest answer (8 decimals). Null when the call fails or the answer is not positive. */
export async function readFeed(client: PublicClient, feed: Address): Promise<FeedRead> {
  try {
    const [, answer, , updatedAt] = await client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "latestRoundData",
    });
    if (answer <= 0n) return null;
    return { price: Number(formatUnits(answer, FEED_DECIMALS)), updatedAt: Number(updatedAt) };
  } catch {
    return null;
  }
}

/** Chainlink ETH/USD on Ethereum: the outside reference for ETH, and the ETH price used to value gas and WETH. */
export const readEthUsd = (client: PublicClient): Promise<FeedRead> => readFeed(client, CHAINLINK_ETH_USD);
