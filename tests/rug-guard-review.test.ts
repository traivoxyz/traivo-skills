import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUG_THRESHOLDS,
  rugReview,
  rugVerdict,
  scanSelectors,
  top10Share,
  type RugFacts,
} from "../skills/rug-guard-review/scripts/review.js";
import { RISKY_SELECTORS } from "../skills/rug-guard-review/scripts/facts.js";

const clean: RugFacts = {
  symbol: "OK",
  owner: { status: "renounced", address: "0x0000000000000000000000000000000000000000" },
  proxy: false,
  riskyGroups: [],
  hasCode: true,
  exitUsd: 250_000,
  poolAgeHours: 24 * 30,
  top10Share: 0.1,
  deployerShare: 0,
};
const level = (f: RugFacts, id: string) => rugReview(f).find((c) => c.id === id)?.level;

describe("rugReview", () => {
  it("passes a clean token", () => {
    const checks = rugReview(clean);
    expect(checks.every((c) => c.level === "pass")).toBe(true);
    expect(rugVerdict(checks)).toBe("pass");
  });
  it("treats missing facts as unknown, and unknown as not safe", () => {
    const checks = rugReview({
      ...clean,
      hasCode: null,
      exitUsd: null,
      poolAgeHours: null,
      top10Share: null,
      deployerShare: null,
      owner: null,
      proxy: null,
      riskyGroups: null,
    });
    expect(checks.every((c) => c.level === "unknown")).toBe(true);
    expect(rugVerdict(checks)).toBe("warn");
  });
  it("applies exit liquidity, age, holder and deployer thresholds", () => {
    expect(level({ ...clean, exitUsd: 2_499 }, "liquidity")).toBe("fail");
    expect(level({ ...clean, exitUsd: 2_500 }, "liquidity")).toBe("warn");
    expect(level({ ...clean, exitUsd: 24_999 }, "liquidity")).toBe("warn");
    expect(level({ ...clean, exitUsd: 25_000 }, "liquidity")).toBe("pass");
    expect(level({ ...clean, poolAgeHours: 23.9 }, "pool-age")).toBe("warn");
    expect(level({ ...clean, top10Share: 0.3 }, "holders")).toBe("warn");
    expect(level({ ...clean, top10Share: 0.5 }, "holders")).toBe("fail");
    expect(level({ ...clean, deployerShare: 0.05 }, "deployer")).toBe("warn");
    expect(level({ ...clean, deployerShare: 0.2 }, "deployer")).toBe("fail");
  });
  it("accepts custom thresholds", () => {
    const strict = { ...DEFAULT_RUG_THRESHOLDS, exitFailUsd: 1_000_000 };
    expect(rugReview(clean, strict).find((c) => c.id === "liquidity")!.level).toBe("fail");
  });
  it("fails an address without contract code", () => {
    expect(level({ ...clean, hasCode: false }, "code")).toBe("fail");
    expect(rugReview(clean).some((c) => c.id === "code")).toBe(false);
  });
  it("fails a mint function while the owner is live, warns once renounced", () => {
    const live: RugFacts = {
      ...clean,
      owner: { status: "active", address: "0x1111111111111111111111111111111111111111" },
      riskyGroups: ["mint"],
    };
    expect(level(live, "mint")).toBe("fail");
    expect(level(live, "owner")).toBe("warn");
    expect(rugReview(live).find((c) => c.id === "owner")!.detail).toMatch(/0x1111/);
    expect(level({ ...clean, riskyGroups: ["mint"] }, "mint")).toBe("warn");
  });
  it("warns on proxies, no owner(), and other admin powers", () => {
    expect(level({ ...clean, proxy: true }, "proxy")).toBe("warn");
    expect(level({ ...clean, owner: { status: "none" } }, "owner")).toBe("warn");
    const ids = rugReview({ ...clean, riskyGroups: ["blacklist", "pause", "tax", "limits"] })
      .filter((c) => c.level === "warn")
      .map((c) => c.id);
    expect(ids).toEqual(["blacklist", "pause", "tax", "limits"]);
  });
});

describe("top10Share", () => {
  it("excludes pool and burn addresses and takes the 10 largest", () => {
    const holders = [
      { address: "0xPOOL", balance: 500 },
      ...Array.from({ length: 12 }, (_, i) => ({ address: `0x${i}`, balance: 10 + i })),
    ];
    // largest 10 of 10..21 = 12..21 → sum 165
    expect(top10Share(holders, 1000, ["0xpool"])).toBeCloseTo(0.165, 10);
    expect(top10Share(holders, 0)).toBeNull();
  });
});

describe("scanSelectors", () => {
  it("finds PUSH4 selector operands only", () => {
    const mint = toFunctionSelector("function mint(address,uint256)").slice(2);
    expect(scanSelectors(`0x6080${"63"}${mint}14`, RISKY_SELECTORS)).toEqual(["mint"]);
    expect(scanSelectors(`0x6080${mint}`, RISKY_SELECTORS)).toEqual([]);
    expect(scanSelectors("0x", RISKY_SELECTORS)).toEqual([]);
  });
  it("precomputes a selector for every listed function", () => {
    expect(RISKY_SELECTORS.mint[0]).toBe("0x40c10f19");
    for (const group of Object.values(RISKY_SELECTORS)) for (const s of group) expect(s).toMatch(/^0x[0-9a-f]{8}$/);
  });
});
