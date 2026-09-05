/**
 * Generates conformance vectors FROM the live protocol implementation, so the
 * vectors are never circular with respect to the SDK being tested against them.
 *
 * Usage, from the Kryon monorepo's `client/` directory:
 *
 *   KRYON_CLIENT_DIR=. npx tsx ../../KryonSDK/conformance/generate.ts \
 *     > ../../KryonSDK/conformance/vectors.json
 *
 * KRYON_CLIENT_DIR defaults to the current working directory.
 */
import { Keypair, hash } from "@stellar/stellar-sdk";
import * as path from "path";
import { createRequire } from "module";

const CLIENT_DIR = path.resolve(process.env.KRYON_CLIENT_DIR ?? process.cwd());
// Loaded by path rather than by a static import so this generator can live in
// the SDK repo while sourcing its truth from the protocol repo.
const requireFrom = createRequire(path.join(CLIENT_DIR, "package.json"));
const { orderSettlementMessage, cancelSigningMessage, pubkeyHexFromAddress } =
  requireFrom(path.join(CLIENT_DIR, "lib/market/signing-message"));

const MAINNET = "Public Global Stellar Network ; September 2015";
const TESTNET = "Test SDF Network ; September 2015";
const SEP53_PREFIX = "Stellar Signed Message:\n";

// Fixed, published test key, derived deterministically from a constant seed
// so the vectors are reproducible by anyone. NEVER fund this account.
const SEED = Buffer.from("kryon-sdk-conformance-vectors-v1".padEnd(32, "\0").slice(0, 32), "utf8");
const kp = Keypair.fromRawEd25519Seed(SEED);
const SECRET = kp.secret();
const owner = kp.publicKey();

function sep53(msg: string) {
  return hash(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(msg, "utf8")]));
}
function sign(msg: string) {
  return kp.sign(sep53(msg)).toString("base64");
}

const orders = [
  { label: "xlm-long-limit", passphrase: TESTNET,
    intent: { owner, market_id: 1, is_long: true, size: "10000000", limit_price: "205000000000000000", reduce_only: false, nonce: "1780061000000", expiry_ts: "1780064600" } },
  { label: "btc-short-limit-mainnet", passphrase: MAINNET,
    intent: { owner, market_id: 2, is_long: false, size: "100000", limit_price: "77334100000000000000000", reduce_only: false, nonce: "1780061000001", expiry_ts: "1780064600" } },
  { label: "eth-market-order-reduce-only", passphrase: TESTNET,
    intent: { owner, market_id: 3, is_long: false, size: "5000000", limit_price: "0", reduce_only: true, nonce: "1780061000002", expiry_ts: "1780065000" } },
  { label: "trx-max-u64-nonce", passphrase: TESTNET,
    intent: { owner, market_id: 8, is_long: true, size: "1", limit_price: "1", reduce_only: false, nonce: "18446744073709551615", expiry_ts: "1780064600" } },
];

const cancels = [
  { label: "cancel-testnet", passphrase: TESTNET, nonce: "1780061000000" },
  { label: "cancel-mainnet", passphrase: MAINNET, nonce: "18446744073709551615" },
];

const out = {
  $comment:
    "Conformance vectors for Kryon signed intents. Generated from the live protocol implementation (client/lib/market/signing-message.ts). Both @kryon/sdk and the perp-order-gateway contract must reproduce every canonical_message and digest here. The key is a published test key and must never be funded.",
  generated_from: "client/lib/market/signing-message.ts",
  generator: "conformance/generate.ts",
  test_key: { secret: SECRET, public: owner, pubkey_hex: pubkeyHexFromAddress(owner) },
  sep53_prefix: SEP53_PREFIX,
  passphrases: { mainnet: MAINNET, testnet: TESTNET },
  orders: orders.map((o) => {
    const msg = orderSettlementMessage(o.passphrase, pubkeyHexFromAddress(owner), o.intent);
    return {
      label: o.label, network_passphrase: o.passphrase, intent: o.intent,
      canonical_message: msg,
      sep53_digest_hex: sep53(msg).toString("hex"),
      signature_base64: sign(msg),
    };
  }),
  cancels: cancels.map((c) => {
    const msg = cancelSigningMessage(owner, c.nonce, c.passphrase);
    return {
      label: c.label, network_passphrase: c.passphrase, owner, nonce: c.nonce,
      canonical_message: msg,
      sep53_digest_hex: sep53(msg).toString("hex"),
      signature_base64: sign(msg),
    };
  }),
};

console.log(JSON.stringify(out, null, 2));
