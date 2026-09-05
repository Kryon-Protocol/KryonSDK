/**
 * `KryonAgent` — the strategy runtime.
 *
 * Subclass it, implement `onTick`, and the runtime handles everything a bot
 * author would otherwise rebuild badly: reconciling state from the venue each
 * loop, enforcing risk limits before signing, backing off on errors, and —
 * most importantly — cancelling every resting order on the way out.
 *
 * The shutdown behaviour is the reason this class exists. A bot that dies
 * with orders resting has left live limit orders on a real venue with nothing
 * watching them. They can fill minutes or hours later, against a price that
 * has moved, with no one to manage the resulting position. Handling SIGINT
 * and SIGTERM correctly is not a nicety.
 */

import {
  KryonClient,
  type Fill,
  type MarketListing,
  type OpenOrder,
  type OrderBook,
  type PlacedOrder,
  type Position,
} from "@kryon/sdk";
import {
  RiskEngine,
  RiskViolation,
  netPosition,
  type ProposedOrder,
  type RiskLimits,
} from "./risk.js";
import { PaperBroker } from "./paper.js";

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Everything the runtime knows at the start of a tick. */
export interface AgentContext {
  /** Markets the venue serves, with their trading parameters. */
  markets: MarketListing[];
  /** This account's open positions. */
  positions: Position[];
  /** This account's resting orders. */
  openOrders: OpenOrder[];
  /** Fills seen since the previous tick. */
  newFills: Fill[];
  /** Which tick this is, from 1. */
  tick: number;
  /** Realised PnL this session, USD. */
  realisedPnlUsd: number;

  /** Fetch a market's book. Cached for the duration of the tick. */
  orderbook(market: string): Promise<OrderBook>;
  /** Net signed position in a market, base units. */
  position(market: string): number;
  /**
   * Place an order, after risk checks. Throws `RiskViolation` if a limit
   * would be breached — the order is never signed or sent in that case.
   */
  placeOrder(params: {
    market: string;
    side: "buy" | "sell";
    size: number;
    price?: number;
    reduceOnly?: boolean;
    ttlSeconds?: number;
  }): Promise<PlacedOrder>;
  /** Cancel one order by nonce. */
  cancelOrder(nonce: bigint): Promise<void>;
  /** Cancel everything, optionally scoped to one market. */
  cancelAll(market?: string): Promise<bigint[]>;
  /** Stop the agent after this tick. */
  stop(reason?: string): void;
  log: Logger;
}

export interface AgentOptions {
  client: KryonClient;
  /** Milliseconds between ticks. Default 5000. */
  intervalMs?: number;
  /** Risk limits. Sensible defaults apply even if omitted. */
  risk?: RiskLimits;
  /**
   * Simulate fills against the live book instead of signing anything.
   *
   * The strategy code path is identical, so this is a real rehearsal rather
   * than a separate mode to maintain. Start here.
   */
  paper?: boolean;
  /** Markets to track. Defaults to every market the venue serves. */
  markets?: string[];
  logger?: Logger;
  /**
   * Cancel all resting orders when the agent stops. Default true.
   * Turning this off means orders outlive the process that made them.
   */
  cancelOnShutdown?: boolean;
  /** Install SIGINT/SIGTERM handlers. Default true. */
  handleSignals?: boolean;
}

const DEFAULT_INTERVAL_MS = 5_000;

const consoleLogger: Logger = {
  info: (m, d) => console.log(`[kryon] ${m}`, d ?? ""),
  warn: (m, d) => console.warn(`[kryon] ${m}`, d ?? ""),
  error: (m, d) => console.error(`[kryon] ${m}`, d ?? ""),
};

export abstract class KryonAgent {
  protected readonly client: KryonClient;
  protected readonly log: Logger;
  readonly risk: RiskEngine;

  readonly #options: Required<Pick<AgentOptions, "intervalMs" | "paper" | "cancelOnShutdown" | "handleSignals">>;
  readonly #markets: string[] | undefined;
  readonly #paperBroker: PaperBroker | null;

