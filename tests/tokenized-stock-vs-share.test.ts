import { describe, expect, it } from "vitest";
import {
  DELAYED_MAX_S,
  LAST_CLOSE_MAX_S,
  THIN_POOL_USD,
  assessPremium,
  midPrice,
  premiumBps,
  referenceStatus,
  spreadBps,
  usSession,
} from "../skills/tokenized-stock-vs-share/scripts/premium.js";
import { fetchShareRef, fetchShareRefs, parseShareChart } from "../src/share.js";

describe("premium math", () => {
  it("mid, spread, premium", () => {
    expect(midPrice(99, 101)).toBe(100);
    expect(midPrice(null, 101)).toBe(101);
    expect(midPrice(99, null)).toBe(99);
    expect(midPrice(null, null)).toBeNull();
    expect(spreadBps(99, 101)).toBeCloseTo(200, 8);
    expect(spreadBps(null, 101)).toBeNull();
    expect(premiumBps(100.5, 100)).toBeCloseTo(50, 8);
    expect(premiumBps(100, null)).toBeNull();
  });
});

describe("usSession (New York time, DST aware)", () => {
  it.each([
    ["2026-10-07T07:59:00Z", "overnight"], // Wed 03:59 EDT
    ["2026-10-07T08:00:00Z", "extended"], // Wed 04:00 EDT
    ["2026-10-07T13:29:00Z", "extended"], // Wed 09:29 EDT
    ["2026-10-07T13:30:00Z", "regular"], // Wed 09:30 EDT
    ["2026-10-07T19:59:00Z", "regular"], // Wed 15:59 EDT
    ["2026-10-07T20:00:00Z", "extended"], // Wed 16:00 EDT
    ["2026-10-08T00:00:00Z", "overnight"], // Wed 20:00 EDT
    ["2026-10-09T23:59:00Z", "extended"], // Fri 19:59 EDT
    ["2026-10-10T00:00:00Z", "weekend"], // Fri 20:00 EDT
    ["2026-10-10T15:00:00Z", "weekend"], // Sat
    ["2026-10-12T00:00:00Z", "weekend"], // Sun 20:00 EDT
    ["2026-10-12T07:59:00Z", "weekend"], // Mon 03:59 EDT
    ["2026-10-12T08:00:00Z", "extended"], // Mon 04:00 EDT
    ["2026-12-07T14:29:00Z", "extended"], // Mon 09:29 EST
    ["2026-12-07T14:30:00Z", "regular"], // Mon 09:30 EST
  ])("%s → %s", (iso, session) => {
    expect(usSession(new Date(iso))).toBe(session);
  });
});

describe("referenceStatus", () => {
  it("is a delayed quote in regular hours, the last close outside them", () => {
    expect(referenceStatus(null, "regular")).toBe("missing");
    expect(referenceStatus(DELAYED_MAX_S, "regular")).toBe("delayed");
    expect(referenceStatus(DELAYED_MAX_S + 1, "regular")).toBe("stale");
    expect(referenceStatus(3 * 3600, "extended")).toBe("last-close");
    expect(referenceStatus(LAST_CLOSE_MAX_S, "weekend")).toBe("last-close");
    expect(referenceStatus(LAST_CLOSE_MAX_S + 1, "overnight")).toBe("stale");
  });
});

