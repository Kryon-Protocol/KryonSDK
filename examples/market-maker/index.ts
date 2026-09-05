/**
 * A minimal market maker for Kryon.
 *
 * Quotes a two-sided ladder around the oracle price, re-centres it when the
 * price moves, and flattens on shutdown. It is a working example of the
 * runtime's shape, not a strategy anyone should run with real money: it has
 * no inventory skew, no adverse-selection protection, and no view on fair
 * value beyond the oracle.
 *
 * Run it against testnet in paper mode first — no funds required:
 *
 *   KRYON_PAPER=1 pnpm start
 *
 * To trade for real on testnet, set KRYON_SECRET to a funded testnet key.
 */

import { KryonAgent, type AgentContext } from "@kryon/agent";
import { KeypairSigner, KryonClient } from "@kryon/sdk";

const MARKET = process.env.KRYON_MARKET ?? "XLM-PERP";
const PAPER = process.env.KRYON_PAPER === "1";
const LEVELS = Number(process.env.KRYON_LEVELS ?? 3);
const SPREAD_BPS = Number(process.env.KRYON_SPREAD_BPS ?? 10);
const SIZE = Number(process.env.KRYON_SIZE ?? 10);

class MarketMaker extends KryonAgent {
  #quotedAround = 0;

  protected override async onStart(ctx: AgentContext): Promise<void> {
    const market = ctx.markets.find((m) => m.symbol === MARKET);
    ctx.log.info(`market maker starting on ${MARKET}`, {
      oracle: market?.lastOraclePrice,
      tick: market?.tickSizes?.[0],
      paper: PAPER,
    });
  }

  protected override async onTick(ctx: AgentContext): Promise<void> {
    const market = ctx.markets.find((m) => m.symbol === MARKET);
    if (!market || !market.active) {
      ctx.log.warn(`${MARKET} is not tradable right now`);
      return;
    }

    const oracle = Number(market.lastOraclePrice);
    if (!Number.isFinite(oracle) || oracle <= 0) {
      ctx.log.warn("no usable oracle price yet");
      return;
    }

    const book = await ctx.orderbook(MARKET);
    // The runtime refuses a crossed book by default, but say so plainly rather
    // than letting the strategy look broken.
    if (book.crossed) {
      ctx.log.warn(
        `${MARKET} book is crossed (bid ${book.bestBid} >= ask ${book.bestAsk}); sitting out`,
      );
      return;
    }

    // Only re-quote when the price has actually moved, so the venue is not
    // hammered with churn for its own sake.
    const drift = Math.abs(oracle - this.#quotedAround) / oracle;
    if (this.#quotedAround > 0 && drift < SPREAD_BPS / 10_000 / 2) return;

    if (ctx.openOrders.length > 0) {
      const cancelled = await ctx.cancelAll(MARKET);
      ctx.log.info(`re-centring: cancelled ${cancelled.length} order(s)`);
    }

    const tick = market.tickSizes?.[0] ?? 0.0001;
    for (let level = 1; level <= LEVELS; level += 1) {
      const offset = (oracle * SPREAD_BPS * level) / 10_000;
      const bid = roundTo(oracle - offset, tick);
      const ask = roundTo(oracle + offset, tick);

      await ctx.placeOrder({ market: MARKET, side: "buy", size: SIZE, price: bid });
      await ctx.placeOrder({ market: MARKET, side: "sell", size: SIZE, price: ask });
    }

    this.#quotedAround = oracle;
    ctx.log.info(`quoted ${LEVELS} levels each side around ${oracle}`, {
      position: ctx.position(MARKET),
    });
  }

  protected override async onFill(fill: { size: string; price: string }, ctx: AgentContext) {
    ctx.log.info(`filled ${fill.size} @ ${fill.price}`, {
      position: ctx.position(MARKET),
    });
    // Force a re-quote on the next tick: inventory changed.
    this.#quotedAround = 0;
  }
}

function roundTo(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}

const secret = process.env.KRYON_SECRET;
if (!secret && !PAPER) {
  console.error(
    "Set KRYON_SECRET to a testnet key, or run with KRYON_PAPER=1 to trade on paper.",
  );
  process.exit(1);
}

const client = new KryonClient({
  network: "testnet",
  signer: secret ? new KeypairSigner(secret) : KeypairSigner.random(),
});

const agent = new MarketMaker({
  client,
  paper: PAPER,
  intervalMs: 5_000,
  markets: [MARKET],
  risk: {
    // Deliberately tight for an example.
    defaultMaxPositionSize: SIZE * LEVELS * 2,
    maxOrderNotionalUsd: 500,
    maxOpenOrders: LEVELS * 2,
    maxOrdersPerMinute: 20,
    maxDrawdownUsd: 50,
  },
});

await agent.run();
