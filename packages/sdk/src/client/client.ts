/**
 * `KryonClient` — the main entry point.
 *
 * Wraps the venue's REST API with typed results, human units, local
 * validation, and signing. A bot that only reads market data can construct one
 * without a signer; placing or cancelling orders requires one.
 */

import {
  getNetworkConfig,
  resolveMarket,
  type MarketConfig,
  type NetworkConfig,
  type NetworkId,
} from "../config/index.js";
import {
  signCancelIntent,
  signOrderIntent,
  MonotonicNonceSource,
  type KryonSigner,
  type NonceSource,
  type OrderIntentWire,
} from "../signing/index.js";
import { NotFoundError, PreflightError } from "../util/errors.js";
import {
  priceFromWire,
  priceToWire,
  roundToTick,
  sizeFromWire,
  sizeToWire,
} from "../util/units.js";
import { HttpClient } from "./http.js";
import type {
  AccountHealth,
  Fill,
  MarketState,
  OrderBook,
  PlacedOrder,
  Position,
  Trade,
  VenueStatus,
} from "./types.js";

/** How an order is placed. */
export interface PlaceOrderParams {
  /** Symbol (`"BTC-PERP"`), market id, or a `MarketConfig`. */
  market: string | number | MarketConfig;
  side: "buy" | "sell";
  /** Size in base units, human. e.g. `0.01` on BTC-PERP. */
  size: number | string;
  /**
   * Limit price in human units. Omit (or pass 0) for a market order, which
   * matches at whatever the book offers.
   */
  price?: number | string;
  /** Only reduce an existing position; never open or flip one. */
  reduceOnly?: boolean;
  /**
   * Seconds until the order expires. Default 300.
   *
   * The venue rejects anything under 5s or over 7 days. Kryon has no
   * never-expiring resting order: an unfilled order always ages out, which is
   * a safety property for a bot that dies without cancelling.
   */
  ttlSeconds?: number;
  /**
   * Round the price down to this market's finest tick before signing.
   * Default true.
   */
  roundPrice?: boolean;
}

export interface KryonClientOptions {
  /** Which venue. There is no default: naming it is the point. */
  network: NetworkId;
  /** Required to place or cancel orders; omit for a read-only client. */
  signer?: KryonSigner;
  /** Override the API origin, e.g. to point at a local dev server. */
  apiUrl?: string;
  /** Override nonce generation. Default is monotonic, in-memory. */
  nonceSource?: NonceSource;
  timeoutMs?: number;
  maxAttempts?: number;
  fetch?: typeof globalThis.fetch;
}

/** The venue's documented request budgets, per minute. */
export const RATE_LIMITS = Object.freeze({
  placeOrder: 30,
  cancelOrder: 60,
  readAccount: 120,
});

export class KryonClient {
  readonly network: NetworkConfig;
  readonly #http: HttpClient;
  readonly #signer: KryonSigner | undefined;
  readonly #nonces: NonceSource;

  constructor(options: KryonClientOptions) {
    this.network = getNetworkConfig(options.network);
    this.#signer = options.signer;
    this.#nonces = options.nonceSource ?? new MonotonicNonceSource();
    this.#http = new HttpClient({
      baseUrl: options.apiUrl ?? this.network.apiUrl,
      network: options.network,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  /** The address this client signs for. */
  get address(): string {
    return this.#requireSigner().publicKey();
  }

  /** True when this client can place and cancel orders. */
  get canSign(): boolean {
    return this.#signer !== undefined;
  }

  // ── Venue ────────────────────────────────────────────────────────────────

  /**
   * Venue liveness and the current market listing.
   *
   * Worth calling at startup: `websocketConfigured: false` means the stream is
   * unavailable and a bot should poll instead.
   */
  async status(): Promise<VenueStatus> {
    return this.#http.get<VenueStatus>("/api/ready");
  }

  // ── Market data ──────────────────────────────────────────────────────────

  /** Live state of one market. */
  async market(market: string | number | MarketConfig): Promise<MarketState> {
    const config = resolveMarket(market);
    const raw = await this.#http.get<{
      market_id: number;
      symbol: string;
      last_price: string;
      volume: string;
      long_open_interest: string;
      short_open_interest: string;
      funding_long_index: string;
      funding_short_index: string;
      last_oracle_price: string;
      active: boolean;
    }>(`/api/markets/${config.marketId}`);

    // This route is the one that returns RAW fixed-point, unlike its siblings.
    return {
      marketId: raw.market_id,
      symbol: raw.symbol,
      lastPrice: priceFromWire(raw.last_price, config.priceDecimals),
      volume: sizeFromWire(raw.volume, config.sizeDecimals),
      longOpenInterest: sizeFromWire(raw.long_open_interest, config.sizeDecimals),
      shortOpenInterest: sizeFromWire(raw.short_open_interest, config.sizeDecimals),
      fundingLongIndex: priceFromWire(raw.funding_long_index),
      fundingShortIndex: priceFromWire(raw.funding_short_index),
      lastOraclePrice: priceFromWire(raw.last_oracle_price, config.priceDecimals),
      active: raw.active,
    };
  }

