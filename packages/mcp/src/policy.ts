/**
 * The safety policy for LLM-driven trading.
 *
 * An MCP tool call is a model deciding to spend money. The model is not
 * adversarial, but it is fallible in ways a program is not: it can
 * misread a price, repeat a call it already made, believe a crossed book is
 * an arbitrage, or be steered by text it read in a market description.
 *
 * So the rules here are enforced OUTSIDE the model's reach. They come from
 * environment configuration, never from tool arguments, and there is
 * deliberately no tool that changes them. A model cannot raise its own limits,
 * because a model that can raise its own limits does not have limits.
 *
 * The defaults are conservative on purpose. Someone wiring this up for the
 * first time should be safe before they are capable.
 */

import { isNetworkId, type NetworkId } from "@kryon/sdk";

export interface Policy {
  network: NetworkId;
  /** Mainnet requires opting in twice: the network AND this flag. */
  allowMainnet: boolean;
  /** Largest notional for a single order, USD. */
  maxOrderNotionalUsd: number;
  /** Largest cumulative notional this process may trade, USD. */
  maxSessionNotionalUsd: number;
  /** Most orders this process may place, ever. */
  maxOrdersPerSession: number;
  /** Refuse to trade a market whose book is crossed. */
  refuseCrossedBook: boolean;
  /** Require `confirm: true` on writes; a bare call returns a preview. */
  requireConfirm: boolean;
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

const DEFAULTS = {
  maxOrderNotionalUsd: 100,
  maxSessionNotionalUsd: 1_000,
  maxOrdersPerSession: 50,
} as const;

/**
 * Build the policy from the environment.
 *
 * Every value is read here and nowhere else, so there is exactly one place a
 * limit can come from.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): Policy {
  const requested = env["KRYON_NETWORK"] ?? "testnet";
  if (!isNetworkId(requested)) {
    throw new Error(`KRYON_NETWORK must be mainnet or testnet, got "${requested}"`);
  }

  const allowMainnet = env["KRYON_ALLOW_MAINNET"] === "true";
  if (requested === "mainnet" && !allowMainnet) {
    throw new Error(
      "Refusing to start on mainnet. Set KRYON_ALLOW_MAINNET=true as well as " +
        "KRYON_NETWORK=mainnet if you really intend to let a model trade real funds.",
    );
  }

  return {
    network: requested,
    allowMainnet,
    maxOrderNotionalUsd: positiveNumber(
      env["KRYON_MAX_ORDER_USD"],
      DEFAULTS.maxOrderNotionalUsd,
      "KRYON_MAX_ORDER_USD",
    ),
    maxSessionNotionalUsd: positiveNumber(
      env["KRYON_MAX_SESSION_USD"],
      DEFAULTS.maxSessionNotionalUsd,
      "KRYON_MAX_SESSION_USD",
    ),
    maxOrdersPerSession: positiveNumber(
      env["KRYON_MAX_ORDERS"],
      DEFAULTS.maxOrdersPerSession,
      "KRYON_MAX_ORDERS",
    ),
    refuseCrossedBook: env["KRYON_ALLOW_CROSSED_BOOK"] !== "true",
    requireConfirm: env["KRYON_REQUIRE_CONFIRM"] !== "false",
  };
}

/** Tracks what this process has already done, and enforces the ceilings. */
export class PolicyEnforcer {
  readonly policy: Policy;
  #ordersPlaced = 0;
  #notionalTraded = 0;
  readonly #audit: AuditEntry[] = [];

  constructor(policy: Policy) {
    this.policy = policy;
  }

  get ordersPlaced(): number {
    return this.#ordersPlaced;
  }

  get notionalTraded(): number {
    return this.#notionalTraded;
  }

  /** Every tool call that touched the venue, for after-the-fact review. */
  get audit(): ReadonlyArray<AuditEntry> {
    return this.#audit;
  }

  /**
   * Check an order against the policy. Throws rather than returning a flag, so
   * a caller cannot forget to look.
   */
  checkOrder(notionalUsd: number): void {
    if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
      throw new PolicyViolation(`could not compute a notional for this order`);
    }
    if (notionalUsd > this.policy.maxOrderNotionalUsd) {
      throw new PolicyViolation(
        `That order is ${notionalUsd.toFixed(2)} USD, over the ` +
          `${this.policy.maxOrderNotionalUsd} USD per-order limit set by this server. ` +
          `The limit is configured outside this tool and cannot be changed from here.`,
      );
    }
    if (this.#ordersPlaced >= this.policy.maxOrdersPerSession) {
      throw new PolicyViolation(
        `This session has already placed ${this.#ordersPlaced} orders, its limit. ` +
          `Restart the server to trade more.`,
      );
    }
    if (this.#notionalTraded + notionalUsd > this.policy.maxSessionNotionalUsd) {
      throw new PolicyViolation(
        `That order would take this session to ` +
          `${(this.#notionalTraded + notionalUsd).toFixed(2)} USD traded, over its ` +
          `${this.policy.maxSessionNotionalUsd} USD limit.`,
      );
    }
  }

  recordOrder(notionalUsd: number): void {
    this.#ordersPlaced += 1;
    this.#notionalTraded += notionalUsd;
  }

  record(entry: Omit<AuditEntry, "at">): void {
    this.#audit.push({ ...entry, at: new Date().toISOString() });
  }
}

export interface AuditEntry {
  at: string;
  tool: string;
  arguments: Record<string, unknown>;
  outcome: "preview" | "executed" | "refused";
  detail?: string;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}
