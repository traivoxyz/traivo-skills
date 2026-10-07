/**
 * Tokenized stock vs the listed share: the on-chain DEX price next to the share's last price.
 * Pure functions; `board.ts` reads the chain and the share prices and feeds them.
 */

/** Same bands as the pre-trade check: |premium| below 1% pass, below 3% warn, otherwise fail. */
export const PREMIUM_BANDS = { passBps: 100, failBps: 300 } as const;
/** During the regular session the share price is a delayed quote; older than this it is not updating. */
export const DELAYED_MAX_S = 30 * 60;
/** Outside the regular session the reference is the last close; older than this (a long weekend + slack) it is stale. */
export const LAST_CLOSE_MAX_S = 4 * 86_400;
/** Exit liquidity (USDC in the pool) below this is a thin pool: the mid moves with small trades. */
export const THIN_POOL_USD = 25_000;

export const TOKEN_NOTE =
  "An Ondo tokenized stock tracks the share; it is not the share. Its price is whatever the on-chain pool pays.";

/** Mid of a two-sided on-chain market; falls back to whichever side exists. */
export function midPrice(bid: number | null, ask: number | null): number | null {
  if (bid && ask) return (bid + ask) / 2;
  return bid || ask || null;
}

export function spreadBps(bid: number | null, ask: number | null): number | null {
  if (!bid || !ask) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 10_000;
}

export function premiumBps(mid: number | null, reference: number | null): number | null {
  if (!mid || !reference || !(reference > 0)) return null;
  return (mid / reference - 1) * 10_000;
}

export type UsSession = "regular" | "extended" | "overnight" | "weekend";

function easternParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * US equity session in New York time.
 * - "regular": Mon–Fri 09:30–16:00 ET.
 * - "extended": Mon–Fri 04:00–09:30 and 16:00–20:00 ET (pre- and after-market).
 * - "overnight": weeknights 20:00–04:00 ET.
 * - "weekend": Fri 20:00 ET → Mon 04:00 ET.
 * Exchange holidays are NOT modelled: on a holiday this still says "regular".
 */
export function usSession(date: Date): UsSession {
  const { weekday, minutes } = easternParts(date);
  const four = 4 * 60;
  const eight = 20 * 60;
  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  if (weekday === "Fri" && minutes >= eight) return "weekend";
  if (weekday === "Mon" && minutes < four) return "weekend";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= four && minutes < eight) return "extended";
  return "overnight";
}

export type ReferenceStatus = "missing" | "delayed" | "last-close" | "stale";

/** How to read the share reference, given its age and the session. */
export function referenceStatus(ageSeconds: number | null, session: UsSession): ReferenceStatus {
  if (ageSeconds == null) return "missing";
  if (session === "regular") return ageSeconds <= DELAYED_MAX_S ? "delayed" : "stale";
  return ageSeconds <= LAST_CLOSE_MAX_S ? "last-close" : "stale";
}

export type Assessment = { level: "pass" | "warn" | "fail"; caveats: string[] };

/** How much to trust a premium reading, with every caveat spelled out. */
export function assessPremium(p: {
  premiumBps: number | null;
  referenceAge: number | null;
  session: UsSession;
  spreadBps?: number | null;
  /** USDC in the token's pool, in USD. */
  exitUsd?: number | null;
}): Assessment {
  const caveats: string[] = [];
  const status = referenceStatus(p.referenceAge, p.session);
  if (status === "missing")
    caveats.push("No listed share price to compare against: the on-chain pool is the only price.");
  if (status === "delayed")
    caveats.push("The share price is a delayed quote (up to about 15 minutes) during market hours.");
  if (status === "last-close")
    caveats.push("The share is outside its regular session: the reference is the last close, not a live price.");
  if (status === "stale")
    caveats.push(
      p.session === "regular"
        ? "The share price has not updated for over 30 minutes during market hours: treat it as unreliable."
        : "The share reference is more than 4 days old: treat it as unreliable.",
    );
  if (p.session === "weekend")
    caveats.push("Weekend: the share does not trade, so a premium is the pool pricing Monday's open, not mispricing.");
  if ((p.session === "extended" || p.session === "overnight") && status !== "missing")
    caveats.push("Outside regular hours the share can move in extended trading that the reference does not show.");
  if (p.spreadBps != null && p.spreadBps > PREMIUM_BANDS.passBps)
    caveats.push("The on-chain bid/ask spread is wide, so the mid itself is uncertain.");
  const thin = p.exitUsd != null && p.exitUsd < THIN_POOL_USD;
  if (thin)
    caveats.push(
      `Thin pool: about $${Math.round(p.exitUsd!).toLocaleString("en-US")} of USDC to sell into, so small trades move the price.`,
    );
  if (p.premiumBps == null) return { level: "warn", caveats };
  const abs = Math.abs(p.premiumBps);
  let level: Assessment["level"] = abs < PREMIUM_BANDS.passBps ? "pass" : abs < PREMIUM_BANDS.failBps ? "warn" : "fail";
  if (level === "pass" && (status === "stale" || status === "last-close" || thin)) level = "warn";
  return { level, caveats };
}
