import { describe, expect, it } from "vitest";
import { PaperBroker } from "../src/paper.js";
import type { OrderBook } from "@kryon/sdk";

const book: OrderBook = {
  marketId: 1,
  bids: [
    { price: "0.2000", size: "100" },
    { price: "0.1990", size: "200" },
  ],
  asks: [
    { price: "0.2010", size: "100" },
    { price: "0.2020", size: "200" },
  ],
  timestamp: 1,
  bestBid: "0.2000",
  bestAsk: "0.2010",
  mid: "0.2005",
  spread: "0.0010",
  crossed: false,
};

describe("paper fills", () => {
  it("fills a small market buy at the top of book", () => {
    const broker = new PaperBroker();
    broker.place({ market: "XLM-PERP", side: "buy", size: 50 }, book);

    expect(broker.fills).toHaveLength(1);
    expect(broker.fills[0]!.price).toBeCloseTo(0.201, 6);
    expect(broker.position("XLM-PERP")).toBe(50);
  });

  it("walks the book and pays each level, rather than filling all at the top", () => {
    const broker = new PaperBroker();
    // 150 takes all 100 at 0.2010, then 50 at 0.2020.
    broker.place({ market: "XLM-PERP", side: "buy", size: 150 }, book);

    const expected = (100 * 0.201 + 50 * 0.202) / 150;
    expect(broker.fills[0]!.price).toBeCloseTo(expected, 6);
    expect(broker.fills[0]!.price).toBeGreaterThan(0.201);
  });

  it("sells into the bid side", () => {
    const broker = new PaperBroker();
    broker.place({ market: "XLM-PERP", side: "sell", size: 50 }, book);
    expect(broker.fills[0]!.price).toBeCloseTo(0.2, 6);
    expect(broker.position("XLM-PERP")).toBe(-50);
  });

  it("does not cross a limit that is not marketable", () => {
    const broker = new PaperBroker();
    // Bidding 0.1900 when the best ask is 0.2010: no fill, it rests.
    broker.place({ market: "XLM-PERP", side: "buy", size: 50, price: 0.19 }, book);

    expect(broker.fills).toHaveLength(0);
    expect(broker.position("XLM-PERP")).toBe(0);
  });

  it("partially fills a limit that only crosses one level", () => {
    const broker = new PaperBroker();
    // Bid 0.2010 takes the 100 resting there, and rests the remaining 50.
    broker.place({ market: "XLM-PERP", side: "buy", size: 150, price: 0.201 }, book);

    expect(broker.fills[0]!.size).toBe(100);
    expect(broker.position("XLM-PERP")).toBe(100);
  });

  it("nets a long against a subsequent sell", () => {
    const broker = new PaperBroker();
    broker.place({ market: "XLM-PERP", side: "buy", size: 50 }, book);
    broker.place({ market: "XLM-PERP", side: "sell", size: 30 }, book);
    expect(broker.position("XLM-PERP")).toBe(20);
  });

  it("tracks turnover across fills", () => {
    const broker = new PaperBroker();
    broker.place({ market: "XLM-PERP", side: "buy", size: 50 }, book);
    expect(broker.turnoverUsd).toBeCloseTo(50 * 0.201, 6);
  });
});

describe("paper cancels", () => {
  it("removes a resting order", () => {
    const broker = new PaperBroker();
    const o = broker.place({ market: "XLM-PERP", side: "buy", size: 50, price: 0.19 }, book);
    expect(broker.cancelAll()).toContain(o.nonce);
    expect(broker.cancelAll()).toHaveLength(0);
  });

  it("scopes a cancel to one market", () => {
    const broker = new PaperBroker();
    broker.place({ market: "XLM-PERP", side: "buy", size: 1, price: 0.19 }, book);
    broker.place({ market: "BTC-PERP", side: "buy", size: 1, price: 0.19 }, book);

    expect(broker.cancelAll("XLM-PERP")).toHaveLength(1);
    expect(broker.cancelAll()).toHaveLength(1);
  });
});
