/**
 * Agent lifecycle, against a stub client. No network.
 */
import { describe, expect, it, vi } from "vitest";
import { KryonAgent, type AgentContext } from "../src/agent.js";
import type { KryonClient } from "@kryon/sdk";

const listing = [{
  marketId: 1, symbol: "XLM-PERP", active: true,
  lastPrice: "0.2000", volume: "0", longOpenInterest: "0", shortOpenInterest: "0",
  fundingLongIndex: "0", fundingShortIndex: "0", lastOraclePrice: "0.2000",
  baseAsset: "XLM", quoteAsset: "USDC", priceDecimals: 4, sizeDecimals: 4,
  tickSizes: [0.0001], maxLeverageBps: 100000, initialMarginBps: 1000,
  maintenanceMarginBps: 500, liquidationFeeBps: 50, maxOpenInterestBase: 1450000,
  updatedAt: Date.now(),
}];

const book = {
  marketId: 1,
  bids: [{ price: "0.2000", size: "100" }],
  asks: [{ price: "0.2010", size: "100" }],
  timestamp: 1, bestBid: "0.2000", bestAsk: "0.2010",
  mid: "0.2005", spread: "0.0010", crossed: false,
};

function stubClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    canSign: true,
    listMarkets: vi.fn(async () => listing),
    positions: vi.fn(async () => []),
    openOrders: vi.fn(async () => []),
    fills: vi.fn(async () => []),
    orderbook: vi.fn(async () => book),
    placeOrder: vi.fn(async () => ({ nonce: 1n })),
    cancelOrder: vi.fn(async () => {}),
    cancelAll: vi.fn(async () => [1n, 2n]),
    ...over,
  } as unknown as KryonClient;
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe("lifecycle", () => {
  it("runs start, ticks, then stop in order", async () => {
    const order: string[] = [];
    class A extends KryonAgent {
      protected override async onStart() { order.push("start"); }
      protected override async onTick(ctx: AgentContext) {
        order.push(`tick${ctx.tick}`);
        if (ctx.tick === 2) ctx.stop("done");
      }
      protected override async onStop() { order.push("stop"); }
    }
    await new A({
      client: stubClient(), intervalMs: 1, logger: silent, handleSignals: false,
    }).run();

    expect(order).toEqual(["start", "tick1", "tick2", "stop"]);
  });

  it("keeps going when one tick throws", async () => {
    let ticks = 0;
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        ticks += 1;
        if (ticks === 1) throw new Error("bad tick");
        if (ticks >= 3) ctx.stop();
      }
    }
    await new A({
      client: stubClient(), intervalMs: 1, logger: silent, handleSignals: false,
    }).run();

    // A single bad tick must not kill a long-running bot.
    expect(ticks).toBe(3);
  });
});

describe("shutdown", () => {
  it("cancels resting orders on the way out", async () => {
    const client = stubClient();
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) { ctx.stop(); }
    }
    await new A({ client, intervalMs: 1, logger: silent, handleSignals: false }).run();
    expect(client.cancelAll).toHaveBeenCalled();
  });

  it("still stops when the cancel fails, and does not swallow it silently", async () => {
    const errors: string[] = [];
    const client = stubClient({
      cancelAll: vi.fn(async () => { throw new Error("venue down"); }),
    });
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) { ctx.stop(); }
    }
    await new A({
      client, intervalMs: 1, handleSignals: false,
      logger: { ...silent, error: (m) => errors.push(m) },
    }).run();

    expect(errors.join(" ")).toMatch(/COULD NOT CANCEL/);
  });

  it("can be told to leave orders resting", async () => {
    const client = stubClient();
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) { ctx.stop(); }
    }
    await new A({
      client, intervalMs: 1, logger: silent, handleSignals: false,
      cancelOnShutdown: false,
    }).run();
    expect(client.cancelAll).not.toHaveBeenCalled();
  });
});

describe("risk integration", () => {
  it("never sends an order that breaches a limit", async () => {
    const client = stubClient();
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        // The runtime logs the violation and keeps running, so stop from a
        // finally block rather than after the call that is expected to throw.
        try {
          await ctx.placeOrder({ market: "XLM-PERP", side: "buy", size: 1000, price: 0.2 });
        } finally {
          ctx.stop();
        }
      }
    }
    await new A({
      client, intervalMs: 1, logger: silent, handleSignals: false,
      risk: { maxOrderNotionalUsd: 10 },
    }).run();

    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it("refuses to quote into a crossed book", async () => {
    const client = stubClient({
      orderbook: vi.fn(async () => ({ ...book, crossed: true })),
    });
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        try {
          await ctx.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 });
        } finally {
          ctx.stop();
        }
      }
    }
    await new A({
      client, intervalMs: 1, logger: silent, handleSignals: false,
    }).run();

    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it("halts the whole agent when drawdown is breached", async () => {
    const client = stubClient();
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        this.risk.halt("manual halt for test");
        // A halt stops the agent from the run loop, so no explicit stop here.
        await ctx.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 });
      }
    }
    const agent = new A({
      client, intervalMs: 1, logger: silent, handleSignals: false,
    });
    await agent.run();

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(agent.risk.haltReason).toBe("manual halt for test");
  });
});

describe("paper mode", () => {
  it("signs and sends nothing", async () => {
    const client = stubClient();
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        await ctx.placeOrder({ market: "XLM-PERP", side: "buy", size: 10 });
        ctx.stop();
      }
    }
    const agent = new A({
      client, intervalMs: 1, logger: silent, handleSignals: false, paper: true,
    });
    await agent.run();

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(client.cancelAll).not.toHaveBeenCalled();
    expect(agent.paperFills).toHaveLength(1);
    expect(agent.paperFills[0]!.size).toBe(10);
  });

  it("tracks a simulated position through the context", async () => {
    const positions: number[] = [];
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        if (ctx.tick === 1) {
          await ctx.placeOrder({ market: "XLM-PERP", side: "buy", size: 10 });
        } else {
          positions.push(ctx.position("XLM-PERP"));
          ctx.stop();
        }
      }
    }
    await new A({
      client: stubClient(), intervalMs: 1, logger: silent,
      handleSignals: false, paper: true,
    }).run();

    expect(positions).toEqual([10]);
  });
});

describe("guards", () => {
  it("refuses to run twice at once", async () => {
    class A extends KryonAgent {
      protected override async onTick(ctx: AgentContext) {
        await new Promise((r) => setTimeout(r, 20));
        ctx.stop();
      }
    }
    const agent = new A({
      client: stubClient(), intervalMs: 1, logger: silent, handleSignals: false,
    });
    const first = agent.run();
    await expect(agent.run()).rejects.toThrow(/already running/);
    await first;
  });
});
