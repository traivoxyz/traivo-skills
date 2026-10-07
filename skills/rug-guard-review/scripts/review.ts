/**
 * Rug-guard review for community tokens: turns on-chain facts into a checklist.
 * Every check can come back "unknown" when the fact was not available; unknown is never treated as safe.
 */

export type Level = "pass" | "warn" | "fail" | "unknown";
export type RugCheck = { id: string; label: string; detail: string; level: Level };

/**
 * Starting thresholds. The exit-liquidity floors match the Traivo token check; the others were chosen for this repo.
 * None are fitted to outcomes and none predict anything: change them freely, and state which values you used.
 */
export const DEFAULT_RUG_THRESHOLDS = {
  /** USDC/WETH a seller can get out of the pool, in USD: fail below, warn below `exitWarnUsd`. */
  exitFailUsd: 2_500,
  exitWarnUsd: 25_000,
  youngPoolHours: 24,
  top10WarnShare: 0.3,
  top10FailShare: 0.5,
  deployerWarnShare: 0.05,
  deployerFailShare: 0.2,
} as const;
export type RugThresholds = { [K in keyof typeof DEFAULT_RUG_THRESHOLDS]: number };

/** Function names whose selectors are looked for in the token bytecode, grouped by what they allow. */
export const RISKY_FUNCTIONS = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)"],
  pause: [
    "pause()",
    "setPaused(bool)",
    "setTradingEnabled(bool)",
    "setTrading(bool)",
    "enableTrading()",
    "openTrading()",
  ],
  blacklist: [
    "blacklist(address)",
    "setBlacklist(address,bool)",
    "addToBlacklist(address)",
    "blacklistAddress(address,bool)",
    "setBot(address,bool)",
    "setBots(address[],bool)",
    "addBots(address[])",
  ],
  tax: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTaxFee(uint256)",
    "setTaxes(uint256,uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "updateFees(uint256,uint256)",
  ],
  limits: [
    "setMaxTxAmount(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWallet(uint256)",
    "updateMaxTxnAmount(uint256)",
    "removeLimits()",
  ],
} as const;
export type RiskGroup = keyof typeof RISKY_FUNCTIONS;