  /**
   * Live state for every market the venue actually serves.
   *
   * `/api/ready` reports the venue's CONFIGURED market list, which is not the
   * same as the set registered in its database — as of 2026-09-05 mainnet
   * advertises all 8 symbols but only has XLM-PERP registered, so asking for
   * the other 7 returns 404. Markets that are advertised but not served are
   * skipped here rather than failing the whole call, so a bot enumerating
   * markets gets what exists instead of an error.
   *
   * Use `status()` if you want the advertised list verbatim.
   */
  async markets(): Promise<MarketState[]> {
    const { markets } = await this.status();
    const results = await Promise.all(
      markets.map(async (symbol) => {
        try {
          return await this.market(symbol);
        } catch (error) {
          if (error instanceof NotFoundError) return null;
          throw error;
        }
      }),
    );
    return results.filter((m): m is MarketState => m !== null);
  }

  /** A full order-book snapshot. */
  async orderbook(market: string | number | MarketConfig): Promise<OrderBook> {
    const config = resolveMarket(market);
    const raw = await this.#http.get<{
      bids: Array<{ price: string; size: string }>;
      asks: Array<{ price: string; size: string }>;
      timestamp: number;
    }>(`/api/markets/${config.marketId}/orderbook`);

    // Already human units on this route.
    const bids = raw.bids ?? [];
    const asks = raw.asks ?? [];
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;

    // Computed in fixed point: a mid of two 1e18 prices must not go through a
    // float, and the crossed check has to be exact to be worth anything.
    let mid: string | null = null;
    let spread: string | null = null;
    let crossed = false;
    if (bestBid !== null && bestAsk !== null) {
      const bidWire = priceToWire(bestBid);
      const askWire = priceToWire(bestAsk);
      mid = priceFromWire((bidWire + askWire) / 2n, config.priceDecimals);
      spread = priceFromWire(askWire - bidWire, config.priceDecimals);
      crossed = bidWire >= askWire;
    }

