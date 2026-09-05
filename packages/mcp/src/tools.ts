/**
 * The Kryon tool set, defined once and shared by the MCP server and the
 * plain Anthropic/OpenAI tool-schema exports.
 *
 * Read tools are free. Write tools go through `PolicyEnforcer` and, unless
 * the server was configured otherwise, return a PREVIEW rather than acting
 * until they are called again with `confirm: true`. That two-step is the main
 * defence: it turns "the model placed an order" into "the model proposed an
 * order and then confirmed it", which a human reading the transcript can
 * actually audit.
 */

import { z } from "zod";
import type { KryonClient } from "@kryon/sdk";
import { PolicyViolation, type PolicyEnforcer } from "./policy.js";

export interface ToolContext {
  client: KryonClient;
  enforcer: PolicyEnforcer;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** True for anything that signs or spends. */
  mutating: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const marketArg = z.string().describe('Market symbol, e.g. "BTC-PERP".');

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_markets",
    description:
      "List every market this Kryon venue actually serves, with its oracle price, " +
      "tick size, leverage and margin requirements. Call this first: the venue may " +
      "list fewer markets than its documentation suggests.",
    schema: z.object({}),
    mutating: false,
    async run(_args, { client }) {
      const markets = await client.listMarkets();
      if (markets.length === 0) return "This venue is serving no markets right now.";
      return markets
        .map(
          (m) =>
            `${m.symbol} (id ${m.marketId})${m.active ? "" : " [INACTIVE]"}\n` +
            `  oracle price ${m.lastOraclePrice}, last traded ${m.lastPrice}\n` +
            `  tick ${m.tickSizes?.[0] ?? "?"}, max leverage ${(m.maxLeverageBps ?? 0) / 10000}x, ` +
            `initial margin ${(m.initialMarginBps ?? 0) / 100}%\n` +
            `  open interest ${m.longOpenInterest} long / ${m.shortOpenInterest} short`,
        )
        .join("\n\n");
    },
  },

  {
    name: "get_orderbook",
    description:
      "Get the order book for a market, with best bid, best ask, mid and spread. " +
      "ALWAYS check the 'crossed' field before using these prices for anything: a " +
      "crossed book means the apparent spread cannot actually be traded.",
    schema: z.object({ market: marketArg, depth: z.number().int().min(1).max(50).optional() }),
    mutating: false,
    async run(args, { client }) {
      const depth = (args["depth"] as number | undefined) ?? 10;
      const book = await client.orderbook(args["market"] as string);

      const warning = book.crossed
        ? `\nWARNING: this book is ${book.locked ? "LOCKED (best bid equals best ask)" : "CROSSED (best bid is above best ask)"}. ` +
          "Those orders should have matched and did not, usually because their owner " +
          "cannot settle them. This is NOT an arbitrage opportunity; the spread is not " +
          "takeable. Do not trade against it.\n"
        : "";

      const side = (levels: Array<{ price: string; size: string }>) =>
        levels.slice(0, depth).map((l) => `    ${l.price} x ${l.size}`).join("\n") || "    (empty)";

      return (
        `${args["market"]} order book${warning}\n` +
        `  best bid ${book.bestBid ?? "none"} / best ask ${book.bestAsk ?? "none"}\n` +
        `  mid ${book.mid ?? "n/a"}, spread ${book.spread ?? "n/a"}\n` +
        `  bids:\n${side(book.bids)}\n  asks:\n${side(book.asks)}`
      );
    },
  },

  {
    name: "get_positions",
    description: "Get the open positions for the account this server is signing for.",
    schema: z.object({}),
    mutating: false,
    async run(_args, { client }) {
      const positions = await client.positions();
      if (positions.length === 0) return "No open positions.";
      return positions
        .map(
          (p) =>
            `market ${p.marketId}: ${p.isLong ? "LONG" : "SHORT"} ${p.size} ` +
            `@ entry ${p.entryPrice}, margin ${p.margin}`,
        )
        .join("\n");
    },
  },

  {
    name: "get_account_health",
    description:
      "Get margin health: collateral, equity, free collateral, margin ratio, and " +
      "whether the account can currently be liquidated. Check this before opening " +
      "a position, not after.",
    schema: z.object({}),
    mutating: false,
    async run(_args, { client }) {
      const [health, vault, wallet] = await Promise.all([
        client.accountHealth(),
        client.vaultBalance(),
        client.walletBalance(),
      ]);
      if (!health) {
        return (
          `Vault (margin) balance: ${vault} USDC\nWallet balance: ${wallet} USDC\n` +
          `No margin account exists yet. Orders can be placed without collateral, but ` +
          `a fill can never settle until USDC is deposited into the vault.`
        );
      }
      return (
        `Vault (margin): ${vault} USDC, wallet: ${wallet} USDC\n` +
        `equity ${health.equity}, free collateral ${health.freeCollateral}\n` +
        `initial margin required ${health.initialMarginRequired}, ` +
        `maintenance ${health.maintenanceMarginRequired}\n` +
        `margin ratio ${health.marginRatio}` +
        (health.liquidatable ? "\nLIQUIDATABLE RIGHT NOW — reduce risk immediately." : "")
      );
    },
  },

  {
    name: "get_open_orders",
    description: "List this account's resting orders, with the nonce needed to cancel each.",
    schema: z.object({ market: marketArg.optional() }),
    mutating: false,
    async run(args, { client }) {
      const market = args["market"] as string | undefined;
      const orders = await client.openOrders(market ? { market } : {});
      if (orders.length === 0) return "No resting orders.";
      return orders
        .map(
          (o) =>
            `nonce ${o.nonce}: ${o.isLong ? "BUY " : "SELL"} ${o.remainingSize} ` +
            `of ${o.size} @ ${o.limitPrice} (market ${o.marketId})`,
        )
        .join("\n");
    },
  },

  {
    name: "place_order",
    description:
      "Place a limit or market order. Called without confirm:true this returns a " +
      "PREVIEW showing the notional and resulting exposure, and places nothing — " +
      "read the preview, then call again with confirm:true to actually trade. " +
      "Order size is in base units (0.01 means 0.01 BTC on BTC-PERP), and price is " +
      "a normal decimal, not a scaled integer.",
    schema: z.object({
      market: marketArg,
      side: z.enum(["buy", "sell"]),
      size: z.number().positive().describe("Size in base units, e.g. 0.01 BTC."),
      price: z
        .number()
        .positive()
        .optional()
        .describe("Limit price. Omit for a market order that takes the book."),
      reduce_only: z.boolean().optional(),
      ttl_seconds: z.number().int().min(6).max(604800).optional(),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to actually place. Without it you get a preview."),
    }),
    mutating: true,
    async run(args, { client, enforcer }) {
      const market = args["market"] as string;
      const side = args["side"] as "buy" | "sell";
      const size = args["size"] as number;
      const price = args["price"] as number | undefined;
      const confirm = args["confirm"] === true;

      const book = await client.orderbook(market);
      if (enforcer.policy.refuseCrossedBook && book.crossed) {
        throw new PolicyViolation(
          `${market}'s book is ${book.locked ? "locked" : "crossed"} ` +
            `(bid ${book.bestBid} ${book.locked ? "==" : ">"} ask ${book.bestAsk}), so its ` +
            `spread cannot actually be traded. This server refuses to trade such a book. ` +
            `Set KRYON_ALLOW_CROSSED_BOOK=true to override, but understand that these ` +
            `levels are resting precisely because they cannot be filled.`,
        );
      }

      // Price the order for the limit checks. A market order is valued at the
      // far touch, which is the worst it could plausibly fill at.
      const reference =
        price ??
        Number(side === "buy" ? book.bestAsk : book.bestBid) ??
        Number(book.mid);
      if (!Number.isFinite(reference) || reference <= 0) {
        throw new PolicyViolation(
          `Cannot price a ${side} on ${market}: the book has no ${side === "buy" ? "asks" : "bids"} ` +
            `and no usable mid. Refusing to send an order whose cost is unknown.`,
        );
      }

      const notional = size * reference;
      enforcer.checkOrder(notional);

      const positionBefore = (await client.positions())
        .filter((p) => p.marketId === book.marketId)
        .reduce((sum, p) => sum + (p.isLong ? 1 : -1) * Number(p.size), 0);
      const positionAfter = positionBefore + (side === "buy" ? size : -size);

      if (!confirm && enforcer.policy.requireConfirm) {
        enforcer.record({
          tool: "place_order",
          arguments: args,
          outcome: "preview",
        });
        return (
          `PREVIEW — nothing has been placed.\n\n` +
          `  ${side.toUpperCase()} ${size} ${market} ` +
          `${price === undefined ? "at market" : `@ ${price}`}\n` +
          `  notional        ~${notional.toFixed(2)} USD (at ${reference})\n` +
          `  position now    ${positionBefore}\n` +
          `  position after  ${positionAfter}\n` +
          `  network         ${enforcer.policy.network.toUpperCase()}` +
          (enforcer.policy.network === "mainnet" ? "  — REAL FUNDS" : "") +
          `\n  session so far  ${enforcer.ordersPlaced} orders, ` +
          `${enforcer.notionalTraded.toFixed(2)} USD of ` +
          `${enforcer.policy.maxSessionNotionalUsd} USD allowed\n\n` +
          `To place it, call place_order again with the same arguments and confirm: true.`
        );
      }

      const order = await client.placeOrder({
        market,
        side,
        size,
        ...(price !== undefined ? { price } : {}),
        ...(args["reduce_only"] !== undefined
          ? { reduceOnly: args["reduce_only"] as boolean }
          : {}),
        ...(args["ttl_seconds"] !== undefined
          ? { ttlSeconds: args["ttl_seconds"] as number }
          : {}),
      });

      enforcer.recordOrder(notional);
      enforcer.record({
        tool: "place_order",
        arguments: args,
        outcome: "executed",
        detail: `nonce ${order.nonce}`,
      });

      return (
        `Placed: ${side.toUpperCase()} ${order.size} ${market} @ ${order.limitPrice}\n` +
        `  nonce ${order.nonce} (use this to cancel)\n` +
        `  expires ${new Date(Number(order.expiryTs) * 1000).toISOString()}\n\n` +
        `This means the order is RESTING in the book, not that it has traded. ` +
        `Matching and settlement happen asynchronously; check get_open_orders or ` +
        `get_positions to see what actually filled.`
      );
    },
  },

  {
    name: "cancel_order",
    description: "Cancel one resting order by its nonce. Idempotent.",
    schema: z.object({ nonce: z.string().describe("The order's nonce, as a string.") }),
    mutating: true,
    async run(args, { client, enforcer }) {
      const nonce = String(args["nonce"]);
      await client.cancelOrder(BigInt(nonce));
      enforcer.record({ tool: "cancel_order", arguments: args, outcome: "executed" });
      return `Cancelled order ${nonce}.`;
    },
  },

  {
    name: "cancel_all_orders",
    description:
      "Cancel every resting order, optionally for one market only. This is the " +
      "safe action — it reduces exposure — so it does not require confirmation.",
    schema: z.object({ market: marketArg.optional() }),
    mutating: true,
    async run(args, { client, enforcer }) {
      const market = args["market"] as string | undefined;
      const cancelled = await client.cancelAll(market ? { market } : {});
      enforcer.record({ tool: "cancel_all_orders", arguments: args, outcome: "executed" });
      return cancelled.length === 0
        ? "There were no resting orders to cancel."
        : `Cancelled ${cancelled.length} order(s): ${cancelled.join(", ")}.`;
    },
  },
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t]),
);