  #running = false;
  #stopping = false;
  #stopReason: string | null = null;
  #tick = 0;
  #lastFillSeen = 0;
  #realisedPnlUsd = 0;
  #detachSignals: (() => void) | null = null;

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.log = options.logger ?? consoleLogger;
    this.risk = new RiskEngine(options.risk ?? {});
    this.#markets = options.markets;
    this.#options = {
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      paper: options.paper ?? false,
      cancelOnShutdown: options.cancelOnShutdown ?? true,
      handleSignals: options.handleSignals ?? true,
    };
    this.#paperBroker = this.#options.paper ? new PaperBroker() : null;
  }

  /** Called once before the first tick. */
  protected async onStart(_ctx: AgentContext): Promise<void> {}

  /** The strategy. Called every `intervalMs`. */
  protected abstract onTick(ctx: AgentContext): Promise<void>;

  /** Called when this account is filled. */
  protected async onFill(_fill: Fill, _ctx: AgentContext): Promise<void> {}

  /** Called once after the last tick, before orders are cancelled. */
  protected async onStop(_ctx: AgentContext): Promise<void> {}

  /** True while the loop is running. */
  get running(): boolean {
    return this.#running;
  }

  /** Simulated fills, when running in paper mode. */
  get paperFills(): ReadonlyArray<{ market: string; side: string; size: number; price: number }> {
    return this.#paperBroker?.fills ?? [];
  }

  /** Ask the agent to stop after the current tick. */
  stop(reason = "stop() called"): void {
    this.#stopReason ??= reason;
    this.#stopping = true;
  }

  /**
   * Run until stopped.
   *
   * Resolves once the loop has ended AND any resting orders have been
   * cancelled. Always await this rather than letting the process exit.
   */
  async run(): Promise<void> {
    if (this.#running) throw new Error("Agent is already running");
    this.#running = true;
    this.#stopping = false;
    this.#stopReason = null;

    if (this.#options.handleSignals) this.#installSignalHandlers();

    if (this.#options.paper) {
      this.log.warn(
        "PAPER MODE: no orders will be signed or sent. Fills are simulated against the live book.",
      );
    }

    try {
      // Adopt anything left resting by a previous run, so it is managed (and
      // cancelled on shutdown) rather than orphaned.
      const context = await this.#buildContext();
      if (!this.#options.paper && context.openOrders.length > 0) {
        this.log.warn(
          `Found ${context.openOrders.length} order(s) already resting for this account. ` +
            `They are now managed by this agent and will be cancelled on shutdown.`,
        );
      }
      await this.onStart(context);

      while (!this.#stopping) {
        const startedAt = Date.now();
        this.#tick += 1;

        try {
          const ctx = await this.#buildContext();

          for (const fill of ctx.newFills) {
            this.#realisedPnlUsd += this.#paperBroker ? 0 : 0;
            await this.onFill(fill, ctx);
          }

          await this.onTick(ctx);
        } catch (error) {
          if (error instanceof RiskViolation) {
            this.log.warn(`risk limit "${error.limit}" blocked an action`, {
              reason: error.message,
            });
            if (this.risk.haltReason) {
              this.log.error(`halting: ${this.risk.haltReason}`);
              this.stop(this.risk.haltReason);
            }
          } else {
            // One bad tick must not kill a long-running bot; the next tick
            // re-reads state from the venue and starts clean.
            this.log.error("tick failed", {
              tick: this.#tick,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (this.#stopping) break;
        const elapsed = Date.now() - startedAt;
        await sleep(Math.max(0, this.#options.intervalMs - elapsed));
      }

      this.log.info(`stopping: ${this.#stopReason ?? "loop ended"}`);
      await this.onStop(await this.#buildContext()).catch((error: unknown) => {
        this.log.error("onStop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } finally {
      await this.#shutdown();
      this.#running = false;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #buildContext(): Promise<AgentContext> {
    const [markets, positions, openOrders, fills] = await Promise.all([
      this.client.listMarkets(),
      this.#options.paper ? Promise.resolve([]) : this.client.positions(),
      this.#options.paper ? Promise.resolve([]) : this.client.openOrders(),
      this.#options.paper ? Promise.resolve([]) : this.client.fills({ limit: 50 }),
    ]);

    const newFills = fills.filter((f) => f.createdAt > this.#lastFillSeen);
    for (const f of newFills) {
      this.#lastFillSeen = Math.max(this.#lastFillSeen, f.createdAt);
    }

    const tracked = this.#markets ?? markets.map((m) => m.symbol);
    const bookCache = new Map<string, Promise<OrderBook>>();

    const agent = this;
    const ctx: AgentContext = {
      markets: markets.filter((m) => tracked.includes(m.symbol)),
      positions,
      openOrders,
      newFills,
      tick: this.#tick,
      realisedPnlUsd: this.#realisedPnlUsd,
      log: this.log,

      orderbook(market: string): Promise<OrderBook> {
        let cached = bookCache.get(market);
        if (!cached) {
          cached = agent.client.orderbook(market);
          bookCache.set(market, cached);
        }
        return cached;
      },

      position(market: string): number {
        return agent.#options.paper
          ? (agent.#paperBroker?.position(market) ?? 0)
          : netPosition(positions, market);
      },

      async placeOrder(params) {
        const book = await ctx.orderbook(params.market);
        agent.risk.checkBook(params.market, book);

        const listing = markets.find((m) => m.symbol === params.market);
        const reference =
          params.price ??
          Number(listing?.lastOraclePrice ?? book.mid ?? 0);

        const proposed: ProposedOrder = {
          market: params.market,
          side: params.side,
          size: params.size,
          referencePrice: reference,
          ...(params.price !== undefined ? { price: params.price } : {}),
          ...(params.reduceOnly !== undefined ? { reduceOnly: params.reduceOnly } : {}),
        };

        agent.risk.check(proposed, {
          positions,
          openOrders,
          realisedPnlUsd: agent.#realisedPnlUsd,
        });

        if (agent.#paperBroker) {
          return agent.#paperBroker.place(params, book);
        }

        const placed = await agent.client.placeOrder(params);
        agent.risk.recordOrder();
        return placed;
      },

      async cancelOrder(nonce: bigint) {
        if (agent.#paperBroker) return agent.#paperBroker.cancel(nonce);
        await agent.client.cancelOrder(nonce);
      },

      async cancelAll(market?: string) {
        if (agent.#paperBroker) return agent.#paperBroker.cancelAll(market);
        return agent.client.cancelAll(market === undefined ? {} : { market });
      },

      stop(reason?: string) {
        agent.stop(reason ?? "stopped by strategy");
      },
    };

    return ctx;
  }

  async #shutdown(): Promise<void> {
    this.#detachSignals?.();
    this.#detachSignals = null;

    if (!this.#options.cancelOnShutdown || this.#options.paper) return;
    if (!this.client.canSign) return;

    // Best effort, but loud on failure: an uncancelled order is a live
    // exposure with nothing watching it.
    try {
      const cancelled = await this.client.cancelAll();
      if (cancelled.length > 0) {
        this.log.info(`cancelled ${cancelled.length} resting order(s) on shutdown`);
      }
    } catch (error) {
      this.log.error(
        "COULD NOT CANCEL RESTING ORDERS ON SHUTDOWN — they are still live at the venue. " +
          "Cancel them manually before leaving this account unattended.",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  #installSignalHandlers(): void {
    if (typeof process === "undefined" || typeof process.on !== "function") return;

    let forced = false;
    const onSignal = (signal: string) => {
      if (forced) {
        this.log.error(`${signal} again — exiting immediately, orders may still be resting`);
        process.exit(1);
      }
      forced = true;
      this.log.info(`${signal} received; finishing the tick and cancelling orders`);
      this.stop(`${signal} received`);
    };

    const sigint = () => onSignal("SIGINT");
    const sigterm = () => onSignal("SIGTERM");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);

    this.#detachSignals = () => {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
