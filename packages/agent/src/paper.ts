/**
 * Paper trading.
 *
 * Fills are simulated against the LIVE order book, so the market data is real
 * and only the execution is not. Nothing is signed and nothing is sent, so a
 * paper agent needs no funds, no trustline, and no vault deposit — it needs
 * only a public key.
 *
 * The fill model is deliberately pessimistic, because an optimistic one
 * produces a backtest that cannot be reproduced with real money:
 *
 *  - a market order walks the book level by level and pays each level's price,
 *    rather than filling everything at the top of book
 *  - a limit order fills only against levels that are already better than its
 *    limit, and only for the size resting there
 *  - anything it cannot fill immediately rests, and rests forever until
 *    cancelled: there is no simulation of other participants arriving
 *
 * That last point is the honest limitation. Paper mode will under-report fills
 * for a passive strategy, because nobody ever trades against your quote.
 * It is a rehearsal for the plumbing and the risk limits, not a backtest.
 */

import type { OrderBook, PlacedOrder } from "@kryon/sdk";

export interface PaperFill {
  market: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  timestamp: number;
}

interface RestingPaperOrder {
  nonce: bigint;
  market: string;
  side: "buy" | "sell";
  size: number;
  price: number;
}

export class PaperBroker {
  readonly #fills: PaperFill[] = [];
  readonly #resting = new Map<bigint, RestingPaperOrder>();
  readonly #positions = new Map<string, number>();
  #nextNonce = BigInt(Date.now()) * 1000n;

  get fills(): ReadonlyArray<PaperFill> {
    return this.#fills;
  }

  /** Net signed position in a market, base units. */
  position(market: string): number {
    return this.#positions.get(market) ?? 0;
  }

  /** Realised notional traded, USD. */
  get turnoverUsd(): number {
    return this.#fills.reduce((sum, f) => sum + f.size * f.price, 0);
  }

  place(
    params: {
      market: string;
      side: "buy" | "sell";
      size: number;
      price?: number;
      reduceOnly?: boolean;
    },
    book: OrderBook,
  ): PlacedOrder {
    const nonce = this.#nextNonce++;
    const levels = params.side === "buy" ? book.asks : book.bids;

    let remaining = params.size;
    let notional = 0;

    for (const level of levels) {
      if (remaining <= 0) break;
      const levelPrice = Number(level.price);
      const levelSize = Number(level.size);

      // A limit order only crosses levels at least as good as its limit.
      if (params.price !== undefined && params.price > 0) {
        const acceptable =
          params.side === "buy" ? levelPrice <= params.price : levelPrice >= params.price;
        if (!acceptable) break;
      }

      const take = Math.min(remaining, levelSize);
      remaining -= take;
      notional += take * levelPrice;
    }

    const filled = params.size - remaining;
    if (filled > 0) {
      const avgPrice = notional / filled;
      this.#fills.push({
        market: params.market,
        side: params.side,
        size: filled,
        price: avgPrice,
        timestamp: Date.now(),
      });
      const signed = params.side === "buy" ? filled : -filled;
      this.#positions.set(params.market, this.position(params.market) + signed);
    }

    if (remaining > 0 && params.price !== undefined && params.price > 0) {
      this.#resting.set(nonce, {
        nonce,
        market: params.market,
        side: params.side,
        size: remaining,
        price: params.price,
      });
    }

    return {
      id: `paper:${nonce}`,
      owner: "paper",
      marketId: book.marketId,
      isLong: params.side === "buy",
      size: params.size.toString(),
      limitPrice: (params.price ?? 0).toString(),
      reduceOnly: params.reduceOnly ?? false,
      nonce,
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 300),
      signedPayload: { paper: true },
    };
  }

  cancel(nonce: bigint): void {
    this.#resting.delete(nonce);
  }

  cancelAll(market?: string): bigint[] {
    const cancelled: bigint[] = [];
    for (const [nonce, order] of this.#resting) {
      if (market === undefined || order.market === market) {
        this.#resting.delete(nonce);
        cancelled.push(nonce);
      }
    }
    return cancelled;
  }
}
