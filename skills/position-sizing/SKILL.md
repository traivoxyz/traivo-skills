---
name: position-sizing
description: Size a position from the most the trader is willing to lose and where the stop is, and build a complete trade plan (entry, stop, take-profit, R multiple), with Ethereum gas counted against the max loss and checked against the position size. Use whenever a trade size is proposed or questioned, when the user gives a max loss or risk per trade, or when a trade is prepared without a stop or target. Pure math; it reads the chain only for live gas when asked.
---

# Position sizing

No position should be suggested without an exit on both sides. Size comes from risk, not from conviction.
On Ethereum, gas is a fixed cost per swap: it is part of the loss, and it makes small positions expensive.

## Formula

```
risk per unit   = |entry − stop|  (+ entry × costBps / 10,000 if a cost buffer is used)
gas (round trip) = 2 × 250,000 gas × gas price × 1.3   (entry swap + exit swap, valued at the ETH price)
size (units)    = (max loss − round-trip gas) / risk per unit
size (USD)      = size × entry
loss at stop    = size × risk per unit + round-trip gas   (= max loss)
R multiple      = reward / risk = (target − entry) / (entry − stop) for a buy, mirrored for a sell
gas vs size     = one swap's gas / size (USD): warn above 1%, fail above 5% (same bands as pre-trade-check)
```

From % distances (as the Traivo trade screen does): buy stop = entry × (1 − stop%), buy target = entry × (1 + tp%);
a sell mirrors both.

## Inputs

- `entry`: the live quoted price (from `pre-trade-check`), not a remembered one.
- `stop` (price) or `stop-pct`; `target` (price) or `tp-pct`.
- `max-loss` in USD. If the user has not given one, ask. Do not pick one for them silently; if you propose one, say so.
- Gas: `gas-usd` (round trip, USD), or `gwei` + `eth-usd`, or `live-gas` (reads the gas price and Chainlink ETH/USD).
  Default 0, which matches the sizing panel; leaving it out overstates the size slightly, so say when you did.
- Optional `cost-bps`: round-trip fees + expected slippage. Default 0 (matches the trade screen). It only shrinks size.

## Steps

1. Get the entry from a live quote.
2. Validate: a buy stop must be below entry and target above; a sell is the mirror. Report every problem.
3. Compute size and R with gas included. If R < 1, say plainly that the trade risks more than it targets.
4. If gas uses up the max loss, there is no size: say the trade is too small for Ethereum. If gas is more than 1%
   of the position per swap, show that number; above 5% the plan is not worth presenting.
5. Compare the size with the wallet: if the size needs more than the wallet holds, the plan is capped by the wallet
   and the real max loss is smaller; say both numbers.
6. Re-run `pre-trade-check` at the computed size: impact and exit liquidity depend on size.

## Script

```bash
pnpm tsx skills/position-sizing/scripts/size.ts --entry 100 --stop-pct 3 --tp-pct 6 --max-loss 50 [--side buy] [--cost-bps 30]
pnpm tsx skills/position-sizing/scripts/size.ts --entry 180 --stop-pct 4 --tp-pct 8 --max-loss 100 --live-gas
pnpm tsx skills/position-sizing/scripts/size.ts --entry 180 --stop-pct 4 --tp-pct 8 --max-loss 100 --gwei 2 --eth-usd 4000
```

Returns `{ entry, stop, target, r, size: { sizeTokens, sizeUsd, riskPerToken, lossAtStop, gasUsd }, gasPct,
problems[], notes[], gas }`. Functions: `sizePosition()`, `levelsFromPct()`, `rMultiple()`, `buildPlan()` in
`scripts/size.ts`; gas math in `src/gas.ts`.

## Output

"Buy 16.67 units at $100 (≈ $1,667) with a stop at $97 and a target at $106: hitting the stop loses $50, the target makes 2R." (Illustrative numbers.)
Then the inputs used, including the gas price and its USD cost. Always show the stop and target together with the size.

## Failure modes

- Stop equal to entry, or on the wrong side: no defined risk, no size. Ask for a valid stop.
- Gas at or above the max loss: no size. Suggest a larger max loss with a wider stop, or not trading on Ethereum.
- Gas moves: the gas price can double within minutes; a size computed with old gas is too large. Re-read it.
- Gaps and slippage: a stop is a trigger, not a guaranteed fill. Thin pools and gaps on tokenized stocks while the
  share is closed can fill worse than the stop, so the real loss can exceed `max-loss`. Say this when the pool is thin.
- Stops are not automatic on-chain unless an order is set up; until then the trader must act on them.
