/**
 * Nonce generation.
 *
 * Nonces are uint64 and unique PER ACCOUNT, not per market. The order's
 * primary key is `owner:nonce`, the gateway keys its `Filled` and `Cancelled`
 * ledger entries on `(owner, nonce)`, and `POST /api/orders` upserts with
 * `ON CONFLICT DO NOTHING`. Three consequences, all bad, if a nonce repeats:
 *
 *  - The API returns `{ok: true}` for an order it did not store. The bot
 *    believes it has a resting order that does not exist.
 *  - A cancel for that nonce cancels the OTHER order.
 *  - On chain, fills against the reused nonce accumulate into one `Filled`
 *    entry, so the overfill check protects the wrong quantity.
 *
 * The scheme below is the one the protocol's own keepers use: microsecond-ish
 * resolution from the wall clock, with a monotonic clamp so a backwards clock
 * step (NTP correction, VM migration, DST on a misconfigured host) cannot
 * reissue a nonce. That gives 1000 nonces per millisecond.
 *
 * The clamp only protects a single process's lifetime. A bot that restarts
 * within the same millisecond, or runs two processes on one account, needs a
 * `PersistentNonceSource` — see below.
 */

export interface NonceSource {
  /** Return the next unused nonce for this account. */
  next(): bigint;
}

/**
 * In-memory monotonic nonces. Correct for a single long-lived process.
 *
 * This matches `nextOrderNonce()` in the Kryon app.
 */
export class MonotonicNonceSource implements NonceSource {
  #counter = 0;
  #last = 0n;

  next(): bigint {
    const candidate = BigInt(Date.now()) * 1000n + BigInt(this.#counter % 1000);
    this.#counter += 1;
    // Never go backwards, whatever the clock does.
    const nonce = candidate > this.#last ? candidate : this.#last + 1n;
    this.#last = nonce;
    return nonce;
  }

  /**
   * Raise the floor to a known-used nonce. Call this after recovering live
   * orders at startup so a restart cannot replay a nonce the venue has seen.
   */
  observe(used: bigint): void {
    if (used > this.#last) this.#last = used;
  }
}

/**
 * Monotonic nonces with a high-water mark persisted through a caller-supplied
 * store, so a restart — even an immediate one — cannot reissue a nonce.
 *
 * The mark is advanced in a coarse stride rather than on every order, so the
 * hot path does not pay a write per order. On restart the SDK resumes from the
 * last persisted mark, which is always >= any nonce actually issued.
 *
 * @example
 * ```ts
 * const source = new PersistentNonceSource({
 *   load: () => Number(fs.readFileSync(".nonce", "utf8")),
 *   save: (n) => fs.writeFileSync(".nonce", String(n)),
 * });
 * ```
 */
export class PersistentNonceSource implements NonceSource {
  readonly #save: (mark: bigint) => void;
  readonly #stride: bigint;
  #last: bigint;
  #mark: bigint;
  #counter = 0;

  constructor(opts: {
    /** Return the persisted high-water mark, or 0/undefined if none. */
    load: () => bigint | number | undefined;
    /** Persist a new high-water mark. Must be durable before it returns. */
    save: (mark: bigint) => void;
    /**
     * How far ahead to reserve on each persist. Larger means fewer writes and
     * a bigger gap after a crash; nonces need not be dense, so this is free.
     * Default 10_000 (≈10ms of nonce space).
     */
    stride?: bigint | number;
  }) {
    this.#save = opts.save;
    this.#stride = BigInt(opts.stride ?? 10_000);
    const loaded = opts.load();
    this.#last = BigInt(loaded ?? 0);
    this.#mark = this.#last;
  }

  next(): bigint {
    const candidate = BigInt(Date.now()) * 1000n + BigInt(this.#counter % 1000);
    this.#counter += 1;
    const nonce = candidate > this.#last ? candidate : this.#last + 1n;
    this.#last = nonce;

    if (nonce >= this.#mark) {
      this.#mark = nonce + this.#stride;
      this.#save(this.#mark);
    }
    return nonce;
  }
}
