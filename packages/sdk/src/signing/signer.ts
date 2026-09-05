/**
 * The signer abstraction.
 *
 * The app's own signing path is wired directly to Freighter
 * (`lib/stellar/invoke.ts` calls `freighterSignTx`), which is why none of it
 * can be reused headlessly. Everything in this SDK that needs a signature goes
 * through `KryonSigner` instead, so the same client code works from a bot with
 * a raw secret key, a browser with a wallet extension, or a service with keys
 * in a KMS it will never hand out.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { encodeSignature, sep53Digest } from "./sep53.js";

export interface KryonSigner {
  /** The Stellar G-address this signer signs for. */
  publicKey(): string;

  /**
   * Sign a canonical message under SEP-53.
   *
   * Implementations receive the raw canonical message, NOT a digest, because
   * wallet extensions apply the SEP-53 prefix themselves. Implementations that
   * hold a raw key must apply `sep53Digest` before signing.
   *
   * @returns the signature, base64-encoded.
   */
  signMessage(message: string): Promise<string>;

  /**
   * Sign a Soroban transaction envelope.
   *
   * Only needed for on-chain operations (deposit, withdraw, on-chain cancel).
   * A signer that only ever places orders may throw here.
   *
   * @param xdr Base64 transaction envelope XDR.
   * @param networkPassphrase The network the transaction is for.
   * @returns the signed envelope XDR, base64.
   */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}

/**
 * A signer backed by a raw Stellar secret key. The normal choice for a bot.
 *
 * The secret is held in a closure and is never stored as an enumerable
 * property, so it cannot leak through `JSON.stringify`, a structured logger,
 * or an error that serializes the signer.
 */
export class KeypairSigner implements KryonSigner {
  readonly #keypair: Keypair;

  /**
   * @param secret A Stellar secret seed (S...), or a `Keypair` that has one.
   */
  constructor(secret: string | Keypair) {
    this.#keypair =
      typeof secret === "string" ? Keypair.fromSecret(secret) : secret;
    if (!this.#keypair.canSign()) {
      throw new Error("KeypairSigner requires a keypair with a secret key");
    }
  }

  /** Generate a signer for a fresh random keypair. */
  static random(): KeypairSigner {
    return new KeypairSigner(Keypair.random());
  }

  publicKey(): string {
    return this.#keypair.publicKey();
  }

  async signMessage(message: string): Promise<string> {
    const digest = sep53Digest(message);
    return encodeSignature(new Uint8Array(this.#keypair.sign(Buffer.from(digest))));
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    // Imported lazily so the message-signing path does not pull in the
    // transaction machinery for bots that never touch the chain directly.
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(this.#keypair);
    return tx.toXDR();
  }

  /** Keeps the secret out of `console.log` and error dumps. */
  toJSON(): { type: string; publicKey: string } {
    return { type: "KeypairSigner", publicKey: this.publicKey() };
  }

  toString(): string {
    return `KeypairSigner(${this.publicKey()})`;
  }
}

/**
 * A signer that delegates to caller-supplied functions.
 *
 * Use this to bridge a wallet extension, a hardware wallet, a remote signing
 * service, or a KMS — anything where the SDK must never see the key material.
 */
export class CallbackSigner implements KryonSigner {
  readonly #address: string;
  readonly #signMessage: (message: string) => Promise<string>;
  readonly #signTransaction:
    | ((xdr: string, networkPassphrase: string) => Promise<string>)
    | undefined;

  constructor(opts: {
    publicKey: string;
    /** Must return a base64 or hex SEP-53 signature over `message`. */
    signMessage: (message: string) => Promise<string>;
    /** Optional; omit for a signer that only places and cancels orders. */
    signTransaction?: (xdr: string, networkPassphrase: string) => Promise<string>;
  }) {
    this.#address = opts.publicKey;
    this.#signMessage = opts.signMessage;
    this.#signTransaction = opts.signTransaction;
  }

  publicKey(): string {
    return this.#address;
  }

  signMessage(message: string): Promise<string> {
    return this.#signMessage(message);
  }

  signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    if (!this.#signTransaction) {
      throw new Error(
        "This CallbackSigner has no signTransaction implementation; " +
          "on-chain operations are unavailable.",
      );
    }
    return this.#signTransaction(xdr, networkPassphrase);
  }
}
