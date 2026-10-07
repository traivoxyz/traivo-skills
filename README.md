# traivo-skills

Agent skills for careful, read-only trading work on **Ethereum mainnet** (chain id 1): Uniswap V3 swaps against
USDC, tokenized stocks (Ondo Global Markets tokens) vs the listed share, and Ethereum gas. Each skill is a folder with
a `SKILL.md` (when to use it, inputs, steps, output shape, failure modes) and optional TypeScript helpers that read
the chain through a public RPC. They are the playbooks Traivo AI follows, published so any skills-capable agent can use
them and anyone can inspect how the copilot reasons.

**Advisory and read-only.** Nothing in this repo signs or sends a transaction, and no wallet
client is ever created. The trader signs every trade from their own wallet.

## Skills

| Skill                                                                  | Use it when                                                                                                                                         | Helper scripts                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [`pre-trade-check`](skills/pre-trade-check/SKILL.md)                   | A swap is about to be suggested or signed: impact, price vs reference, exit liquidity, slippage, MEV, balance, gas and gas vs size → pass/warn/fail | `check-trade.ts` (live), `checks.ts` (rules) |
| [`position-sizing`](skills/position-sizing/SKILL.md)                   | A size is proposed: size from max loss and stop with round-trip gas counted, full plan with target and R multiple                                   | `size.ts`                                    |
| [`tokenized-stock-vs-share`](skills/tokenized-stock-vs-share/SKILL.md) | A tokenized stock's price is discussed: on-chain mid vs the listed share, premium, delayed/last-close and thin-pool caveats                         | `board.ts` (live), `premium.ts`              |
| [`rug-guard-review`](skills/rug-guard-review/SKILL.md)                 | An unreviewed token is considered: code, exit liquidity, pool age, holders, deployer, owner, proxy, admin functions                                 | `facts.ts` (live), `review.ts`               |
| [`scorecard-honesty`](skills/scorecard-honesty/SKILL.md)               | A call is made or a track record is reported: log it gradeably, grade it like the public scorecard                                                  | `log-call.ts` (live), `call.ts`              |
| [`explain-this-move`](skills/explain-this-move/SKILL.md)               | "Why did it move?": pool flows, large wallets, reference, news, sourced claims, explicit unknowns                                                   | `flows.ts` (live), `answer.ts`               |

## Quick start

```bash
pnpm install
pnpm tsx skills/position-sizing/scripts/size.ts --entry 100 --stop-pct 3 --tp-pct 6 --max-loss 50
pnpm tsx skills/pre-trade-check/scripts/check-trade.ts --symbol NVDA --side buy --amount 2000
pnpm tsx skills/tokenized-stock-vs-share/scripts/board.ts --symbols NVDA,TSLA
pnpm example        # a minimal agent loop that loads a skill on demand (offline, scripted)
```

Every script prints JSON to stdout. After `pnpm build` the same scripts run as `node dist/skills/<skill>/<script>.js`.
The RPC defaults to `https://ethereum-rpc.publicnode.com`; override with `--rpc <url>` or `TRAIVO_RPC_URL`.
Listed share prices for tokenized stocks come from Yahoo Finance's public chart endpoint (no key).

### Using the skills in an agent

- **Agents with native skill support**: point them at (or copy) the `skills/` folder. Each `SKILL.md` starts with
  `name` + `description` frontmatter, which is what the agent reads to decide when to load the skill.
- **Any other agent**: see [`examples/agent-loop.ts`](examples/agent-loop.ts). It puts only the skill index in the
  system prompt, loads a `SKILL.md` when the model asks for it, and exposes an allow-list of read-only helpers. It
  runs offline with a scripted model, or against your own endpoint via `AGENT_BASE_URL` / `AGENT_MODEL` /
  `AGENT_API_KEY`.

## Library API

`import { … } from "@traivo/skills"` (ESM). Pure functions need no network.