describe("assessPremium", () => {
  it("passes a small premium vs a delayed quote in regular hours, and says it is delayed", () => {
    const a = assessPremium({ premiumBps: 20, referenceAge: 60, session: "regular", exitUsd: 500_000 });
    expect(a.level).toBe("pass");
    expect(a.caveats).toHaveLength(1);
    expect(a.caveats[0]).toMatch(/delayed/);
  });
  it("downgrades a pass to warn against the last close", () => {
    const a = assessPremium({ premiumBps: 20, referenceAge: 6 * 3600, session: "extended" });
    expect(a.level).toBe("warn");
    expect(a.caveats.join(" ")).toMatch(/last close/);
    expect(a.caveats.join(" ")).toMatch(/extended trading/);
  });
  it("explains a weekend premium", () => {
    const a = assessPremium({ premiumBps: 150, referenceAge: 2 * 86_400, session: "weekend" });
    expect(a.level).toBe("warn");
    expect(a.caveats.join(" ")).toMatch(/Monday's open/);
  });
  it("calls a reference that stopped updating in market hours unreliable", () => {
    const a = assessPremium({ premiumBps: 0, referenceAge: DELAYED_MAX_S + 10, session: "regular" });
    expect(a.level).toBe("warn");
    expect(a.caveats[0]).toMatch(/unreliable/);
  });
  it("fails a large premium, warns with no reference", () => {
    expect(assessPremium({ premiumBps: -350, referenceAge: 10, session: "regular" }).level).toBe("fail");
    const none = assessPremium({ premiumBps: null, referenceAge: null, session: "regular" });
    expect(none.level).toBe("warn");
    expect(none.caveats).toEqual(["No listed share price to compare against: the on-chain pool is the only price."]);
  });
  it("mentions a wide spread and a thin pool", () => {
    const a = assessPremium({
      premiumBps: 0,
      referenceAge: 0,
      session: "regular",
      spreadBps: 150,
      exitUsd: THIN_POOL_USD - 1,
    });
    expect(a.level).toBe("warn");
    expect(a.caveats.join(" ")).toMatch(/spread/);
    expect(a.caveats.join(" ")).toMatch(/Thin pool: about \$24,999 of USDC/);
  });
});

/** Minimal stand-in for a fetch result: only `ok`, `status` and `json()` are read. */
const reply = (status: number, body: unknown = null) => ({ ok: status < 400, status, json: async () => body });

describe("share reference", () => {
  const chart = (price?: number, time?: number) => ({
    chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: time } }] },
  });
  it("parses the chart payload", () => {
    expect(parseShareChart("NVDA", chart(180.5, 1_790_000_000))).toEqual({
      ticker: "NVDA",
      price: 180.5,
      time: 1_790_000_000,
    });
    expect(parseShareChart("NVDA", chart(undefined, 1))).toBeNull();
    expect(parseShareChart("NVDA", chart(0, 1))).toBeNull();
    expect(parseShareChart("NVDA", { chart: { result: null } })).toBeNull();
    expect(parseShareChart("NVDA", null)).toBeNull();
  });
  it("fetches through an injectable fetch and never throws", async () => {
    const seen: string[] = [];
    const ok = (async (url: string) => {
      seen.push(url);
      return reply(200, chart(100, 1_790_000_000));
    }) as unknown as typeof fetch;
    expect(await fetchShareRef("SPY", ok)).toMatchObject({ ticker: "SPY", price: 100 });
    expect(seen[0]).toMatch(/\/v8\/finance\/chart\/SPY\?/);
    const down = (async () => reply(429)) as unknown as typeof fetch;
    expect(await fetchShareRef("SPY", down)).toBeNull();
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchShareRef("SPY", boom)).toBeNull();
  });
  it("falls back to the second host when the first is rate limited", async () => {
    const hosts: string[] = [];
    const f = (async (url: string) => {
      hosts.push(new URL(url).host);
      return hosts.length === 1 ? reply(429) : reply(200, chart(50, 1_790_000_000));
    }) as unknown as typeof fetch;
    expect(await fetchShareRef("TSLA", f)).toMatchObject({ price: 50 });
    expect(hosts).toEqual(["query1.finance.yahoo.com", "query2.finance.yahoo.com"]);
  });
  it("fetchShareRefs dedupes tickers and drops misses", async () => {
    let calls = 0;
    const f = (async (url: string) => {
      calls++;
      return url.includes("AAPL") ? reply(200, chart(200, 1)) : reply(404);
    }) as unknown as typeof fetch;
    const refs = await fetchShareRefs(["AAPL", "AAPL", "TSLA"], f);
    expect(calls).toBe(3); // AAPL once; TSLA on both hosts
    expect([...refs.keys()]).toEqual(["AAPL"]);
  });
});
