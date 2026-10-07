import { readFileSync } from "node:fs";
import { erc20Abi, formatUnits, getAddress, isAddress, toFunctionSelector, type PublicClient } from "viem";
import { ownerAbi, poolAbi } from "../../../src/abi.js";
import { USDC, WETH, type Address } from "../../../src/chain.js";
import { isMain, num, parseFlags, runCli, str } from "../../../src/cli.js";
import { readClient } from "../../../src/client.js";
import { readEthUsd } from "../../../src/feed.js";
import { exitUsd } from "../../../src/liquidity.js";
import {
  RISKY_FUNCTIONS,
  rugReview,
  rugVerdict,
  scanSelectors,
  top10Share,
  type RiskGroup,
  type RugFacts,
} from "./review.js";

const BURN = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"];
/** keccak256("eip1967.proxy.implementation") - 1 */
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const RISKY_SELECTORS = Object.fromEntries(
  Object.entries(RISKY_FUNCTIONS).map(([g, sigs]) => [g, sigs.map((s) => toFunctionSelector(`function ${s}`))]),
) as Record<RiskGroup, string[]>;

/** Read the on-chain facts for a token + its pool (eth_call / getCode / getStorageAt only). */
export async function readRugFacts(
  client: PublicClient,
  args: {
    token: Address;
    pool: Address;
    deployer?: Address;
    poolCreatedAt?: number;
    holders?: { address: string; balance: number }[];
  },
): Promise<{ facts: RugFacts; raw: Record<string, unknown> }> {
  const { token, pool } = args;
  const [symbol, decimals, supplyRaw, code, implSlot, owner, t0, t1] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    client.getCode({ address: token }).catch(() => null),
    client.getStorageAt({ address: token, slot: EIP1967_IMPL }).catch(() => undefined),
    client.readContract({ address: token, abi: ownerAbi, functionName: "owner" }).then(
      (a) => a,
      () => "none" as const,
    ),
    client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "token1" }),
  ]);
  const pair = [t0.toLowerCase(), t1.toLowerCase()];
  if (!pair.includes(token.toLowerCase())) throw new Error("pool does not contain the token");
  const quote = pair.find((a) => a !== token.toLowerCase())!;
  const quoteIsUsdc = quote === USDC.address.toLowerCase();
  const quoteIsWeth = quote === WETH.address.toLowerCase();

  const dec = Number(decimals);
  const totalSupply = Number(formatUnits(supplyRaw, dec));
  const [poolTokenRaw, poolQuoteRaw, deployerRaw, ethUsd] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
    client.readContract({ address: getAddress(quote), abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
    args.deployer
      ? client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [args.deployer] })
      : Promise.resolve(null),
    quoteIsWeth ? readEthUsd(client).then((r) => r?.price ?? null) : Promise.resolve(null),
  ]);
  const quoteDecimals = quoteIsUsdc ? USDC.decimals : quoteIsWeth ? WETH.decimals : null;
  const quoteReserve = quoteDecimals === null ? null : Number(formatUnits(poolQuoteRaw, quoteDecimals));
  const exit = exitUsd(getAddress(quote), poolQuoteRaw, ethUsd);

  const ownerStatus: RugFacts["owner"] =
    owner === "none"
      ? { status: "none" }
      : BURN.some((b) => b.toLowerCase() === owner.toLowerCase())
        ? { status: "renounced", address: owner }
        : { status: "active", address: owner };

  const facts: RugFacts = {
    symbol,
    // viem returns undefined for an address without code; null = the read failed.
    hasCode: code === null ? null : !!code && code !== "0x",
    owner: ownerStatus,
    proxy: implSlot === undefined ? null : BigInt(implSlot) !== 0n,
    riskyGroups: code ? scanSelectors(code, RISKY_SELECTORS) : code === null ? null : [],
    exitUsd: exit,
    poolAgeHours: args.poolCreatedAt ? (Date.now() / 1000 - args.poolCreatedAt) / 3600 : null,
    top10Share: args.holders ? top10Share(args.holders, totalSupply, [pool, ...BURN]) : null,
    deployerShare:
      deployerRaw === null ? null : totalSupply > 0 ? Number(formatUnits(deployerRaw, dec)) / totalSupply : null,
  };
  return {
    facts,
    raw: {
      token,
      pool,
      quoteToken: quoteIsUsdc ? "USDC" : quoteIsWeth ? "WETH" : getAddress(quote),
      totalSupply,
      poolTokenShare: totalSupply > 0 ? Number(formatUnits(poolTokenRaw, dec)) / totalSupply : null,
      quoteReserve,
      ethUsd,
      block: (await client.getBlockNumber()).toString(),
    },
  };
}

if (isMain(import.meta.url)) {
  void runCli(async () => {
    const f = parseFlags(process.argv.slice(2));
    const token = str(f, "token");
    const pool = str(f, "pool");
    if (!token || !isAddress(token) || !pool || !isAddress(pool))
      throw new Error(
        "usage: --token <0x…> --pool <0x…> [--deployer <0x…>] [--pool-created-at <unix seconds>] [--holders holders.json]",
      );
    const deployer = str(f, "deployer");
    if (deployer && !isAddress(deployer)) throw new Error("--deployer must be a 0x address");
    const holdersFile = str(f, "holders");
    const holders = holdersFile
      ? (JSON.parse(readFileSync(holdersFile, "utf8")) as { address: string; balance: number }[])
      : undefined;
    const { facts, raw } = await readRugFacts(readClient(str(f, "rpc")), {
      token: getAddress(token),
      pool: getAddress(pool),
      deployer: deployer ? getAddress(deployer) : undefined,
      poolCreatedAt: num(f, "pool-created-at"),
      holders,
    });
    const checks = rugReview(facts);
    return { verdict: rugVerdict(checks), checks, facts, raw };
  });
}
