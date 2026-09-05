/**
 * SEP-53 message signing.
 *
 * Kryon accepts SEP-53 signatures ONLY: the signed payload is
 * `sha256("Stellar Signed Message:\n" || message)`, never the raw message
 * bytes. Both the API (`verifySignedMessage`) and the gateway contract
 * (`verify_order_signature`) enforce this, so any other envelope produces an
 * order that is rejected at intake or — worse, if it slipped past intake —
 * can never be settled on chain.
 */

import { StrKey, hash } from "@stellar/stellar-sdk";
import type { PubkeyHex } from "./canonical.js";

/** The SEP-53 domain prefix. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * The 32-byte digest a SEP-53 signer actually signs.
 *
 * @param message The canonical message (see `canonical.ts`).
 * @returns sha256(SEP53_PREFIX || message)
 */
export function sep53Digest(message: string): Uint8Array {
  const prefix = Buffer.from(SEP53_PREFIX, "utf8");
  const body = Buffer.from(message, "utf8");
  return new Uint8Array(hash(Buffer.concat([prefix, body])));
}

/** Lowercase hex of the ed25519 public key behind a Stellar G-address. */
export function pubkeyHexFromAddress(address: string): PubkeyHex {
  return Buffer.from(StrKey.decodeEd25519PublicKey(address)).toString("hex");
}

/**
 * Decode a wire signature into 64 raw bytes.
 *
 * Both encodings seen in the wild are accepted: browser wallets return base64,
 * while the keeper scripts historically used hex. Hex is only assumed when the
 * string cannot be anything else (exactly 128 hex chars), so a base64 payload
 * that happens to be all hex characters is not misread.
 *
 * @returns the 64 signature bytes, or null if the input is not a valid
 *   64-byte signature in either encoding.
 */
export function decodeSignature(signature: string): Uint8Array | null {
  const s = signature.trim();
  let buf: Buffer;
  try {
    buf = /^[0-9a-fA-F]{128}$/.test(s)
      ? Buffer.from(s, "hex")
      : Buffer.from(s, "base64");
  } catch {
    return null;
  }
  return buf.length === 64 ? new Uint8Array(buf) : null;
}

/** Encode a 64-byte signature as base64 — the encoding Kryon's API prefers. */
export function encodeSignature(sig: Uint8Array): string {
  return Buffer.from(sig).toString("base64");
}
