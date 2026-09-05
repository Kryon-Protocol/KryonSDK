/**
 * Risk guards.
 *
 * These are ON by default and deliberately hard to switch off. A trading bot
 * with no limits is not a trading bot, it is an unbounded loss generator with
 * a schedule — and the failure modes are not exotic: a stuck price feed, an
 * inverted sign, a retry storm, a crossed book mistaken for free money.
 *
 * Every guard is checked BEFORE an order is signed, so a breach costs nothing
 * and leaves no trace at the venue.
 */

import { MARKETS_BY_ID, type OpenOrder, type Position } from "@kryon/sdk";

export interface RiskLimits {
  /**
   * Largest absolute position per market, in base units.
   * e.g. `{ "BTC-PERP": 0.5 }`.
   */
  maxPositionSize?: Record<string, number>;
  /** Largest absolute position for any market without a specific limit. */
  defaultMaxPositionSize?: number;
  /** Largest total notional across all positions, in USD. */
  maxGrossNotionalUsd?: number;
  /** Largest notional for any single order, in USD. */
  maxOrderNotionalUsd?: number;
  /** Most resting orders at once, across all markets. */
  maxOpenOrders?: number;
  /**
   * Most orders per minute. Defaults to 25, just under the venue's own 30, so
   * the guard trips before the venue starts rejecting.
   */
  maxOrdersPerMinute?: number;
  /**
   * Stop trading permanently once realised losses reach this many USD.
   * The single most important limit here: it is the one that ends a bad day
   * instead of letting it compound.
   */
  maxDrawdownUsd?: number;
  /**
   * Refuse to trade a market whose book is crossed. Default true.
   *
   * A crossed book means resting orders that should have matched and did not,
   * usually because their owner cannot settle. The apparent free spread is not
   * takeable, and a bot that chases it burns its rate limit discovering that.
   */
  refuseCrossedBook?: boolean;
  /**
   * Refuse to trade on an oracle price older than this many seconds.
   * Default 120, matching the contract's own staleness guard.
   */
  maxOracleAgeSeconds?: number;
}

export interface RiskState {
  positions: Position[];
  openOrders: OpenOrder[];
  /** Realised PnL so far this session, USD. Negative is a loss. */
  realisedPnlUsd: number;
}

/** A refused action, with the reason in terms a human can act on. */
export class RiskViolation extends Error {
  constructor(
    readonly limit: string,
    message: string,
  ) {
    super(message);
    this.name = "RiskViolation";
  }
}

export interface ProposedOrder {
  market: string;
  side: "buy" | "sell";
  /** Base units. */
  size: number;
  /** Human price; 0 or undefined for a market order. */
  price?: number;
  /** Reference price used for notional checks (mark or limit). */
  referencePrice: number;
  reduceOnly?: boolean;
}

const DEFAULT_MAX_ORDERS_PER_MINUTE = 25;
const DEFAULT_MAX_ORACLE_AGE_SECONDS = 120;

export class RiskEngine {
  readonly #limits: RiskLimits;
  #orderTimestamps: number[] = [];
  #halted: string | null = null;

  constructor(limits: RiskLimits = {}) {
    this.#limits = limits;
  }

  /** Non-null when trading has been stopped for the session, with the reason. */
  get haltReason(): string | null {
    return this.#halted;
  }

  /**
   * Stop all trading for this session.
   *
   * Deliberately one-way: a bot that can un-halt itself will, on the next
   * loop, for the same reason it halted.
   */
  halt(reason: string): void {
    this.#halted ??= reason;
  }

  /**
   * Check a proposed order against every limit.
   *
   * @throws RiskViolation if the order must not be sent.
   */
  check(order: ProposedOrder, state: RiskState): void {
    if (this.#halted) {
      throw new RiskViolation("halted", `Trading halted: ${this.#halted}`);
    }

    this.#checkDrawdown(state);
    this.#checkRate();
    this.#checkOpenOrders(state);
    this.#checkOrderNotional(order);
    this.#checkPositionSize(order, state);
    this.#checkGrossNotional(order, state);
  }

  /** Record that an order was actually sent. Call after a successful place. */
  recordOrder(): void {
    this.#orderTimestamps.push(Date.now());
  }

