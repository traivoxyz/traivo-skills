---
name: pre-trade-check
description: Screen a proposed swap on Ethereum mainnet (tokenized stock, ETH or another token against USDC on Uniswap V3) before the trader is shown anything to sign. Use whenever a trade is about to be suggested, prepared or reviewed, or when the user asks "is this trade safe / ok to send". Returns a pass/warn/fail list for liquidity depth and price impact, price vs reference (listed share for tokenized stocks, Chainlink ETH/USD for ETH), exit liquidity, slippage limit, MEV exposure, wallet balance, Ethereum gas and gas relative to trade size, and contract type. Read-only; never signs or sends.
---

# Pre-trade check

Run this before any trade is presented. It reproduces the checks Traivo's trade screen runs before it shows a
sign button. A single `fail` means the trade must not be presented as ready to sign.

## Inputs

| Input             | Required | Notes                                                                                                          |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| Asset             | yes      | Tokenized stock by share ticker (`NVDA`), `ETH`, or a token address + pool fee tier + route (`USDC` or `WETH`) |
| Side              | yes      | `buy` (spend USDC) or `sell` (sell the asset for USDC)                                                         |
| Amount            | yes      | USDC for a buy, asset units for a sell                                                                         |
| Slippage limit    | no       | bps, default 50 (0.50%)                                                                                        |
| Wallet address    | no       | Enables the balance and gas-balance checks. Without it those checks are skipped: say so                        |
| Outside reference | no       | For other tokens only: a price from another market, and its name                                               |

## Steps

1. Get a live quote (`scripts/check-trade.ts` does this with QuoterV2 `eth_call`, plus a $10 probe to measure impact).
2. Read the reference: the listed share's last price for tokenized stocks (Yahoo Finance; delayed during market
   hours, the last close outside them), Chainlink ETH/USD for ETH. A share price older than 6 hours is the last close.
3. Read the routed pool's exit liquidity (its USDC or WETH balance) and the current gas price.
4. Apply the rules below. Do not soften a level; report it as computed.
5. Present the list, then the verdict. If there is any `warn`, the trader must see it before signing.
6. For tokens other than tokenized stocks and ETH, also run `rug-guard-review` before suggesting any size.

## Rules (same thresholds as the Traivo trade screen)

| Check                                 | pass                                   | warn                                                 | fail                                   |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| Liquidity depth (impact vs $10 probe) | < 0.50%                                | < 2.00%                                              | ≥ 2.00%                                |
| Price vs reference (abs premium)      | < 1%                                   | < 3%, or no reference at all                         | ≥ 3%                                   |
| Exit liquidity (USDC/WETH in pool)    | ≥ $25,000 and trade ≤ 5% of it         | < $25,000, or trade > 5% of it                       | < $2,500, or trade > 20% of it         |
| Slippage limit                        | ≤ 1.00%                                | > 1.00%                                              | —                                      |
| MEV exposure                          | —                                      | impact > 0.50%: suggest splitting into smaller fills | —                                      |
| Balance                               | wallet ≥ amount                        | —                                                    | wallet < amount                        |
| Gas                                   | ETH left after the trade > swap gas    | gas price unknown                                    | not enough ETH left for the swap's gas |
| Gas vs size                           | gas ≤ 1% of trade size (row not shown) | gas > 1% of trade size                               | gas > 5% of trade size                 |
| Contract                              | tokenized stock (Ondo) or native ETH   | any other token (unreviewed)                         | —                                      |
| Quote                                 | —                                      | —                                                    | no quote: the pool cannot fill it      |

**Ethereum gas.** Swap gas = 250,000 gas × current gas price × 1.3 buffer (the buffer also covers a first-time
approval most of the time). Trade size in USD is the USDC in for a buy and the USDC out for a sell. On Ethereum a
$50 trade can easily pay several percent in gas: say so, and suggest a bigger, less frequent trade or skipping it.

Constants live in `scripts/checks.ts` (`THRESHOLDS`) and `src/gas.ts`. Change them only in code, never ad hoc in
an answer.

## Script

```bash
pnpm tsx skills/pre-trade-check/scripts/check-trade.ts --symbol NVDA --side buy --amount 2000 [--wallet 0x…] [--slippage-bps 50]
pnpm tsx skills/pre-trade-check/scripts/check-trade.ts --symbol ETH --side sell --amount 0.5
pnpm tsx skills/pre-trade-check/scripts/check-trade.ts --token 0x… --fee 3000 --via WETH --side buy --amount 1000
```

Prints JSON: `verdict`, `checks[]` (`label`, `detail`, `level`), the `quote` (price, impact, depth ladder, block),
the `reference` with its age and source, the routed `pool` and its `exitUsd`, and `gas` (gwei, ETH price).
Pure rules: `preTradeChecks()` and `verdict()` in `scripts/checks.ts`.

## Output

Lead with the verdict in one sentence ("Two warnings, nothing blocking: …"). Then the checks as a short list, worst
first, each with its number. Name the block the quote was read at and the gas price used. Never add a sign button
or a transaction.

## Failure modes

- **No quote**: the pool cannot fill the size, or the RPC failed. Say which; never fall back to a guessed price.
- **Reference missing**: the share price fetch can fail (rate limits) and SPCX has no listed share. Report "no
  reference"; never reuse a remembered price.
- **Last close**: outside US market hours the share reference is the last close, so the premium is not vs a live
  price. During market hours it is delayed by up to about 15 minutes.
- **Gas moves**: gas is read once; it can double within minutes. The gas rows are valid for the block they were read at.
- **Impact is per size**: a pass at $2,000 says nothing about $200,000. Re-run at the real size.
- **Quotes move**: a check is valid for the block it was read at. Re-run if the trader waits.