    return {
      marketId: config.marketId,
      bids,
      asks,
      timestamp: raw.timestamp,
      bestBid,
      bestAsk,
      mid,
      spread,
      crossed,
    };
  }

  /** Recent public trades, newest first. */
  async trades(
    market: string | number | MarketConfig,
    limit = 50,
  ): Promise<Trade[]> {
    const config = resolveMarket(market);
    return (
      (await this.#http.get<Trade[]>(`/api/markets/${config.marketId}/trades`, {
        limit,
      })) ?? []
    );
  }

  // ── Account ──────────────────────────────────────────────────────────────

  /**
   * This account's recent fills.
   *
   * Kryon has no private stream, so this is how a bot learns it was filled.
   */
  async fills(options?: {
    address?: string;
    limit?: number;
    /** Only fills after this unix-ms timestamp. Default: last 24h. */
    since?: number;
  }): Promise<Fill[]> {
    const address = options?.address ?? this.address;
    return (
      (await this.#http.get<Fill[]>("/api/fills", {
        address,
        limit: options?.limit ?? 20,
        since: options?.since,
      })) ?? []
    );
  }

  // ── Trading ──────────────────────────────────────────────────────────────

  /**
   * Sign and submit an order.
   *
   * The order is validated locally first — unknown market, non-positive size,
   * out-of-range TTL — because every one of those would otherwise cost one of
   * the 30 order slots per minute to learn from the venue.
   *
   * Returns once the venue has accepted the intent. Acceptance means the order
   * is in the book, NOT that it has traded: matching and on-chain settlement
   * happen asynchronously. Watch `fills()` for execution.
   */
  async placeOrder(params: PlaceOrderParams): Promise<PlacedOrder> {
    const signer = this.#requireSigner();
    const config = this.#resolveMarket(params.market);
    const owner = signer.publicKey();

    const sizeWire = sizeToWire(params.size);
    if (sizeWire <= 0n) {
      throw new PreflightError(`size must be positive, got ${params.size}`);
    }

    let priceWire = params.price === undefined ? 0n : priceToWire(params.price);
    if (priceWire < 0n) {
      throw new PreflightError(`price must not be negative, got ${params.price}`);
    }
    if (priceWire > 0n && (params.roundPrice ?? true)) {
      const tick = config.tickSizes[0];
      if (tick !== undefined) priceWire = roundToTick(priceWire, tick);
      if (priceWire <= 0n) {
        throw new PreflightError(
          `price ${params.price} rounds to zero at this market's tick size (${config.tickSizes[0]})`,
        );
      }
    }

    const ttl = params.ttlSeconds ?? 300;
    if (ttl <= 5) {
      throw new PreflightError(
        `ttlSeconds must exceed 5; the venue rejects orders expiring sooner`,
      );
    }
    if (ttl > 7 * 24 * 3600) {
      throw new PreflightError(`ttlSeconds must not exceed 7 days`);
    }

    const intent: OrderIntentWire = {
      owner,
      market_id: config.marketId,
      is_long: params.side === "buy",
      size: sizeWire.toString(),
      limit_price: priceWire.toString(),
      reduce_only: params.reduceOnly ?? false,
      nonce: this.#nonces.next().toString(),
      expiry_ts: (Math.floor(Date.now() / 1000) + ttl).toString(),
    };

    const signed = await signOrderIntent(signer, this.network.passphrase, intent);

    // noRetry: a retry after an ambiguous timeout is safe here only because
    // the venue upserts on (owner, nonce) and the bytes are identical — but a
    // rejected signature must not be resent, and the HTTP layer cannot tell
    // those apart before it sees the status. Retrying is handled there for
    // 5xx/429 only, which is exactly the safe set.
    await this.#http.post<{ ok: true }>("/api/orders", signed);

    return {
      id: `${owner}:${intent.nonce}`,
      owner,
      marketId: config.marketId,
      isLong: intent.is_long,
      size: sizeFromWire(sizeWire, config.sizeDecimals),
      limitPrice: priceFromWire(priceWire, config.priceDecimals),
      reduceOnly: intent.reduce_only,
      nonce: BigInt(intent.nonce),
      expiryTs: BigInt(intent.expiry_ts),
      signedPayload: signed as unknown as Record<string, unknown>,
    };
  }

  /**
   * Cancel a resting order by its nonce.
   *
   * This is the off-chain cancel: it removes the order from the book
   * immediately and costs nothing. It does NOT write an on-chain tombstone, so
   * it relies on the matcher honouring it. For a cancel that holds even if the
   * matcher misbehaves, use the on-chain `cancel_order` gateway call.
   *
   * Idempotent — cancelling an already-cancelled or unknown nonce succeeds.
   */
  async cancelOrder(nonce: bigint | string): Promise<void> {
    const signer = this.#requireSigner();
    const signed = await signCancelIntent(signer, this.network.passphrase, nonce);
    await this.#http.post<{ ok: true }>("/api/orders/cancel", signed);
  }

  /**
   * Cancel many orders.
   *
   * The venue has no bulk-cancel route, so this issues one request per nonce,
   * serially, to stay inside the 60/min cancel budget. Failures are collected
   * rather than thrown, so one bad nonce cannot strand the rest — important
   * when this runs from a shutdown handler.
   *
   * @returns the nonces that could not be cancelled, with their errors.
   */
  async cancelOrders(
    nonces: Array<bigint | string>,
  ): Promise<Array<{ nonce: string; error: Error }>> {
    const failures: Array<{ nonce: string; error: Error }> = [];
    for (const nonce of nonces) {
      try {
        await this.cancelOrder(nonce);
      } catch (error) {
        failures.push({
          nonce: nonce.toString(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return failures;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** `resolveMarket`, but reported as a preflight failure like the rest. */
  #resolveMarket(market: string | number | MarketConfig): MarketConfig {
    try {
      return resolveMarket(market);
    } catch (error) {
      throw new PreflightError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #requireSigner(): KryonSigner {
    if (!this.#signer) {
      throw new PreflightError(
        "This client was created without a signer, so it can only read. " +
          "Pass `signer` to place or cancel orders.",
      );
    }
    return this.#signer;
  }
}

export type { AccountHealth, Fill, MarketState, OrderBook, PlacedOrder, Position, Trade, VenueStatus };
