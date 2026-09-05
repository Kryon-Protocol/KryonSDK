/**
 * Canonical message construction for Kryon signed intents.
 *
 * Kryon uses TWO different canonicalizations, and they are not
 * interchangeable. Getting this wrong is the single most common way an
 * integration fails, so both are spelled out here rather than unified:
 *
 *  1. `orderCanonicalMessage` — pipe-delimited. This is the ONLY form accepted
 *     for order placement. It must byte-match `verify_order_signature()` in
 *     `contracts/perp-order-gateway/src/lib.rs`, because the very same bytes
 *     are re-verified ON CHAIN during `settle_fill_signed`. A signature that
 *     the API accepts but the contract rejects produces an order that can be
 *     matched but never settled — the matcher then loops
 *     match -> simulate-fail -> rollback until the order expires.
 *
 *  2. `cancelCanonicalMessage` — newline-delimited `key=value`. Used only for
 *     off-chain cancels, which never touch the contract.
 *
 * Note the `domain` field means different things in the two forms, which is
 * deliberate and load-bearing:
 *   - order form:  domain = the Stellar NETWORK PASSPHRASE (what the gateway's
 *                  `set_domain` was configured with)
 *   - cancel form: domain = the literal string "kryon.perps", with the network
 *                  passphrase carried in a separate `network=` field.
 *
 * Both bind the signature to exactly one network, so a testnet-signed intent
 * can never be replayed against mainnet.
 *
 * This module is intentionally dependency-free and takes the passphrase as an
 * explicit argument. There is no "current network" default: defaulting it is
 * precisely how an intent gets signed for the wrong network.
 */

/** Literal app domain used by the cancel form. Not used by the order form. */
export const APP_DOMAIN = "kryon.perps";

/** Fixed-point scale for prices on the wire (1e18). */
export const PRICE_PRECISION = 10n ** 18n;

/** Fixed-point scale for sizes on the wire (1e7 — Stellar stroops). */
export const AMOUNT_PRECISION = 10n ** 7n;

/** Basis-point scale used by margin parameters. */
export const BPS_PRECISION = 10_000n;

/**
 * An order intent exactly as it goes on the wire: snake_case, all numeric
 * fields as decimal strings at their fixed-point scale.
 */
export interface OrderIntentWire {
  owner: string;
  market_id: number;
  is_long: boolean;
  /** Base-asset size at 1e7. */
  size: string;
  /** Limit price at 1e18. "0" means a market order. */
  limit_price: string;
  reduce_only: boolean;
  /** uint64 as a decimal string. Unique per account, not per market. */
  nonce: string;
  /** Unix seconds as a decimal string. */
  expiry_ts: string;
}

/** An order intent plus its signature — the `POST /api/orders` body. */
export interface SignedOrderIntent extends OrderIntentWire {
  /** 64-byte ed25519 signature, base64 or 128-char hex. */
  signature: string;
}

/** The `POST /api/orders/cancel` body. */
export interface SignedCancelIntent {
  owner: string;
  nonce: string;
  signature: string;
}

/**
 * Lowercase hex of the 32-byte ed25519 public key behind a Stellar G-address.
 *
 * Kept as a parameter to `orderCanonicalMessage` rather than derived inside it
 * so this module stays free of any Stellar dependency; `signing/keys.ts`
 * provides the derivation.
 */
export type PubkeyHex = string;

/**
 * The pipe-delimited canonical message for order placement.
 *
 * Layout (ASCII):
 *   <passphrase>|place_order|<pubkey_hex>|<market_id>|<is_long 0/1>|<size>|
 *   <limit_price>|<reduce_only 0/1>|<nonce>|<expiry_ts>
 *
 * @param networkPassphrase The Stellar network passphrase. This is the
 *   gateway's configured domain — NOT `APP_DOMAIN`.
 * @param pubkeyHex Lowercase hex of the owner's ed25519 public key.
 */
export function orderCanonicalMessage(
  networkPassphrase: string,
  pubkeyHex: PubkeyHex,
  o: OrderIntentWire,
): string {
  return [
    networkPassphrase,
    "place_order",
    pubkeyHex,
    o.market_id,
    o.is_long ? 1 : 0,
    o.size,
    o.limit_price,
    o.reduce_only ? 1 : 0,
    o.nonce,
    o.expiry_ts,
  ].join("|");
}

/**
 * The newline-delimited `key=value` canonical message for off-chain cancels.
 *
 * Layout:
 *   domain=kryon.perps\naction=cancel_order\nnetwork=<passphrase>\n
 *   owner=<G...>\nnonce=<n>
 */
export function cancelCanonicalMessage(
  networkPassphrase: string,
  owner: string,
  nonce: bigint | string,
): string {
  return [
    `domain=${APP_DOMAIN}`,
    "action=cancel_order",
    `network=${networkPassphrase}`,
    `owner=${owner}`,
    `nonce=${nonce.toString()}`,
  ].join("\n");
}

/**
 * The newline-delimited canonical message for a bulk cancel.
 *
 * A bulk cancel has no nonce to bind to, so a captured signature would cancel
 * every future order the account ever places. `issuedAt` bounds that: the
 * venue rejects a message whose timestamp is more than
 * `CANCEL_ALL_WINDOW_SECONDS` from its own clock.
 *
 * `marketId` is signed too, so a signature scoped to one market cannot be
 * replayed to wipe the account's entire book.
 *
 * @param marketId A market id, or the literal `"all"`.
 */
export function cancelAllCanonicalMessage(
  networkPassphrase: string,
  owner: string,
  marketId: number | "all",
  issuedAt: bigint | number | string,
): string {
  return [
    `domain=${APP_DOMAIN}`,
    "action=cancel_all",
    `network=${networkPassphrase}`,
    `owner=${owner}`,
    `market_id=${marketId}`,
    `issued_at=${issuedAt.toString()}`,
  ].join("\n");
}

/** How far from the venue's clock a bulk-cancel signature stays valid. */
export const CANCEL_ALL_WINDOW_SECONDS = 60;

/** The `POST /api/orders/cancel-all` body. */
export interface SignedCancelAllIntent {
  owner: string;
  market_id: number | "all";
  issued_at: string;
  signature: string;
}

const MAX_U64 = (1n << 64n) - 1n;

/** True when `n` fits the contract's uint64 ABI. */
export function isU64(n: bigint): boolean {
  return n >= 0n && n <= MAX_U64;
}
