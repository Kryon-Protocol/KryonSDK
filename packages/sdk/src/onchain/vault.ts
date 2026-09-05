/**
 * Vault and engine operations — collateral and positions, read and written
 * directly on chain rather than through the venue's API.
 *
 * This matters for a bot: the API's view of your position comes from an
 * indexer, which lags. The contract's view is authoritative. When the two
 * disagree, the contract is right.
 */

import { scValToNative } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "../config/networks.js";
import type { KryonSigner } from "../signing/signer.js";
import { AMOUNT_PRECISION, PRICE_PRECISION } from "../signing/canonical.js";
import { fromFixedPoint, toFixedPoint } from "../util/units.js";
import { PreflightError } from "../util/errors.js";
import type { AccountHealth, Position } from "../client/types.js";
import { SorobanClient } from "./soroban.js";
import { addressToScVal, i128ToScVal, scValToI128, u32ToScVal } from "./scval.js";

export class OnChain {
  readonly #soroban: SorobanClient;
  readonly #network: NetworkConfig;

  constructor(network: NetworkConfig, rpcUrl?: string) {
    this.#network = network;
    this.#soroban = new SorobanClient(rpcUrl ?? network.rpcUrl, network.passphrase);
  }

  /**
   * Collateral deposited in the vault, in human USDC.
   *
   * This is margin, not your wallet balance — see `walletBalance`.
   */
  async vaultBalance(address: string, asset?: string): Promise<string> {
    const value = await this.#soroban.read(this.#network.contracts.vault, "balance_of", [
      addressToScVal(address),
      addressToScVal(asset ?? this.#network.assets.usdc),
    ]);
    return fromFixedPoint(value ? scValToI128(value) : 0n, AMOUNT_PRECISION);
  }

  /** USDC held in the account itself, not yet deposited as margin. */
  async walletBalance(address: string, asset?: string): Promise<string> {
    const value = await this.#soroban.read(
      asset ?? this.#network.assets.usdc,
      "balance",
      [addressToScVal(address)],
    );
    return fromFixedPoint(value ? scValToI128(value) : 0n, AMOUNT_PRECISION);
  }

  /**
   * Margin state, straight from the vault contract.
   *
   * `liquidatable` is the field to watch. Do not infer it from PnL.
   */
  async accountHealth(address: string, asset?: string): Promise<AccountHealth | null> {
    const value = await this.#soroban.read(
      this.#network.contracts.vault,
      "account_health",
      [addressToScVal(address), addressToScVal(asset ?? this.#network.assets.usdc)],
    );
    if (!value) return null;

    const raw = scValToNative(value) as Record<string, unknown>;
    const amount = (key: string): string =>
      fromFixedPoint(BigInt(String(raw[key] ?? "0")), AMOUNT_PRECISION);

    return {
      collateralValue: amount("collateral_value"),
      unrealizedPnl: amount("unrealized_pnl"),
      equity: amount("equity"),
      initialMarginRequired: amount("initial_margin_required"),
      maintenanceMarginRequired: amount("maintenance_margin_required"),
      freeCollateral: amount("free_collateral"),
      marginRatio: fromFixedPoint(
        BigInt(String(raw["margin_ratio"] ?? "0")),
        PRICE_PRECISION,
      ),
      liquidatable: Boolean(raw["liquidatable"]),
    };
  }

  /** Open positions, from the engine contract. Authoritative. */
  async positions(address: string): Promise<Position[]> {
    const value = await this.#soroban.read(
      this.#network.contracts.engine,
      "positions",
      [addressToScVal(address)],
    );
    if (!value) return [];

    const raw = scValToNative(value) as Record<string, unknown>[];
    return raw.map((p) => ({
      marketId: Number(p["market_id"] ?? 0),
      isLong: Boolean(p["is_long"]),
      size: fromFixedPoint(BigInt(String(p["size"] ?? "0")), AMOUNT_PRECISION),
      entryPrice: fromFixedPoint(
        BigInt(String(p["entry_price"] ?? "0")),
        PRICE_PRECISION,
      ),
      margin: fromFixedPoint(BigInt(String(p["margin"] ?? "0")), AMOUNT_PRECISION),
      lastFundingIndex: fromFixedPoint(
        BigInt(String(p["last_funding_index"] ?? "0")),
        PRICE_PRECISION,
      ),
    }));
  }

  /**
   * Deposit collateral into the vault.
   *
   * Requires a USDC trustline on the account and USDC in it. Placing orders
   * does not need collateral, but settling a fill does — an unfunded account
   * can rest a book that will never trade.
   *
   * @param amount Human USDC, e.g. `50`.
   * @returns the settled transaction hash.
   */
  async deposit(
    signer: KryonSigner,
    amount: number | string,
    asset?: string,
  ): Promise<string> {
    const wire = toFixedPoint(amount, AMOUNT_PRECISION);
    if (wire <= 0n) {
      throw new PreflightError(`deposit amount must be positive, got ${amount}`);
    }

    const result = await this.#soroban.invoke(
      signer,
      this.#network.contracts.vault,
      "deposit",
      [
        addressToScVal(signer.publicKey()),
        addressToScVal(asset ?? this.#network.assets.usdc),
        i128ToScVal(wire),
      ],
    );
    return result.txHash;
  }

  /**
   * Withdraw collateral from the vault.
   *
   * The contract refuses this while the remaining collateral would not cover
   * your open positions, so it can fail for reasons that have nothing to do
   * with your balance.
   */
  async withdraw(
    signer: KryonSigner,
    amount: number | string,
    asset?: string,
  ): Promise<string> {
    const wire = toFixedPoint(amount, AMOUNT_PRECISION);
    if (wire <= 0n) {
      throw new PreflightError(`withdraw amount must be positive, got ${amount}`);
    }

    const result = await this.#soroban.invoke(
      signer,
      this.#network.contracts.vault,
      "withdraw",
      [
        addressToScVal(signer.publicKey()),
        addressToScVal(asset ?? this.#network.assets.usdc),
        i128ToScVal(wire),
      ],
    );
    return result.txHash;
  }

  /**
   * Cancel an order ON CHAIN, writing a tombstone the gateway itself honours.
   *
   * Slower and costs a fee, unlike the off-chain cancel. Reach for it when you
   * need a cancel that holds even if the matcher misbehaves.
   */
  async cancelOrderOnChain(
    signer: KryonSigner,
    nonce: bigint,
    expiryTs: bigint,
  ): Promise<string> {
    const { u64ToScVal } = await import("./scval.js");
    const result = await this.#soroban.invoke(
      signer,
      this.#network.contracts.orderGateway,
      "cancel_order",
      [addressToScVal(signer.publicKey()), u64ToScVal(nonce), u64ToScVal(expiryTs)],
    );
    return result.txHash;
  }

  /** How much of an order the gateway considers filled, in human units. */
  async filledAmount(address: string, nonce: bigint): Promise<string> {
    const { u64ToScVal } = await import("./scval.js");
    const value = await this.#soroban.read(
      this.#network.contracts.orderGateway,
      "filled",
      [addressToScVal(address), u64ToScVal(nonce)],
    );
    return fromFixedPoint(value ? scValToI128(value) : 0n, AMOUNT_PRECISION);
  }

  /** Open interest for a market, in human base units. */
  async openInterest(marketId: number): Promise<{ long: string; short: string }> {
    const [long, short] = await Promise.all([
      this.#soroban.read(this.#network.contracts.engine, "long_open_interest", [
        u32ToScVal(marketId),
      ]),
      this.#soroban.read(this.#network.contracts.engine, "short_open_interest", [
        u32ToScVal(marketId),
      ]),
    ]);
    return {
      long: fromFixedPoint(long ? scValToI128(long) : 0n, AMOUNT_PRECISION),
      short: fromFixedPoint(short ? scValToI128(short) : 0n, AMOUNT_PRECISION),
    };
  }
}
