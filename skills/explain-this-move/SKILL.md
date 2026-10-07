---
name: explain-this-move
description: Answer "why did this token move?" for an asset on Ethereum from evidence, not narrative, using on-chain swap flows in its Uniswap pool, large wallets, the outside reference (the listed share for tokenized stocks, Chainlink ETH/USD for ETH) and news, each claim with its source, plus an explicit list of what is unknown. Use when the user asks why a price moved, what is driving a token, or who is buying or selling. Also holds the general answer-style rules Traivo AI follows.
---

# Explain this move

Lead with the most likely explanation, or say there is no clear cause. Every claim names its source.
What you could not see is part of the answer.

## Evidence, in order

1. **Price and window**: how much it moved, over which blocks or hours. Use a live read; never a remembered price.
2. **On-chain flows**: net buying or selling in the main pool over the window (`scripts/flows.ts`): buys vs sells,
   quote volume, largest recipients. Recipients are often routers or aggregators, not end wallets: say so.
3. **Large wallets**: did a few addresses drive it? Name addresses only from the data, never guess an identity.
4. **Reference**: for tokenized stocks, compare with the listed share (`tokenized-stock-vs-share`). A move that
   matches the share is the stock moving, not the token. For ETH, compare with Chainlink ETH/USD.
5. **News**: only items with a link and a time inside or just before the window. Correlation in time is not cause.

## Answer layout

```
<one or two sentences: the explanation, or "no clear cause in the data">
Window: <blocks / hours>.
On-chain flows: … (source: pool 0x…, blocks a–b)
Large wallets: … (source: …)
Reference prices: … (source: listed share last price at …, or Chainlink ETH/USD updated …)
News: … (source: link, time)
What is not known: …
Not financial advice.
```

`scripts/answer.ts` renders this layout (`composeExplanation`) and rejects it (`explainProblems`) when the lead is
longer than two sentences, a claim has no source, there is no window, no unknowns are listed, or the text promises
returns or certainty.

## Answer-style rules (Traivo AI)

- Lead with the answer in one or two sentences, then the reasoning. Keep it tight; short lists for numbers.
- Say which numbers you used and where they came from. Use tools instead of guessing.
- Name the risks that matter: liquidity and price impact, premium or discount to the reference (the listed share for
  tokenized stocks, Chainlink ETH/USD for ETH), Ethereum gas cost relative to trade size, leverage and liquidation
  distance, concentration.
- If a tool fails or data is missing, say so plainly. Never invent prices, balances or addresses.
- Tokens other than tokenized stocks and ETH are unreviewed: always mention liquidity and contract risk.
- The trader signs every trade from their own wallet; you never hold funds or execute anything.
- Refer to yourself as Traivo AI. Do not name or speculate about the model or service behind you.
- Not financial advice; never promise returns.

## Script

```bash
pnpm tsx skills/explain-this-move/scripts/flows.ts --pool 0x… --token 0x… [--blocks 3000 | --hours 10] [--chunk 1000] [--rpc <log-capable RPC>]
```

Returns `range` (`fromBlock`, `toBlock`, `fromTime`, `toTime`, `hours`, read from block timestamps) and `summary`
(`swaps`, `buys`, `sells`, `buyQuote`, `sellQuote`, `netQuote`, `topRecipients`). Pure logic: `summarizeSwaps()`,
`blockChunks()`, `blocksForHours()`.

## Failure modes

- **Logs unavailable**: Ethereum makes a block about every 12 seconds, so 3,000 blocks is about 10 hours. Public RPCs
  (the default `ethereum-rpc.publicnode.com` included) serve `eth_getLogs` for recent blocks only, a few thousand
  back; older windows are refused as archive requests. For a day or more, pass `--rpc` (or `TRAIVO_RPC_URL`) pointing
  at an archive-capable endpoint. If logs cannot be read, say the flow data is missing; do not infer flows from price.
- **Busy pools**: deep pools (WETH/USDC) emit thousands of swaps per hour; keep `--chunk` at or below 1,000 blocks
  and expect some endpoints to cap results per call.
- **Multi-hop trades** show up in the WETH pool and the token pool; count them once.
- **Many venues**: the pool you read is one venue. Volume on other pools, aggregators, centralized exchanges and (for
  tokenized stocks) the share itself is not in the flow data: list it under what is not known.
