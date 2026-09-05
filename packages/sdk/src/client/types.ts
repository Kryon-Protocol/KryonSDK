/**
 * Public result types.
 *
 * These are normalised: every price and size a caller sees is a human-unit
 * decimal STRING, never a raw fixed-point value and never a float. The REST
 * API mixes both conventions depending on the route (`/markets/:id` is raw
 * 1e18/1e7, most others are pre-scaled), and that seam is hidden here rather
 * than left for each bot author to rediscover.
 *
 * Strings rather than numbers because a 1e18 price does not survive a float,
 * and because a bot that wants exact arithmetic should reach for the bigint
 * helpers in `util/units` rather than silently inherit float error.
 */

/** Live state of one market. */
export interface MarketState {
  marketId: number;
  symbol: string;
  /** Last traded price, human units. "0" when the market has never traded. */
  lastPrice: string;
  /** Cumulative traded volume in base units. */
  volume: string;
  /** Open interest on each side, in base units. */
  longOpenInterest: string;
  shortOpenInterest: string;
  /** Cumulative funding indices, human units. */
  fundingLongIndex: string;
  fundingShortIndex: string;
  /** Latest oracle (mark) price, human units. */
  lastOraclePrice: string;
  active: boolean;
}

/** One aggregated price level. */
export interface BookLevel {
  /** Human-unit price. */
  price: string;
  /** Total resting size at this level, human units. */
  size: string;
}

/** An order-book snapshot. Kryon publishes full snapshots, never deltas. */
export interface OrderBook {
  marketId: number;
  /** Best bid first (descending price). */
  bids: BookLevel[];
  /** Best ask first (ascending price). */
  asks: BookLevel[];
  /** Venue timestamp, unix ms. */
  timestamp: number;
  /** Best bid price, human units, or null when there are no bids. */
  bestBid: string | null;
  /** Best ask price, human units, or null when there are no asks. */
  bestAsk: string | null;
  /** (bestBid + bestAsk) / 2, or null when either side is empty. */
  mid: string | null;
  /** bestAsk - bestBid. Negative when the book is crossed. */
  spread: string | null;
  /**
   * True when the best bid is at or above the best ask.
   *
   * On a healthy venue this cannot happen — such orders would have matched.
   * On Kryon it does happen, and persistently: orders whose owner lacks the
   * margin to settle fail simulation, get rolled back, and rest in the book
   * forever. As of 2026-09-05 the mainnet XLM-PERP book is crossed by ~11%
   * with 91 of 99 bid levels above the best ask.
   *
   * **Check this before deriving a mid-price, a spread, or a signal from the
   * book.** A crossed book is not a trading opportunity: those levels cannot
   * be filled, and a bot that tries will burn its rate limit rediscovering
   * that. `mid` and `spread` are still reported so you can see how bad it is.
   */
  crossed: boolean;
}

/** A public trade print. */
export interface Trade {
  price: string;
  size: string;
  /**
   * Reported aggressor side.
   *
   * NOTE: the venue currently derives this from maker-nonce parity rather than
   * the real taker direction, so it is not a trustworthy order-flow signal.
   * Treat it as decorative until the venue reports the true side.
   */
  side: "buy" | "sell";
  /** Unix ms. */
  timestamp: number;
}

/** A fill involving a specific account. */
export interface Fill {
  id: string;
  marketId: number;
  /** True when this account was the resting side. */
  isMaker: boolean;
  price: string;
  size: string;
  /** Stellar transaction hash of the on-chain settlement. */
  txHash: string;
  /** Unix ms. */
  createdAt: number;
}

/** An open position, read from the engine contract. */
export interface Position {
  marketId: number;
  isLong: boolean;
  /** Position size in base units, human. */
  size: string;
  /** Volume-weighted entry price, human. */
  entryPrice: string;
  /** Collateral assigned to this position, human USDC. */
  margin: string;
  /** Funding index at last settlement, for accrual accounting. */
  lastFundingIndex: string;
}

/** Margin state for an account, read from the vault contract. */
export interface AccountHealth {
  /** Deposited collateral, human USDC. */
  collateralValue: string;
  unrealizedPnl: string;
  /** collateral + unrealized PnL. */
  equity: string;
  initialMarginRequired: string;
  maintenanceMarginRequired: string;
  /** Equity available for new positions. */
  freeCollateral: string;
  /** equity / maintenance requirement. */
  marginRatio: string;
  /** True when this account can be liquidated right now. */
  liquidatable: boolean;
}

/** The result of placing an order. */
export interface PlacedOrder {
  /** The venue's order id, `<owner>:<nonce>`. */
  id: string;
  owner: string;
  marketId: number;
  isLong: boolean;
  /** Human-unit size as submitted. */
  size: string;
  /** Human-unit limit price, or "0" for a market order. */
  limitPrice: string;
  reduceOnly: boolean;
  /** The nonce this order was signed with — needed to cancel it. */
  nonce: bigint;
  /** Unix seconds at which the venue will stop matching this order. */
  expiryTs: bigint;
  /** The exact body that was submitted, for logging and replay. */
  signedPayload: Record<string, unknown>;
}

/** Venue liveness. */
export interface VenueStatus {
  ok: boolean;
  network: string;
  /** Symbols the venue currently lists. */
  markets: string[];
  /** Whether a realtime stream is configured for this venue. */
  websocketConfigured: boolean;
  timestamp: string;
}