export type RugFacts = {
  symbol: string;
  /** Contract code at the token address. False = no contract there; null = not read. */
  hasCode?: boolean | null;
  /** "renounced" = owner() is the zero/dead address; "active" = an owner exists; "none" = no owner() function. */
  owner: { status: "renounced" | "active" | "none"; address?: string } | null;
  /** EIP-1967 implementation slot set: the code can be swapped by an admin. */
  proxy: boolean | null;
  /** Risk groups whose selectors appear in the bytecode (heuristic scan). Null = scan not run. */
  riskyGroups: RiskGroup[] | null;
  /** Exit liquidity in USD: the USDC/WETH the pool holds, which is what a seller can get out. */
  exitUsd: number | null;
  poolAgeHours: number | null;
  /** Share (0–1) of supply held by the 10 largest holders, excluding the pool and burn addresses. */
  top10Share: number | null;
  /** Share (0–1) of supply held by the deployer address. */
  deployerShare: number | null;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export function rugReview(f: RugFacts, t: RugThresholds = DEFAULT_RUG_THRESHOLDS): RugCheck[] {
  const out: RugCheck[] = [];
  const unknown = (id: string, label: string, what: string): RugCheck => ({
    id,
    label,
    detail: `${what} Not available: treat as unchecked.`,
    level: "unknown",
  });

  if (f.hasCode === false)
    out.push({ id: "code", label: "Contract", detail: "No contract code at this address on Ethereum.", level: "fail" });

  out.push(
    f.exitUsd == null
      ? unknown("liquidity", "Exit liquidity", "The pool's USDC/WETH side could not be valued.")
      : {
          id: "liquidity",
          label: "Exit liquidity",
          detail: `About ${usd(f.exitUsd)} of USDC/WETH to sell into. Floors used: fail below ${usd(t.exitFailUsd)}, warn below ${usd(t.exitWarnUsd)}.`,
          level: f.exitUsd < t.exitFailUsd ? "fail" : f.exitUsd < t.exitWarnUsd ? "warn" : "pass",
        },
  );

  out.push(
    f.poolAgeHours == null
      ? unknown("pool-age", "Pool age", "Pool creation time was not supplied.")
      : {
          id: "pool-age",
          label: "Pool age",
          detail: `Pool is ${f.poolAgeHours < 48 ? `${f.poolAgeHours.toFixed(1)} hours` : `${(f.poolAgeHours / 24).toFixed(1)} days`} old.`,
          level: f.poolAgeHours >= t.youngPoolHours ? "pass" : "warn",
        },
  );

  out.push(
    f.top10Share == null
      ? unknown("holders", "Holder concentration", "Top-holder balances were not supplied.")
      : {
          id: "holders",
          label: "Holder concentration",
          detail: `Top 10 holders (excluding pool and burn) own ${pct(f.top10Share)} of supply.`,
          level: f.top10Share >= t.top10FailShare ? "fail" : f.top10Share >= t.top10WarnShare ? "warn" : "pass",
        },
  );

  if (f.deployerShare != null)
    out.push({
      id: "deployer",
      label: "Deployer holdings",
      detail: `Deployer wallet holds ${pct(f.deployerShare)} of supply.`,
      level: f.deployerShare >= t.deployerFailShare ? "fail" : f.deployerShare >= t.deployerWarnShare ? "warn" : "pass",
    });
  else out.push(unknown("deployer", "Deployer holdings", "Deployer address was not supplied."));

  out.push(
    f.owner == null
      ? unknown("owner", "Ownership", "owner() could not be read.")
      : f.owner.status === "renounced"
        ? { id: "owner", label: "Ownership", detail: "owner() is the zero or dead address (renounced).", level: "pass" }
        : f.owner.status === "none"
          ? {
              id: "owner",
              label: "Ownership",
              detail: "No owner() function. Other admin roles may still exist; check the verified source.",
              level: "warn",
            }
          : {
              id: "owner",
              label: "Ownership",
              detail: `${f.owner.address ? `Owner ${f.owner.address}` : "An owner"} can still call admin functions.`,
              level: "warn",
            },
  );

  out.push(
    f.proxy == null
      ? unknown("proxy", "Upgradeable code", "Proxy slot could not be read.")
      : f.proxy
        ? {
            id: "proxy",
            label: "Upgradeable code",
            detail: "EIP-1967 proxy: an admin can replace the token logic.",
            level: "warn",
          }
        : { id: "proxy", label: "Upgradeable code", detail: "No EIP-1967 implementation slot set.", level: "pass" },
  );

  if (f.riskyGroups == null) out.push(unknown("functions", "Admin functions", "Bytecode was not scanned."));
  else {
    const g = new Set(f.riskyGroups);
    const ownerLive = f.owner?.status !== "renounced";
    if (g.has("mint"))
      out.push({
        id: "mint",
        label: "Mint function",
        detail: ownerLive
          ? "A mint function exists and the owner is not renounced: supply can grow."
          : "A mint function exists; owner is renounced, but check for other minter roles.",
        level: ownerLive ? "fail" : "warn",
      });
    const named: [RiskGroup, string][] = [
      ["blacklist", "Blacklist / bot list: specific wallets can be blocked from selling."],
      ["pause", "Trading switch: transfers or trading can be turned off."],
      ["tax", "Fee setter: transfer tax can be changed after you buy."],
      ["limits", "Max-tx / max-wallet limits can be changed."],
    ];
    for (const [group, detail] of named)
      if (g.has(group)) out.push({ id: group, label: "Admin function", detail, level: "warn" });
    if (!g.size)
      out.push({
        id: "functions",
        label: "Admin functions",
        detail: "No known risky selectors found (heuristic scan, not an audit).",
        level: "pass",
      });
  }
  return out;
}

/** Overall: fail if any check fails; warn if any warns or anything is unknown; pass only when everything passed. */
export function rugVerdict(checks: readonly RugCheck[]): "pass" | "warn" | "fail" {
  if (checks.some((c) => c.level === "fail")) return "fail";
  if (checks.some((c) => c.level === "warn" || c.level === "unknown")) return "warn";
  return "pass";
}

/** Share (0–1) of supply held by the largest 10 balances, ignoring excluded addresses (pool, burn, …). */
export function top10Share(
  holders: readonly { address: string; balance: number }[],
  totalSupply: number,
  exclude: readonly string[] = [],
): number | null {
  if (!(totalSupply > 0)) return null;
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  const top = holders
    .filter((h) => !skip.has(h.address.toLowerCase()) && h.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);
  return top.reduce((s, h) => s + h.balance, 0) / totalSupply;
}

/** Which risk groups have a selector present as a PUSH4 operand in the bytecode. Heuristic: not an audit. */
export function scanSelectors(bytecode: string, selectorsByGroup: Record<RiskGroup, readonly string[]>): RiskGroup[] {
  const code = bytecode.toLowerCase().replace(/^0x/, "");
  return (Object.keys(selectorsByGroup) as RiskGroup[]).filter((group) =>
    selectorsByGroup[group].some((sel) => code.includes(`63${sel.toLowerCase().replace(/^0x/, "")}`)),
  );
}
