/**
 * `KryonClient` — the main entry point.
 *
 * Wraps the venue's REST API with typed results, human units, local
 * validation, and signing. A bot that only reads market data can construct one
 * without a signer; placing or cancelling orders requires one.
 */

import {
  MARKETS,
  MARKETS_BY_ID,
  getNetworkConfig,
  resolveMarket,
  type MarketConfig,
  type NetworkConfig,
  type NetworkId,
} from "../config/index.js";
import {
  signCancelAllIntent,
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
import { OnChain } from "../onchain/vault.js";
import { HttpClient } from "./http.js";
import type {
  AccountHealth,
  Fill,
  MarketListing,
  MarketState,
  OpenOrder,
  OrderBook,
  PlacedOrder,
  Position,
  Trade,
  VenueStatus,
  VenueTime,
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
  /** Override the Soroban RPC endpoint used for on-chain reads and writes. */
  rpcUrl?: string;
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
  /**
   * Orders this client has placed and not yet cancelled.
   *
   * Kept so the SDK still works against a venue that lacks
   * `/api/orders/list` and `/api/orders/cancel-all` — notably production,
   * where those routes are not deployed yet. It is a fallback, not a
   * replacement: it cannot see orders placed by a previous process, which is
   * exactly what restart recovery needs. `openOrders()` says so when it is
   * serving from here.
   */
  readonly #tracked = new Map<bigint, TrackedOrder>();
  readonly #warned = new Set<string>();
  #onchain: OnChain | undefined;
  readonly #rpcUrl: string | undefined;

  constructor(options: KryonClientOptions) {
    this.network = getNetworkConfig(options.network);
    this.#signer = options.signer;
    this.#nonces = options.nonceSource ?? new MonotonicNonceSource();
    this.#rpcUrl = options.rpcUrl;
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

  /**
   * The venue's clock, and this host's offset from it.
   *
   * Orders are rejected when `expiry_ts` is within 5 seconds of the VENUE's
   * clock, so a host running a few seconds fast has orders refused with an
   * error that never mentions time. Call this at startup: if `offsetMs` is
   * more than a second or two, fix the host clock rather than padding TTLs.
   */
  async time(): Promise<VenueTime> {
    const before = Date.now();
    let raw: {
      unix_ms: number;
      unix_seconds: number;
      iso: string;
      min_ttl_seconds: number;
      max_ttl_seconds: number;
    };
    try {
      raw = await this.#http.get<typeof raw>("/api/time");
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // No clock endpoint: report this host's clock with a zero offset, and
      // say so, since an unmeasurable offset is not the same as no offset.
      this.#warnOnce(
        "time",
        "This venue has no /api/time, so clock skew cannot be measured. " +
          "If orders are rejected as expiring too soon, check this host's clock.",
      );
      const now = Date.now();
      return {
        unixMs: now,
        unixSeconds: Math.floor(now / 1000),
        iso: new Date(now).toISOString(),
        minTtlSeconds: 5,
        maxTtlSeconds: 7 * 24 * 3600,
        offsetMs: 0,
        measured: false,
      };
    }
    const after = Date.now();

    // Compare against the midpoint of the request so network latency is not
    // counted as clock skew.
    const localAtVenue = (before + after) / 2;
    return {
      unixMs: raw.unix_ms,
      unixSeconds: raw.unix_seconds,
      iso: raw.iso,
      minTtlSeconds: raw.min_ttl_seconds,
      maxTtlSeconds: raw.max_ttl_seconds,
      offsetMs: Math.round(localAtVenue - raw.unix_ms),
      measured: true,
    };
  }

  /**
   * Every market the venue serves, with its trading parameters.
   *
   * Prefer this over `markets()`: it is one request rather than one per
   * market, and it carries the tick sizes and margin rules needed to size an
   * order. Falls back to per-market reads on a venue too old to have the
   * listing endpoint.
   */
  async listMarkets(): Promise<MarketListing[]> {
    let raw: {
      markets: Array<Record<string, unknown>>;
    };
    try {
      raw = await this.#http.get<{ markets: Array<Record<string, unknown>> }>(
        "/api/markets",
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Older venue: synthesise the listing from what we can reach.
      const states = await this.markets();
      return states.map((state) => {
        const config = MARKETS[state.symbol];
        return {
          ...state,
          baseAsset: config?.baseAsset ?? null,
          quoteAsset: config?.quoteAsset ?? null,
          priceDecimals: config?.priceDecimals ?? null,
          sizeDecimals: config?.sizeDecimals ?? null,
          tickSizes: config?.tickSizes ?? null,
          maxLeverageBps: config?.maxLeverageBps ?? null,
          initialMarginBps: config?.initialMarginBps ?? null,
          maintenanceMarginBps: config?.maintenanceMarginBps ?? null,
          liquidationFeeBps: config?.liquidationFeeBps ?? null,
          maxOpenInterestBase: config?.maxOpenInterestBase ?? null,
          updatedAt: Date.now(),
        };
      });
    }

    return raw.markets.map((m) => {
      const symbol = String(m["symbol"]);
      const priceDecimals =
        m["price_decimals"] === null ? null : Number(m["price_decimals"]);
      const sizeDecimals =
        m["size_decimals"] === null ? null : Number(m["size_decimals"]);

      return {
        marketId: Number(m["market_id"]),
        symbol,
        active: Boolean(m["active"]),
        lastPrice: priceFromWire(String(m["last_price"]), priceDecimals ?? undefined),
        volume: sizeFromWire(String(m["volume"]), sizeDecimals ?? undefined),
        longOpenInterest: sizeFromWire(
          String(m["long_open_interest"]),
          sizeDecimals ?? undefined,
        ),
        shortOpenInterest: sizeFromWire(
          String(m["short_open_interest"]),
          sizeDecimals ?? undefined,
        ),
        fundingLongIndex: priceFromWire(String(m["funding_long_index"])),
        fundingShortIndex: priceFromWire(String(m["funding_short_index"])),
        lastOraclePrice: priceFromWire(
          String(m["last_oracle_price"]),
          priceDecimals ?? undefined,
        ),
        baseAsset: (m["base_asset"] as string | null) ?? null,
        quoteAsset: (m["quote_asset"] as string | null) ?? null,
        priceDecimals,
        sizeDecimals,
        tickSizes: (m["tick_sizes"] as number[] | null) ?? null,
        maxLeverageBps:
          m["max_leverage_bps"] === null ? null : Number(m["max_leverage_bps"]),
        initialMarginBps:
          m["initial_margin_bps"] === null ? null : Number(m["initial_margin_bps"]),
        maintenanceMarginBps:
          m["maintenance_margin_bps"] === null
            ? null
            : Number(m["maintenance_margin_bps"]),
        liquidationFeeBps:
          m["liquidation_fee_bps"] === null ? null : Number(m["liquidation_fee_bps"]),
        maxOpenInterestBase:
          m["max_open_interest_base"] === null
            ? null
            : Number(m["max_open_interest_base"]),
        updatedAt: Number(m["updated_at"] ?? Date.now()),
      };
    });
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
    let locked = false;
    if (bestBid !== null && bestAsk !== null) {
      const bidWire = priceToWire(bestBid);
      const askWire = priceToWire(bestAsk);
      mid = priceFromWire((bidWire + askWire) / 2n, config.priceDecimals);
      spread = priceFromWire(askWire - bidWire, config.priceDecimals);
      locked = bidWire === askWire;
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
      locked,
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

  /**
   * This account's own orders.
   *
   * Call this on startup. A nonce otherwise exists only inside the process
   * that generated it, so a bot that restarts has no way to find what it left
   * resting, cannot cancel it, and cannot reconcile its exposure. Feed the
   * highest nonce back into a `MonotonicNonceSource.observe()` so a restart
   * cannot reissue one.
   *
   * @param options.status `"open"` (default) excludes cancelled, filled and
   *   expired orders; `"all"` returns everything, newest first.
   */
  async openOrders(options?: {
    address?: string;
    status?: "open" | "all";
    market?: string | number | MarketConfig;
    limit?: number;
  }): Promise<OpenOrder[]> {
    const address = options?.address ?? this.address;
    const marketId =
      options?.market === undefined
        ? undefined
        : this.#resolveMarket(options.market).marketId;

    let raw: { orders: Array<Record<string, unknown>> };
    try {
      raw = await this.#http.get<{ orders: Array<Record<string, unknown>> }>(
        "/api/orders/list",
        {
          address,
          status: options?.status ?? "open",
          market_id: marketId,
          limit: options?.limit ?? 100,
        },
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Venue has no listing route. Serve what this process placed, and be
      // explicit that it cannot cover a restart.
      this.#warnOnce(
        "openOrders",
        "This venue has no /api/orders/list, so open orders are being served " +
          "from this process's own memory. Orders placed by a previous run are " +
          "invisible, which means restart recovery does not work here.",
      );
      return this.#trackedAsOrders(marketId);
    }

    return (raw.orders ?? []).map((o) => {
      const config = MARKETS_BY_ID.get(Number(o["market_id"]));
      return {
        id: String(o["id"]),
        owner: String(o["owner"]),
        marketId: Number(o["market_id"]),
        isLong: Boolean(o["is_long"]),
        size: sizeFromWire(String(o["size"]), config?.sizeDecimals),
        limitPrice: priceFromWire(String(o["limit_price"]), config?.priceDecimals),
        filledSize: sizeFromWire(String(o["filled_size"]), config?.sizeDecimals),
        remainingSize: sizeFromWire(
          String(o["remaining_size"]),
          config?.sizeDecimals,
        ),
        reduceOnly: Boolean(o["reduce_only"]),
        nonce: BigInt(String(o["nonce"])),
        expiryTs: BigInt(String(o["expiry_ts"])),
        cancelled: Boolean(o["cancelled"]),
        expired: Boolean(o["expired"]),
        createdAt: Number(o["created_at"]),
        updatedAt: Number(o["updated_at"]),
      };
    });
  }

  /**
   * This account's open positions.
   *
   * A cheap read, safe to call on every loop — unlike the portfolio endpoint,
   * which builds an equity curve out of five tables.
   */
  async positions(options?: {
    address?: string;
    market?: string | number | MarketConfig;
  }): Promise<Position[]> {
    const address = options?.address ?? this.address;
    const marketId =
      options?.market === undefined
        ? undefined
        : this.#resolveMarket(options.market).marketId;

    let raw: { positions: Array<Record<string, unknown>> };
    try {
      raw = await this.#http.get<{ positions: Array<Record<string, unknown>> }>(
        "/api/positions",
        { address, market_id: marketId },
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Fall back to the analytics route, which also carries positions. It is
      // far heavier and rate-limited, so warn rather than do this silently.
      this.#warnOnce(
        "positions",
        "This venue has no /api/positions, so positions are coming from " +
          "/api/portfolio instead. That route joins several analytics tables " +
          "and is rate limited; avoid calling it on a tight loop.",
      );
      const portfolio = await this.#http.get<{
        positions?: Array<Record<string, unknown>>;
      }>(`/api/portfolio/${address}`);
      raw = { positions: portfolio.positions ?? [] };
    }

    return (raw.positions ?? []).map((p) => {
      const config = MARKETS_BY_ID.get(Number(p["market_id"]));
      return {
        marketId: Number(p["market_id"]),
        isLong: Boolean(p["is_long"]),
        size: sizeFromWire(String(p["size"]), config?.sizeDecimals),
        entryPrice: priceFromWire(String(p["entry_price"]), config?.priceDecimals),
        margin: sizeFromWire(String(p["margin"])),
        lastFundingIndex: priceFromWire(String(p["last_funding_index"])),
      };
    });
  }

  // ── On-chain: collateral and authoritative state ─────────────────────────

  /**
   * Direct contract access.
   *
   * The API's view of your position comes from an indexer and can lag; the
   * contract's view is authoritative. Use this when the two disagree, and for
   * anything involving collateral, which never goes through the API at all.
   */
  get onchain(): OnChain {
    this.#onchain ??= new OnChain(
      this.network,
      this.#rpcUrl ?? undefined,
    );
    return this.#onchain;
  }

  /**
   * Deposit USDC into the vault as margin.
   *
   * Placing orders needs no collateral — order intake only checks your
   * signature — but settling a fill does. An unfunded account can rest orders
   * that can never trade.
   *
   * Requires a USDC trustline and USDC in the account.
   *
   * @param amount Human USDC, e.g. `50`.
   * @returns the settled transaction hash.
   */
  async deposit(amount: number | string, asset?: string): Promise<string> {
    return this.onchain.deposit(this.#requireSigner(), amount, asset);
  }

  /**
   * Withdraw collateral from the vault.
   *
   * Refused by the contract while the remainder would not cover your open
   * positions, so this can fail for reasons unrelated to your balance.
   */
  async withdraw(amount: number | string, asset?: string): Promise<string> {
    return this.onchain.withdraw(this.#requireSigner(), amount, asset);
  }

  /**
   * Margin state from the vault contract.
   *
   * Watch `liquidatable` and `marginRatio` rather than inferring health from
   * PnL.
   */
  async accountHealth(address?: string): Promise<AccountHealth | null> {
    return this.onchain.accountHealth(address ?? this.address);
  }

  /** Collateral in the vault, human USDC. Not the same as wallet balance. */
  async vaultBalance(address?: string): Promise<string> {
    return this.onchain.vaultBalance(address ?? this.address);
  }

  /** USDC in the account itself, not yet deposited as margin. */
  async walletBalance(address?: string): Promise<string> {
    return this.onchain.walletBalance(address ?? this.address);
  }

  /**
   * Positions read from the engine contract rather than the indexer.
   *
   * Slower than `positions()` but authoritative.
   */
  async onchainPositions(address?: string): Promise<Position[]> {
    return this.onchain.positions(address ?? this.address);
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
    this.#tracked.set(BigInt(intent.nonce), {
      marketId: config.marketId,
      isLong: intent.is_long,
      size: sizeFromWire(sizeWire, config.sizeDecimals),
      limitPrice: priceFromWire(priceWire, config.priceDecimals),
      reduceOnly: intent.reduce_only,
      expiryTs: BigInt(intent.expiry_ts),
      placedAt: Date.now(),
    });

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
    this.#tracked.delete(BigInt(nonce));
  }

  /**
   * Cancel every resting order in one request — the kill switch.
   *
   * Prefer this to cancelling nonce by nonce when taking a bot flat: the
   * per-order route allows 60 a minute, so a book of any size can be rate
   * limited half way through and left partly live. One call cannot be.
   *
   * The signature is valid for about a minute, since it covers a timestamp
   * rather than a nonce. If this host's clock drifts, pass `issuedAt` from
   * `time()`.
   *
   * @param market Scope to one market, or omit for every market.
   * @returns the nonces that were cancelled.
   */
  async cancelAll(options?: {
    market?: string | number | MarketConfig;
    issuedAt?: number;
  }): Promise<bigint[]> {
    const signer = this.#requireSigner();
    const marketId =
      options?.market === undefined
        ? ("all" as const)
        : this.#resolveMarket(options.market).marketId;

    const signed = await signCancelAllIntent(
      signer,
      this.network.passphrase,
      marketId,
      options?.issuedAt ?? Math.floor(Date.now() / 1000),
    );

    try {
      const result = await this.#http.post<{
        ok: true;
        cancelled: number;
        nonces: string[];
      }>("/api/orders/cancel-all", signed);
      const cancelled = (result.nonces ?? []).map((n) => BigInt(n));
      for (const nonce of cancelled) this.#tracked.delete(nonce);
      return cancelled;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // No bulk route: cancel what this process knows about, one at a time.
      // Slower and bounded by the 60/min cancel budget, but it still takes
      // the bot flat, which is the point.
      this.#warnOnce(
        "cancelAll",
        "This venue has no /api/orders/cancel-all, so orders are being " +
          "cancelled one at a time from this process's own list. Orders placed " +
          "by a previous run will NOT be cancelled.",
      );
      const targets = [...this.#tracked.entries()]
        .filter(([, o]) => marketId === "all" || o.marketId === marketId)
        .map(([nonce]) => nonce);
      const failures = await this.cancelOrders(targets);
      const failed = new Set(failures.map((f) => f.nonce));
      return targets.filter((n) => !failed.has(n.toString()));
    }
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

  /**
   * Serve tracked orders when the venue cannot list them.
   *
   * The details are the ones we submitted, so side, size and price are real.
   * What this CANNOT know is how much has since been filled — only the venue
   * knows that — so `filledSize` is reported as 0 and `remainingSize` as the
   * full size. Treat those two as unknown rather than authoritative.
   */
  #trackedAsOrders(marketId: number | undefined): OpenOrder[] {
    const owner = this.#signer?.publicKey() ?? "";
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return [...this.#tracked.entries()]
      .filter(([, o]) => marketId === undefined || o.marketId === marketId)
      .map(([nonce, o]) => ({
        id: `${owner}:${nonce}`,
        owner,
        marketId: o.marketId,
        isLong: o.isLong,
        size: o.size,
        limitPrice: o.limitPrice,
        filledSize: "0",
        remainingSize: o.size,
        reduceOnly: o.reduceOnly,
        nonce,
        expiryTs: o.expiryTs,
        cancelled: false,
        expired: o.expiryTs <= nowSec,
        createdAt: o.placedAt,
        updatedAt: o.placedAt,
      }));
  }

  /** Warn about a missing venue capability once, not on every call. */
  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    console.warn(`[kryon] ${message}`);
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

/** What the client remembers about an order it placed. */
interface TrackedOrder {
  marketId: number;
  isLong: boolean;
  size: string;
  limitPrice: string;
  reduceOnly: boolean;
  expiryTs: bigint;
  placedAt: number;
}

export type {
  AccountHealth,
  Fill,
  MarketListing,
  MarketState,
  OpenOrder,
  OrderBook,
  PlacedOrder,
  Position,
  Trade,
  VenueStatus,
  VenueTime,
};
