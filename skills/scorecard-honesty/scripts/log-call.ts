import { readFileSync } from "node:fs";
import type { PublicClient } from "viem";
import { isMain, num, parseFlags, runCli, str } from "../../../src/cli.js";
import { readClient } from "../../../src/client.js";
import { readEthUsd } from "../../../src/feed.js";
import { decodeTwoSided, twoSidedCalls } from "../../../src/quote.js";
import { ETH_ROUTE } from "../../../src/routes.js";
import { stockBoard } from "../../tokenized-stock-vs-share/scripts/board.js";
import { midPrice } from "../../tokenized-stock-vs-share/scripts/premium.js";
import { gradeAt, makeCall, type Call } from "./call.js";

/**
 * Two read-only commands:
 *   log   --symbol NVDA --side buy --stop-pct 3 --tp-pct 6   → reads block + on-chain mid now, prints a call record
 *   grade --call call.json [--price 123.4]                  → grades the record at the given or current on-chain mid
 * Supported symbols: tokenized stocks with a Uniswap V3 USDC pool, and ETH.
 * Nothing is written anywhere: store the printed record yourself (append-only).
 */
export const PRICE_SOURCE = "Uniswap V3 on-chain mid vs USDC on Ethereum (bid: sell 1 unit, ask: buy with 1,000 USDC)";

export async function currentMid(client: PublicClient, symbol: string) {
  if (symbol.toUpperCase() === "ETH") {
    const [block, results, feed] = await Promise.all([
      client.getBlockNumber(),
      client.multicall({ contracts: twoSidedCalls(ETH_ROUTE) as any, allowFailure: true }),
      readEthUsd(client),
    ]);
    const { bid, ask } = decodeTwoSided(ETH_ROUTE, results[0], results[1]);
    const mid = midPrice(bid, ask);
    if (!mid) throw new Error("no on-chain mid for ETH");
    return { mid, reference: feed?.price ?? null, block: block.toString() };
  }
  const board = await stockBoard(client, [symbol]);
  const row = board.rows[0];
  if (!row?.mid)
    throw new Error(
      `no on-chain mid for ${symbol} (only tokenized stocks with a V3 USDC pool, and ETH, are supported)`,
    );
  return { mid: row.mid, reference: row.reference, block: board.block };
}

if (isMain(import.meta.url)) {
  void runCli(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const f = parseFlags(rest);
    if (cmd === "log") {
      const symbol = (str(f, "symbol") ?? "").toUpperCase();
      const side = str(f, "side") as "buy" | "sell";
      const now = await currentMid(readClient(str(f, "rpc")), symbol);
      return makeCall({
        symbol,
        side,
        entry: now.mid,
        block: now.block,
        createdAt: Math.floor(Date.now() / 1000),
        stopPct: num(f, "stop-pct") ?? NaN,
        takeProfitPct: num(f, "tp-pct") ?? NaN,
        horizonS: num(f, "horizon-s"),
        priceSource: PRICE_SOURCE,
        reference: now.reference,
      });
    }
    if (cmd === "grade") {
      const file = str(f, "call");
      if (!file) throw new Error("grade needs --call <file.json>");
      const call = JSON.parse(readFileSync(file, "utf8")) as Call;
      const given = num(f, "price");
      const price = given ?? (await currentMid(readClient(str(f, "rpc")), call.symbol)).mid;
      return { call, price, grade: gradeAt(call, price, Math.floor(Date.now() / 1000)) };
    }
    throw new Error(
      "usage: log-call.ts log --symbol <SYM> --side buy|sell --stop-pct <pct> --tp-pct <pct> | grade --call <file.json> [--price <p>]",
    );
  });
}
