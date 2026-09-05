/**
 * Soroban plumbing: reads by simulation, writes through a `KryonSigner`.
 *
 * The protocol's own version of this is wired directly to a browser wallet
 * (`lib/stellar/invoke.ts` calls `freighterSignTx`), which is the single
 * reason none of it can be reused headlessly. Here the signature comes from
 * the `KryonSigner` abstraction, so the same code serves a bot with a raw key,
 * a browser extension, or a remote KMS.
 */

import {
  Account,
  Contract,
  Keypair,
  TimeoutInfinite,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { KryonSigner } from "../signing/signer.js";
import { NetworkError } from "../util/errors.js";

/** Generous for Soroban; unused fee is refunded. */
const FEE = "2000000";
const POLL_INTERVAL_MS = 1_500;
const POLL_ATTEMPTS = 40;

export class SorobanClient {
  readonly #server: rpc.Server;
  readonly #passphrase: string;
  /** Synthetic source for read simulation; never needs to exist on chain. */
  readonly #simKeypair = Keypair.random();
  #simSequence = 100;

  constructor(rpcUrl: string, networkPassphrase: string) {
    this.#server = new rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
    this.#passphrase = networkPassphrase;
  }

  /**
   * Call a contract read-only, via simulation. No signature, no fee, no
   * on-chain effect — the source account need not even exist.
   *
   * @returns the return value, or null if the simulation failed.
   */
  async read(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<xdr.ScVal | null> {
    const account = new Account(
      this.#simKeypair.publicKey(),
      (this.#simSequence++).toString(),
    );
    const tx = new TransactionBuilder(account, {
      fee: FEE,
      networkPassphrase: this.#passphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(TimeoutInfinite)
      .build();

    const sim = await this.#server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return null;
    return (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval ?? null;
  }

  /**
   * Invoke a contract method that changes state, and wait for it to land.
   *
   * Simulates first so a call that cannot succeed fails here — with the
   * contract's own error — rather than costing a fee to discover on chain.
   */
  async invoke(
    signer: KryonSigner,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const source = signer.publicKey();
    const account = await this.#server.getAccount(source);

    const built = new TransactionBuilder(account, {
      fee: FEE,
      networkPassphrase: this.#passphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(120)
      .build();

    const sim = await this.#server.simulateTransaction(built);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${method} would fail: ${sim.error}`);
    }

    const prepared = rpc.assembleTransaction(built, sim).build();
    const signedXdr = await signer.signTransaction(prepared.toXDR(), this.#passphrase);
    const signed = TransactionBuilder.fromXDR(signedXdr, this.#passphrase);

    const sent = await this.#server.sendTransaction(signed);
    if (sent.status === "ERROR") {
      throw new NetworkError(
        `${method} was rejected: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`,
      );
    }

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      const result = await this.#server.getTransaction(sent.hash);
      if (result.status === "SUCCESS") {
        return result as rpc.Api.GetSuccessfulTransactionResponse;
      }
      if (result.status === "FAILED") {
        throw new Error(`${method} failed on chain: ${sent.hash}`);
      }
    }

    // Not necessarily a failure — it may still land. Say so, with the hash.
    throw new NetworkError(
      `${method} did not confirm within ${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s. ` +
        `It may still succeed; check transaction ${sent.hash}.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
