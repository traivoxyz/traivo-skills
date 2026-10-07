---
name: tokenized-stock-vs-share
description: Compare a tokenized stock on Ethereum (an Ondo Global Markets token such as NVDAon, traded on Uniswap V3 against USDC) with the listed share's last price, and explain the premium or discount with the right caveats (the token tracks but is not the share, the reference is delayed or the last close, thin pools, wide spreads, weekends). Use when the user asks about a tokenized stock's price, whether it is cheap or expensive vs the stock, why it differs from the share price, or before trading one.
---

# Tokenized stock vs share

An Ondo tokenized stock tracks the share; it is not the share. Its on-chain price is whatever the Uniswap pool pays,
and that pool trades whenever Ethereum does, while the share only trades in US market hours. A premium means little
until you know how fresh the share price is and how deep the pool is.

## What is measured

- **bid**: USDC received for selling 1 token. **ask**: price paid when buying with 1,000 USDC. **mid** = (bid + ask) / 2.
- **spread** = (ask − bid) / mid. **premium** = mid / reference − 1 (in bps; negative = discount).
- **exit liquidity**: the USDC the token's pool holds, which is what a seller can actually get out.
- **reference**: the listed share's last price from Yahoo Finance (`src/share.ts`). Delayed by up to about 15
  minutes during market hours and the last regular-session close outside them. There is no on-chain price feed for
  these tokens.
- **session** (New York time): `regular` Mon–Fri 09:30–16:00; `extended` Mon–Fri 04:00–09:30 and 16:00–20:00;
  `overnight` weeknights 20:00–04:00; `weekend` Fri 20:00 → Mon 04:00.

## Reading it

| Situation                                  | What to say                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Regular hours, reference ≤ 30 min old      | Compared with a delayed quote: small gaps can be the delay, not mispricing.                    |
| Outside regular hours                      | Compared with the last close. The share may be moving in extended trading that you cannot see. |
| Weekend                                    | The share is not trading: a premium is the pool pricing Monday's open, not an arbitrage.       |
| Regular hours, reference older than 30 min | The reference is not updating: treat it as unreliable.                                         |
| No reference (SPCX, or the fetch failed)   | No listed share to compare with: the pool is the only price.                                   |
| Exit liquidity under $25,000               | Thin pool: the mid moves with small trades; quote the actual size with `pre-trade-check`.      |
| Wide spread                                | The mid itself is uncertain; quote the side the trader would actually take.                    |

Bands match the pre-trade check: |premium| < 1% pass, < 3% warn, otherwise fail. A pass is downgraded to warn when
the reference is the last close or stale, or when the pool is thin. Exchange holidays are not modelled.

## Caveats to state every time it matters

- The token tracks the share but is not the share: holding it is not holding the stock, and its price can diverge.
- The reference is delayed or the last close, never a live share price.
- Pools are thin compared with the stock: a premium on 1 token says little about a $50,000 order.

## Script

```bash
pnpm tsx skills/tokenized-stock-vs-share/scripts/board.ts [--symbols NVDA,TSLA]
```

Per token: `bid`, `ask`, `mid`, `spreadBps`, `pool`, `exitUsd`, `reference`, `referenceAge` (s), `premiumBps` and an
`assessment` (`level` + `caveats[]`), plus `block`, `session`, `referenceSource` and `note`. Pure math in
`scripts/premium.ts` (`midPrice`, `spreadBps`, `premiumBps`, `usSession`, `referenceStatus`, `assessPremium`).

## Output

Lead with the number and its meaning in one sentence (example shape: "The NVDA token is 0.4% above the share's last
close; the market is closed, so this is the pool pricing the next open, not a mispricing."). Then bid/ask/mid, exit
liquidity, reference + age, block. Never call a premium an arbitrage unless the trader can actually reach the other side.

## Failure modes

- Share price fetch fails (rate limits, network): report "no reference", never reuse a number from memory.
- Quote fails: the pool cannot fill 1 token or $1,000; say so and stop.
- A token's fee tier in `src/chain.ts` may change; if a quote reverts, re-check the pool on-chain before retrying.
