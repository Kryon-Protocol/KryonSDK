/**
 * Signing an intent end to end: canonical message -> SEP-53 -> wire payload.
 *
 * These are the two functions a bot author actually calls if they are building
 * request bodies by hand rather than using `KryonClient`.
 */

import {
  cancelCanonicalMessage,
  isU64,
  orderCanonicalMessage,
  type OrderIntentWire,
  type SignedCancelIntent,
  type SignedOrderIntent,
} from "./canonical.js";
import { pubkeyHexFromAddress } from "./sep53.js";
import type { KryonSigner } from "./signer.js";
import { verifySignedMessage } from "./verify.js";

/**
 * Sign an order intent, producing the exact `POST /api/orders` body.
 *
 * The result is verified locally before it is returned. That costs one
 * ed25519 verify (~50µs) and catches a whole class of integration failure —
 * a wallet that applied the wrong envelope, a signer for the wrong key — at
 * the point of signing rather than as an opaque 400, or worse as an order that
 * is accepted and then silently cancelled by the matcher's pre-match
 * signature re-check.
 *
 * @param signer Signs for `intent.owner`.
 * @param networkPassphrase The network this intent is for. Binds the
 *   signature to one network; there is deliberately no default.
 */
export async function signOrderIntent(
  signer: KryonSigner,
  networkPassphrase: string,
  intent: OrderIntentWire,
): Promise<SignedOrderIntent> {
  if (intent.owner !== signer.publicKey()) {
    throw new Error(
      `Signer ${signer.publicKey()} cannot sign an intent owned by ${intent.owner}`,
    );
  }
  if (!isU64(BigInt(intent.nonce))) {
    throw new Error(`nonce ${intent.nonce} is not a uint64`);
  }
  if (!isU64(BigInt(intent.expiry_ts))) {
    throw new Error(`expiry_ts ${intent.expiry_ts} is not a uint64`);
  }

  const message = orderCanonicalMessage(
    networkPassphrase,
    pubkeyHexFromAddress(intent.owner),
    intent,
  );
  const signature = await signer.signMessage(message);

  if (!verifySignedMessage(intent.owner, message, signature)) {
    throw new Error(
      "Produced signature does not verify against the owner's public key. " +
        "The signer is either signing for a different key or not applying " +
        "the SEP-53 envelope (sha256('Stellar Signed Message:\\n' || message)).",
    );
  }

  return { ...intent, signature };
}

/**
 * Sign a cancel intent, producing the `POST /api/orders/cancel` body.
 *
 * Note this uses the newline `key=value` canonicalization, which is NOT the
 * form used for placement. See `canonical.ts`.
 */
export async function signCancelIntent(
  signer: KryonSigner,
  networkPassphrase: string,
  nonce: bigint | string,
): Promise<SignedCancelIntent> {
  const owner = signer.publicKey();
  const message = cancelCanonicalMessage(networkPassphrase, owner, nonce);
  const signature = await signer.signMessage(message);

  if (!verifySignedMessage(owner, message, signature)) {
    throw new Error(
      "Produced cancel signature does not verify against the owner's public key.",
    );
  }

  return { owner, nonce: nonce.toString(), signature };
}
