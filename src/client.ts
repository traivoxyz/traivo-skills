import { createPublicClient, http, type PublicClient } from "viem";
import { ETHEREUM, ethereum } from "./chain.js";

/**
 * Read-only client for Ethereum mainnet. Uses the public RPC unless `TRAIVO_RPC_URL` (or `rpcUrl`) is set.
 * No wallet client is ever created in this repo: nothing here can sign or send a transaction.
 */
export function readClient(rpcUrl?: string): PublicClient {
  const url = rpcUrl ?? process.env.TRAIVO_RPC_URL ?? ETHEREUM.rpc;
  return createPublicClient({ chain: ethereum, transport: http(url, { timeout: 20_000 }) }) as PublicClient;
}
