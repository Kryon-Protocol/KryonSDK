/**
 * The SDK's signing must byte-match the live protocol.
 *
 * `conformance/vectors.json` is generated from the protocol's own
 * implementation, so this asserts the SDK against the venue rather than
 * against itself. A failure here means orders this SDK signs would be
 * rejected at intake, or — if they slipped past intake — matched and then
 * never settleable on chain.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  KeypairSigner,
  cancelCanonicalMessage,
  orderCanonicalMessage,
  pubkeyHexFromAddress,
  sep53Digest,
  signCancelIntent,
  signOrderIntent,
  verifySignedMessage,
  type OrderIntentWire,
} from "../src/signing/index.js";

interface Vectors {
  test_key: { secret: string; public: string; pubkey_hex: string };
  sep53_prefix: string;
  orders: Array<{
    label: string;
    network_passphrase: string;
    intent: OrderIntentWire;
    canonical_message: string;
    sep53_digest_hex: string;
    signature_base64: string;
  }>;
  cancels: Array<{
    label: string;
    network_passphrase: string;
    owner: string;
    nonce: string;
    canonical_message: string;
    sep53_digest_hex: string;
    signature_base64: string;
  }>;
}

const vectors: Vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../conformance/vectors.json", import.meta.url)),
    "utf8",
  ),
);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("conformance: test key", () => {
  it("derives the published pubkey hex from the address", () => {
    expect(pubkeyHexFromAddress(vectors.test_key.public)).toBe(
      vectors.test_key.pubkey_hex,
    );
  });
});

describe.each(vectors.orders)("conformance: order $label", (v) => {
  it("reproduces the canonical message byte for byte", () => {
    expect(
      orderCanonicalMessage(
        v.network_passphrase,
        vectors.test_key.pubkey_hex,
        v.intent,
      ),
    ).toBe(v.canonical_message);
  });

  it("reproduces the SEP-53 digest", () => {
    expect(hex(sep53Digest(v.canonical_message))).toBe(v.sep53_digest_hex);
  });

  it("reproduces the signature", async () => {
    const signer = new KeypairSigner(vectors.test_key.secret);
    const signed = await signOrderIntent(signer, v.network_passphrase, v.intent);
    expect(signed.signature).toBe(v.signature_base64);
  });

  it("verifies the recorded signature", () => {
    expect(
      verifySignedMessage(
        vectors.test_key.public,
        v.canonical_message,
        v.signature_base64,
      ),
    ).toBe(true);
  });

  it("rejects the signature against the other network", () => {
    const otherPassphrase =
      v.network_passphrase === "Test SDF Network ; September 2015"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015";
    const crossNetwork = orderCanonicalMessage(
      otherPassphrase,
      vectors.test_key.pubkey_hex,
      v.intent,
    );
    expect(
      verifySignedMessage(
        vectors.test_key.public,
        crossNetwork,
        v.signature_base64,
      ),
    ).toBe(false);
  });
});

describe.each(vectors.cancels)("conformance: cancel $label", (v) => {
  it("reproduces the canonical message byte for byte", () => {
    expect(
      cancelCanonicalMessage(v.network_passphrase, v.owner, v.nonce),
    ).toBe(v.canonical_message);
  });

  it("reproduces the SEP-53 digest", () => {
    expect(hex(sep53Digest(v.canonical_message))).toBe(v.sep53_digest_hex);
  });

  it("reproduces the signature", async () => {
    const signer = new KeypairSigner(vectors.test_key.secret);
    const signed = await signCancelIntent(signer, v.network_passphrase, v.nonce);
    expect(signed.signature).toBe(v.signature_base64);
    expect(signed.owner).toBe(v.owner);
    expect(signed.nonce).toBe(v.nonce);
  });
});

describe("conformance: the two canonical forms are distinct", () => {
  it("does not accept an order signature for a cancel of the same nonce", () => {
    const order = vectors.orders[0]!;
    const cancelMessage = cancelCanonicalMessage(
      order.network_passphrase,
      vectors.test_key.public,
      order.intent.nonce,
    );
    expect(
      verifySignedMessage(
        vectors.test_key.public,
        cancelMessage,
        order.signature_base64,
      ),
    ).toBe(false);
  });
});
