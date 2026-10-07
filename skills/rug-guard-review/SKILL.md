---
name: rug-guard-review
description: Review an unreviewed token on Ethereum (anything other than a tokenized stock, ETH or USDC) for rug and honeypot risk before anyone sizes into it. Covers contract presence, exit liquidity (the USDC/WETH a seller can get out of the pool), pool age, holder and deployer concentration, ownership, upgradeable proxy and risky admin functions (mint, blacklist, pause or trading switch, tax, limits). Use when the user asks if a token is safe, legit or a rug, when a new launch is discussed, or before preparing any trade in such a token. Read-only; unknown facts stay unknown.
---

# Rug-guard review

A checklist, not a verdict on the team. It says what the chain shows and, just as important, what could not be checked.

## Inputs

| Input                                             | Source                      | If missing         |
| ------------------------------------------------- | --------------------------- | ------------------ |
| Token address                                     | user / discovery            | required           |
| Pool address (Uniswap V3 vs USDC or WETH)         | discovery or explorer       | required           |
| Deployer address                                  | explorer (contract creator) | check is `unknown` |
| Pool creation time (unix s)                       | explorer (pool creation tx) | check is `unknown` |
| Top holders (`[{address, balance}]`, token units) | explorer holders tab        | check is `unknown` |

## Checks

| Check                | How                                                               | Levels (defaults in `DEFAULT_RUG_THRESHOLDS`)                                                  |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Contract             | `eth_getCode`                                                     | fail when there is no code at the address                                                      |
| Exit liquidity       | USDC or WETH held by the pool, in USD (WETH at Chainlink ETH/USD) | fail below $2,500, warn below $25,000 (same floors as Traivo's token check)                    |
| Pool age             | now − creation time                                               | warn under 24h                                                                                 |
| Holder concentration | top 10 share, excluding pool and burn addresses                   | warn ≥ 30%, fail ≥ 50%                                                                         |
| Deployer holdings    | deployer balance / supply                                         | warn ≥ 5%, fail ≥ 20%                                                                          |
| Ownership            | `owner()`                                                         | pass if zero/dead address; warn if active or no `owner()`                                      |
| Upgradeable code     | EIP-1967 implementation slot                                      | warn if set                                                                                    |
| Admin functions      | selector scan of bytecode                                         | mint with live owner → fail; blacklist, pause/trading switch, tax setter, limit setters → warn |

Exit liquidity counts only the USDC/WETH side on purpose: a pool full of the token and empty of USDC/WETH looks deep
but cannot absorb a sell. The age, holder and deployer thresholds are starting points chosen for this repo, not
fitted to outcomes. Always state which thresholds you used. The verdict is `fail` if any check fails, otherwise
`warn` if anything warns **or is unknown**, otherwise `pass`. Unknown is never safe.

## Script

```bash
pnpm tsx skills/rug-guard-review/scripts/facts.ts --token 0x… --pool 0x… [--deployer 0x…] [--pool-created-at 1790000000] [--holders holders.json]
```

Returns `verdict`, `checks[]` (`id`, `label`, `detail`, `level`), the `facts`, and `raw` (supply, pool share of
supply, quote reserve, ETH price, block). Pure logic: `rugReview()`, `rugVerdict()`, `top10Share()`,
`scanSelectors()` in `scripts/review.ts`.

## Output

Lead with the verdict and the single biggest risk. List fails, then warns, then unknowns ("not checked: holders").
Close with the exit liquidity number and the block. Never say a token is safe; say which risks were not found.
Before any trade, `pre-trade-check` still applies: on Ethereum, gas makes small speculative buys expensive.

## Failure modes

- The selector scan is a heuristic: renamed functions, proxies and role-based permissions can hide powers. Read the
  verified source on Etherscan before calling the contract clean.
- "Renounced" `owner()` does not rule out other admin roles (`AccessControl`, custom modifiers).
- Exit liquidity is the pool balance, not what a sell of your size gets: use `pre-trade-check` impact at the real size.
- Liquidity can be pulled at any time. A pass now says nothing about the next block.
- Only the pool you pass is read. Tokens often have several pools (V2, V3, V4); a deep pool elsewhere is not counted.
