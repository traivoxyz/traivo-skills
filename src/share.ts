/**
 * Listed share reference prices for tokenized stocks. Source: Yahoo Finance chart metadata (keyless). The price is
 * delayed during US market hours and is the last regular-session close outside them; there is no on-chain feed.
 */

export type ShareRef = { ticker: string; price: number; /** unix seconds of that price */ time: number };

export const SHARE_REF_SOURCE = "Yahoo Finance chart (delayed during market hours, last close outside them)";

// A plain identifying user agent: full desktop-browser strings were answered with 429 in testing.
const UA = "Mozilla/5.0 (compatible; traivo-skills)";

type Chart = { chart?: { result?: { meta?: { regularMarketPrice?: number; regularMarketTime?: number } }[] | null } };

/** Pull `{ price, time }` out of a Yahoo chart payload. Null when either is missing or not positive. */
export function parseShareChart(ticker: string, json: unknown): ShareRef | null {
  const meta = (json as Chart)?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const time = meta?.regularMarketTime;
  if (typeof price !== "number" || !(price > 0) || typeof time !== "number" || !(time > 0)) return null;
  return { ticker, price, time };
}

/** The endpoint rate-limits intermittently, so each host is tried once in turn. */
export const SHARE_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] as const;

/** Fetch one listed share's last price. Never throws: a failed fetch is a missing reference (null). */
export async function fetchShareRef(ticker: string, fetchFn: typeof fetch = fetch): Promise<ShareRef | null> {
  for (const host of SHARE_HOSTS) {
    try {
      const r = await fetchFn(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) continue;
      const ref = parseShareChart(ticker, await r.json());
      if (ref) return ref;
    } catch {
      /* try the next host */
    }
  }
  return null;
}

/**
 * Fetch several tickers one after another (parallel bursts get rate-limited); missing ones are absent from the map.
 */
export async function fetchShareRefs(
  tickers: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, ShareRef>> {
  const out = new Map<string, ShareRef>();
  for (const t of new Set(tickers)) {
    const r = await fetchShareRef(t, fetchFn);
    if (r) out.set(r.ticker, r);
  }
  return out;
}