| Export                                                                                                                   | What                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `loadSkills(dir)`, `parseSkillFile()`, `validateMeta()`, `skillIndex()`, `rankSkills()`                                  | Skill loading, frontmatter validation, index for a system prompt, naive keyword ranking |
| `preTradeCheck.preTradeChecks()`, `preTradeCheck.verdict()`, `preTradeCheck.THRESHOLDS`                                  | Pre-trade rules                                                                         |
| `checkTrade(client, …)`                                                                                                  | Live quote + reference + exit liquidity + gas + wallet → checks                         |
| `positionSizing.sizePosition()`, `.levelsFromPct()`, `.rMultiple()`, `.buildPlan()`                                      | Sizing math with gas                                                                    |
| `swapGasEth()`, `swapGasUsd()`, `gasSharePct()`, `readGasGwei()`                                                         | Ethereum gas budget (250k gas × gwei × 1.3)                                             |
| `tokenizedStockVsShare.premiumBps()`, `.usSession()`, `.referenceStatus()`, `.assessPremium()`                           | Premium and reference caveats                                                           |
| `stockBoard(client, symbols?)`, `fetchShareRef()`, `parseShareChart()`                                                   | Live tokenized stock board, listed share prices                                         |
| `rugGuard.rugReview()`, `.rugVerdict()`, `.top10Share()`, `.scanSelectors()`                                             | Rug checklist                                                                           |
| `readRugFacts(client, …)`                                                                                                | Live token + pool facts                                                                 |
| `scorecard.makeCall()`, `.callProblems()`, `.gradeAt()`, `.gradePath()`, `.summarize()`                                  | Call logging and grading                                                                |
| `explainMove.composeExplanation()`, `.explainProblems()`, `summarizeSwaps()`, `blocksForHours()`, `poolFlows(client, …)` | Answer shape and pool flows                                                             |
| `quoteTrade()`, `twoSidedCalls()`, `readFeed()`, `readEthUsd()`, `readExitLiquidity()`, `readClient()`, `pathFor()`      | Read-only chain helpers                                                                 |
| `STOCK_TOKENS`, `USDC`, `WETH`, `UNISWAP_V3`, `MULTICALL3`, `CHAINLINK_ETH_USD`, `ETHEREUM`                              | Constants                                                                               |

## How Traivo uses it

The thresholds, formulas and grading rules here are the ones the Traivo app applies: the pre-trade checks and sizing
panel on the trade screen (including the Ethereum gas rows), the tokenized stock board against the listed share, and
the public scorecard grader. Traivo AI
follows the same answer rules (lead with the answer, cite the numbers, say what is missing, never promise returns).
Track record: see the live public scorecard at <https://dapp.traivo.xyz/scorecard>, misses included. This repo makes
no performance claims of its own.

## Limitations

- **Read-only**: no orders, signing, session keys or transaction building.
- **Tokenized stocks**: Ondo token addresses and V3 fee tiers are a snapshot in `src/chain.ts`. They track the share
  but are not the share. The listed share price is delayed during market hours and the last close outside them;
  exchange holidays are not modelled.
- **Gas**: a fixed 250k-gas budget per swap with a 1.3× buffer, read once per check. Real swaps can use less or more,
  and gas moves between blocks.
- **Logs**: public RPCs (the default included) serve `eth_getLogs` for the last few thousand blocks only, so
  `flows.ts` needs an archive-capable RPC (`--rpc`) for windows longer than about half a day.
- **Rug review**: the bytecode selector scan is a heuristic, not an audit; pool age, holders and deployer must be
  supplied from an explorer. Thresholds for those are starting points, not fitted to outcomes.
- **Grading** samples prices; a wick between samples can be missed. Returns ignore fees and slippage.
- Not financial advice.

## Development

```bash
pnpm lint        # prettier --check
pnpm typecheck   # tsc --noEmit
pnpm test        # unit tests + SKILL.md frontmatter validation (network tests skipped)
pnpm test:network  # live read-only checks against Ethereum mainnet
pnpm build       # tsup → dist/
```

Adding a skill: create `skills/<name>/SKILL.md` with `name` (equal to the folder) and a `description` of at most
1,024 characters saying when to use it; put helpers in `skills/<name>/scripts/` with unit tests in `tests/`.

## Links

Traivo $TRVO — The AI trading copilot for Ethereum Chain: it reads your wallet, watches the market, and prepares every trade for you to approve.

- Telegram: https://t.me/traivo
- X: https://x.com/traivoxyz
- Website: https://traivo.xyz
- Docs: https://docs.traivo.xyz
- App: https://dapp.traivo.xyz
- GitHub: https://github.com/traivoxyz

## License

MIT © Traivo
