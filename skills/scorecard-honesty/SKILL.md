---
name: scorecard-honesty
description: Log every trade call so it can be graded later from public data, and grade calls exactly the way Traivo's public scorecard does (target first = win, stop first = loss, open past the 7-day horizon = sign of return). Use whenever a trade is suggested or prepared, when reporting a hit rate or track record, or when the user asks how good past calls were. Misses are counted; nothing is deleted or re-graded after the fact.
---

# Scorecard honesty

A call that is not logged before the outcome is known cannot be graded. A hit rate that drops misses is not a hit rate.

## Logging a call

Log at the moment the call is made, before any outcome:

| Field                | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `symbol`, `side`     | what and which way (`buy` = long, `sell` = short / exit)                                              |
| `entry`              | the live on-chain mid at logging time, from a named `priceSource`                                     |
| `block`, `createdAt` | block number and unix time the entry was read at                                                      |
| `stop`, `target`     | fixed now from % distances; never moved afterwards                                                    |
| `horizonS`           | default 7 days                                                                                        |
| `reference`          | optional outside price at logging time (listed share for tokenized stocks, Chainlink ETH/USD for ETH) |

Every prepared trade must carry a stop and a take-profit. If the user gave none, propose them and say so. Mention
once that the call is logged and graded.

## Grading

On each price sample, in time order (rule order matters):

1. Target reached (buy: price ≥ target; sell: price ≤ target) → **win**, reason `tp`.
2. Else stop reached → **loss**, reason `sl`.
3. Else past `createdAt + horizonS` → closed at that price: **win** if the return is > 0, otherwise **loss**
   (a flat return counts as a loss), reason `expiry`.
4. Else still open.

Return = price / entry − 1 for a buy, 1 − price / entry for a sell. Returns ignore fees, slippage and gas: on
Ethereum, gas alone can turn a small "win" into a loss for the trader, so say so when reporting small positions.
Prices are samples (about once a minute in Traivo's grader), so a wick between samples can be missed: say so when
reporting results.

## Scripts

```bash
pnpm tsx skills/scorecard-honesty/scripts/log-call.ts log --symbol NVDA --side buy --stop-pct 3 --tp-pct 6
pnpm tsx skills/scorecard-honesty/scripts/log-call.ts grade --call call.json [--price 123.45]
```

`log` reads the current Ethereum block and the Uniswap V3 on-chain mid vs USDC (tokenized stocks and ETH) and prints the record; it writes nothing, so store it
yourself in an append-only log. Pure logic in `scripts/call.ts`: `makeCall()`, `callProblems()`, `gradeAt()`,
`gradePath()`, `summarize()`.

## Reporting a track record

- Count every resolved call: wins, losses, open. Give the win rate only with the count ("7 of 12 resolved").
- Never quote a win rate, return or streak that is not computed from the log. Link the public scorecard instead of
  restating its numbers from memory.
- Open calls are not wins. Expired calls count.

## Failure modes

- Missing block, time, stop or target: the call cannot be graded; `callProblems()` lists what is missing. Fix before logging.
- Editing stop/target after logging, or deleting losers: never. Log a new call instead.
- A price source the verifier cannot re-read (a screenshot, a private API) makes the call unverifiable.
