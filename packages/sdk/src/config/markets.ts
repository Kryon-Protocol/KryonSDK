/**
 * The market registry.
 *
 * Kryon has no `GET /api/markets` endpoint yet, so these values are baked in,
 * mirroring `client/config/index.ts` in the protocol repo. They are all public
 * and change rarely (a new market is a deployment event), but they are NOT the
 * on-chain source of truth: margin parameters and open-interest caps are
 * enforced by the contracts, and this table only lets the SDK reject an
 * obviously-invalid order before it costs a rate-limit slot.
 *
 * `KryonClient` refreshes the mutable parts from `GET /api/markets/:id` and
 * will prefer a `GET /api/markets` listing as soon as the venue exposes one.
 */

/** Static, per-market parameters. */
export interface MarketConfig {
  /** The on-chain market id. This, not the symbol, goes on the wire. */
  marketId: number;
  /** Canonical symbol, always `<BASE>-PERP`. */
  symbol: string;
  baseAsset: string;
  /** Always USDC — the quote and settlement asset for every Kryon market. */
  quoteAsset: string;
  oracleSymbol: string;
  /** Maximum leverage in bps of 1e8. 100000 = 10x. */
  maxLeverageBps: number;
  /** Initial margin requirement in bps. 1000 = 10%. */
  initialMarginBps: number;
  /** Maintenance margin in bps; below this the position is liquidatable. */
  maintenanceMarginBps: number;
  liquidationFeeBps: number;
  /** Decimal places for displaying and rounding price. */
  priceDecimals: number;
  /** Decimal places for displaying and rounding size. */
  sizeDecimals: number;
  /** Order-book aggregation ladder, finest tick first. */
  tickSizes: number[];
  /** On-chain open-interest cap, in whole base units. */
  maxOpenInterestBase: number;
  /** The USD notional the base cap was sized against. Reference only. */
  maxOpenInterestUsd: number;
}

export const MARKET_LIST: readonly MarketConfig[] = [
  {
    marketId: 1,
    symbol: "XLM-PERP",
    baseAsset: "XLM",
    quoteAsset: "USDC",
    oracleSymbol: "XLM",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 4,
    sizeDecimals: 4,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
    maxOpenInterestBase: 1450000,
    maxOpenInterestUsd: 300000,
  },
  {
    marketId: 2,
    symbol: "BTC-PERP",
    baseAsset: "BTC",
    quoteAsset: "USDC",
    oracleSymbol: "BTC",
    maxLeverageBps: 500000,
    initialMarginBps: 200,
    maintenanceMarginBps: 100,
    liquidationFeeBps: 25,
    priceDecimals: 1,
    sizeDecimals: 4,
    tickSizes: [0.1, 1, 10, 100],
    maxOpenInterestBase: 25,
    maxOpenInterestUsd: 2000000,
  },
  {
    marketId: 3,
    symbol: "ETH-PERP",
    baseAsset: "ETH",
    quoteAsset: "USDC",
    oracleSymbol: "ETH",
    maxLeverageBps: 200000,
    initialMarginBps: 500,
    maintenanceMarginBps: 250,
    liquidationFeeBps: 35,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 10],
    maxOpenInterestBase: 400,
    maxOpenInterestUsd: 1000000,
  },
  {
    marketId: 4,
    symbol: "SOL-PERP",
    baseAsset: "SOL",
    quoteAsset: "USDC",
    oracleSymbol: "SOL",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 5000,
    maxOpenInterestUsd: 500000,
  },
  {
    marketId: 5,
    symbol: "XRP-PERP",
    baseAsset: "XRP",
    quoteAsset: "USDC",
    oracleSymbol: "XRP",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 4,
    sizeDecimals: 1,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
    maxOpenInterestBase: 325000,
    maxOpenInterestUsd: 500000,
  },
  {
    marketId: 6,
    symbol: "ADA-PERP",
    baseAsset: "ADA",
    quoteAsset: "USDC",
    oracleSymbol: "ADA",
    maxLeverageBps: 50000,
    initialMarginBps: 2000,
    maintenanceMarginBps: 1000,
    liquidationFeeBps: 50,
    priceDecimals: 4,
    sizeDecimals: 1,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
    maxOpenInterestBase: 850000,
    maxOpenInterestUsd: 200000,
  },
  {
    marketId: 7,
    symbol: "BNB-PERP",
    baseAsset: "BNB",
    quoteAsset: "USDC",
    oracleSymbol: "BNB",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 425,
    maxOpenInterestUsd: 300000,
  },
  {
    marketId: 8,
    symbol: "TRX-PERP",
    baseAsset: "TRX",
    quoteAsset: "USDC",
    oracleSymbol: "TRX",
    maxLeverageBps: 50000,
    initialMarginBps: 2000,
    maintenanceMarginBps: 1000,
    liquidationFeeBps: 50,
    priceDecimals: 5,
    sizeDecimals: 0,
    tickSizes: [1e-05, 0.0001, 0.001, 0.01],
    maxOpenInterestBase: 575000,
    maxOpenInterestUsd: 200000,
  },
];

/** Markets by symbol, e.g. `MARKETS["BTC-PERP"]`. */
export const MARKETS: Readonly<Record<string, MarketConfig>> = Object.freeze(
  Object.fromEntries(MARKET_LIST.map((m) => [m.symbol, m])),
);

/** Markets by on-chain id. */
export const MARKETS_BY_ID: ReadonlyMap<number, MarketConfig> = new Map(
  MARKET_LIST.map((m) => [m.marketId, m]),
);

/**
 * Resolve a market from a symbol (`"BTC-PERP"`, case-insensitive) or an id.
 *
 * @throws if the market is unknown, listing what is available — an unknown
 *   market would otherwise surface as an opaque `Unknown market_id` 400.
 */
export function resolveMarket(market: string | number | MarketConfig): MarketConfig {
  if (typeof market === "object") return market;

  const found =
    typeof market === "number"
      ? MARKETS_BY_ID.get(market)
      : MARKETS[market.toUpperCase()];

  if (!found) {
    throw new Error(
      `Unknown market ${JSON.stringify(market)}. Known markets: ` +
        MARKET_LIST.map((m) => m.symbol).join(", "),
    );
  }
  return found;
}
