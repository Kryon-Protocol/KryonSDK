import { describe, expect, it } from "vitest";
import { RiskEngine, RiskViolation, type ProposedOrder, type RiskState } from "../src/risk.js";

const emptyState: RiskState = { positions: [], openOrders: [], realisedPnlUsd: 0 };

const order = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  market: "BTC-PERP",
  side: "buy",
  size: 0.1,
  referencePrice: 77_000,
  ...over,
});

describe("position limits", () => {
  it("blocks an order that would push the position past the limit", () => {
    const risk = new RiskEngine({ maxPositionSize: { "BTC-PERP": 0.5 } });
    expect(() => risk.check(order({ size: 0.6 }), emptyState)).toThrow(RiskViolation);
  });

  it("allows an order that stays inside the limit", () => {
    const risk = new RiskEngine({ maxPositionSize: { "BTC-PERP": 0.5 } });
    expect(() => risk.check(order({ size: 0.4 }), emptyState)).not.toThrow();
  });

  it("counts the existing position, not just the new order", () => {
    const risk = new RiskEngine({ maxPositionSize: { "BTC-PERP": 0.5 } });
    const state: RiskState = {
      ...emptyState,
      positions: [{
        marketId: 2, isLong: true, size: "0.4", entryPrice: "77000",
        margin: "1000", lastFundingIndex: "0",
      }],
    };
    expect(() => risk.check(order({ size: 0.2 }), state)).toThrow(/would become/);
  });

  it("lets a reduce-only order through even at the limit", () => {
    const risk = new RiskEngine({ maxPositionSize: { "BTC-PERP": 0.5 } });
    const state: RiskState = {
      ...emptyState,
      positions: [{
        marketId: 2, isLong: true, size: "0.5", entryPrice: "77000",
        margin: "1000", lastFundingIndex: "0",
      }],
    };
    // Selling reduces a long position; it can never breach a size cap.
    expect(() =>
      risk.check(order({ side: "sell", size: 0.5, reduceOnly: true }), state),
    ).not.toThrow();
  });

  it("applies a default limit to markets without a specific one", () => {
    const risk = new RiskEngine({ defaultMaxPositionSize: 1 });
    expect(() => risk.check(order({ market: "ETH-PERP", size: 2 }), emptyState)).toThrow(RiskViolation);
  });
});

describe("notional limits", () => {
  it("blocks an order above the per-order notional cap", () => {
    const risk = new RiskEngine({ maxOrderNotionalUsd: 1000 });
    // 0.1 BTC at 77,000 is 7,700 USD.
    expect(() => risk.check(order(), emptyState)).toThrow(/per-order limit/);
  });

  it("blocks an order that would push gross notional past the cap", () => {
    const risk = new RiskEngine({ maxGrossNotionalUsd: 10_000 });
    const state: RiskState = {
      ...emptyState,
      positions: [{
        marketId: 2, isLong: true, size: "0.1", entryPrice: "77000",
        margin: "1000", lastFundingIndex: "0",
      }],
    };
    expect(() => risk.check(order(), state)).toThrow(/gross notional/);
  });
});

describe("rate limiting", () => {
  it("trips before the venue's own limit does", () => {
    const risk = new RiskEngine({ maxOrdersPerMinute: 3 });
    for (let i = 0; i < 3; i += 1) {
      risk.check(order({ size: 0.001 }), emptyState);
      risk.recordOrder();
    }
    expect(() => risk.check(order({ size: 0.001 }), emptyState)).toThrow(/orders in the last minute/);
  });

  it("defaults below the venue's 30 per minute", () => {
    const risk = new RiskEngine();
    for (let i = 0; i < 25; i += 1) risk.recordOrder();
    expect(() => risk.check(order({ size: 0.001 }), emptyState)).toThrow(RiskViolation);
  });
});

describe("open order limits", () => {
  it("blocks a new order once too many are resting", () => {
    const risk = new RiskEngine({ maxOpenOrders: 2 });
    const resting = { openOrders: [{}, {}] as never[] };
    expect(() => risk.check(order({ size: 0.001 }), { ...emptyState, ...resting })).toThrow(/already resting/);
  });
});

describe("drawdown", () => {
  it("halts permanently once the loss limit is hit", () => {
    const risk = new RiskEngine({ maxDrawdownUsd: 100 });
    const losing: RiskState = { ...emptyState, realisedPnlUsd: -150 };

    expect(() => risk.check(order({ size: 0.001 }), losing)).toThrow(/drawdown limit/);
    expect(risk.haltReason).toMatch(/drawdown/);

    // Even after PnL recovers, the halt stands: a bot that can un-halt itself
    // will, for the same reason it halted.
    expect(() => risk.check(order({ size: 0.001 }), emptyState)).toThrow(/Trading halted/);
  });

  it("allows trading while inside the limit", () => {
    const risk = new RiskEngine({ maxDrawdownUsd: 100 });
    expect(() =>
      risk.check(order({ size: 0.001 }), { ...emptyState, realisedPnlUsd: -50 }),
    ).not.toThrow();
  });
});

describe("book and oracle sanity", () => {
  it("refuses to trade a crossed book by default", () => {
    const risk = new RiskEngine();
    expect(() => risk.checkBook("XLM-PERP", { crossed: true })).toThrow(/crossed/);
  });

  it("can be told to trade one anyway", () => {
    const risk = new RiskEngine({ refuseCrossedBook: false });
    expect(() => risk.checkBook("XLM-PERP", { crossed: true })).not.toThrow();
  });

  it("refuses a stale oracle price", () => {
    const risk = new RiskEngine({ maxOracleAgeSeconds: 60 });
    const now = Date.now();
    expect(() => risk.checkOracleAge("XLM-PERP", now - 120_000, now)).toThrow(/oracle price is/);
    expect(() => risk.checkOracleAge("XLM-PERP", now - 30_000, now)).not.toThrow();
  });
});

describe("halt", () => {
  it("keeps the first reason, not the latest", () => {
    const risk = new RiskEngine();
    risk.halt("first reason");
    risk.halt("second reason");
    expect(risk.haltReason).toBe("first reason");
  });
});