  /** Throw if the book is unusable. Separate so it can be checked per market. */
  checkBook(market: string, book: { crossed: boolean; locked?: boolean }): void {
    if ((this.#limits.refuseCrossedBook ?? true) && book.crossed) {
      throw new RiskViolation(
        "crossedBook",
        `${market} order book is ${book.locked ? "locked (best bid equals best ask)" : "crossed (best bid above best ask)"}: ` +
          `those orders should have matched and did not, so they cannot actually be ` +
          `filled. Refusing to trade it.`,
      );
    }
  }

  /** Throw if the oracle price is too old to trade against. */
  checkOracleAge(market: string, oracleUpdatedAtMs: number, now = Date.now()): void {
    const maxAge = this.#limits.maxOracleAgeSeconds ?? DEFAULT_MAX_ORACLE_AGE_SECONDS;
    const ageSeconds = (now - oracleUpdatedAtMs) / 1000;
    if (ageSeconds > maxAge) {
      throw new RiskViolation(
        "staleOracle",
        `${market} oracle price is ${Math.round(ageSeconds)}s old (limit ${maxAge}s). ` +
          `Trading on a stale mark is how a position gets liquidated at a price that never existed.`,
      );
    }
  }

  #checkDrawdown(state: RiskState): void {
    const limit = this.#limits.maxDrawdownUsd;
    if (limit === undefined) return;
    if (state.realisedPnlUsd <= -Math.abs(limit)) {
      const reason =
        `drawdown limit hit: realised PnL ${state.realisedPnlUsd.toFixed(2)} USD ` +
        `is at or past the ${-Math.abs(limit)} USD limit`;
      this.halt(reason);
      throw new RiskViolation("maxDrawdownUsd", reason);
    }
  }

  #checkRate(): void {
    const limit = this.#limits.maxOrdersPerMinute ?? DEFAULT_MAX_ORDERS_PER_MINUTE;
    const cutoff = Date.now() - 60_000;
    this.#orderTimestamps = this.#orderTimestamps.filter((t) => t > cutoff);
    if (this.#orderTimestamps.length >= limit) {
      throw new RiskViolation(
        "maxOrdersPerMinute",
        `${this.#orderTimestamps.length} orders in the last minute, limit is ${limit}`,
      );
    }
  }

  #checkOpenOrders(state: RiskState): void {
    const limit = this.#limits.maxOpenOrders;
    if (limit === undefined) return;
    if (state.openOrders.length >= limit) {
      throw new RiskViolation(
        "maxOpenOrders",
        `${state.openOrders.length} orders already resting, limit is ${limit}`,
      );
    }
  }

  #checkOrderNotional(order: ProposedOrder): void {
    const limit = this.#limits.maxOrderNotionalUsd;
    if (limit === undefined) return;
    const notional = Math.abs(order.size * order.referencePrice);
    if (notional > limit) {
      throw new RiskViolation(
        "maxOrderNotionalUsd",
        `order notional ${notional.toFixed(2)} USD exceeds the ${limit} USD per-order limit`,
      );
    }
  }

  #checkPositionSize(order: ProposedOrder, state: RiskState): void {
    const limit =
      this.#limits.maxPositionSize?.[order.market] ??
      this.#limits.defaultMaxPositionSize;
    if (limit === undefined) return;

    const current = netPosition(state.positions, order.market);
    const delta = order.side === "buy" ? order.size : -order.size;
    const projected = current + delta;

    // A reduce-only order can never breach a size limit, by definition.
    if (order.reduceOnly && Math.abs(projected) <= Math.abs(current)) return;

    if (Math.abs(projected) > limit) {
      throw new RiskViolation(
        "maxPositionSize",
        `${order.market} position would become ${projected.toFixed(6)}, ` +
          `past the ${limit} limit (currently ${current.toFixed(6)})`,
      );
    }
  }

  #checkGrossNotional(order: ProposedOrder, state: RiskState): void {
    const limit = this.#limits.maxGrossNotionalUsd;
    if (limit === undefined) return;

    const existing = state.positions.reduce(
      (sum, p) => sum + Math.abs(Number(p.size) * Number(p.entryPrice)),
      0,
    );
    const added = Math.abs(order.size * order.referencePrice);
    if (existing + added > limit) {
      throw new RiskViolation(
        "maxGrossNotionalUsd",
        `gross notional would reach ${(existing + added).toFixed(2)} USD, ` +
          `past the ${limit} USD limit`,
      );
    }
  }
}

/**
 * Net signed position for one market, in base units.
 *
 * Positions carry a market id while limits are keyed by symbol, so the id is
 * resolved through the SDK's registry here. This used to go through a
 * module-level resolver that a caller had to install; if they forgot, every
 * position silently failed to match its limit and the cap never applied. A
 * risk limit that quietly does nothing is worse than no limit at all, so the
 * lookup is now direct and cannot be left uninitialised.
 *
 * @param marketSymbol A symbol (`"BTC-PERP"`) or a market id as a string.
 */
export function netPosition(positions: Position[], marketSymbol: string): number {
  return positions
    .filter((p) => {
      const symbol = MARKETS_BY_ID.get(p.marketId)?.symbol;
      return symbol === marketSymbol || String(p.marketId) === marketSymbol;
    })
    .reduce((sum, p) => sum + (p.isLong ? 1 : -1) * Number(p.size), 0);
}
