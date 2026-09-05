/**
 * Signature verification.
 *
 * This mirrors the server's `verifySignedMessage` and the contract's
 * `verify_order_signature`. It exists in the SDK so a bot can check its own
 * signature locally BEFORE spending a rate-limit slot on an order the API
 * would reject — and so the conformance suite can assert the whole pipeline
 * without a network.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { decodeSignature, sep53Digest } from "./sep53.js";

/**
 * Verify a SEP-53 signature over `message` against a Stellar G-address.
 *
 * @param owner The signer's G-address.
 * @param message The canonical message that was signed.
 * @param signature Base64 or 128-char hex, 64 bytes decoded.
 */
export function verifySignedMessage(
  owner: string,
  message: string,
  signature: string,
): boolean {
  const sig = decodeSignature(signature);
  if (!sig) return false;

  let kp: Keypair;
  try {
    kp = Keypair.fromPublicKey(owner);
  } catch {
    return false;
  }

  return kp.verify(Buffer.from(sep53Digest(message)), Buffer.from(sig));
}
