/**
 * Live integration tests against the real testnet venue.
 *
 * Skipped unless KRYON_LIVE_TEST=1, so `pnpm test` stays offline and fast.
 * Run them with:
 *
 *   KRYON_LIVE_TEST=1 pnpm test
 *
 * This is the suite that catches drift between the SDK and the deployed venue
 * — a changed canonical message, a renamed field, a new validation rule. The
 * offline conformance suite cannot see any of that.
 *
 * These tests place REAL orders on testnet. They use a fresh random keypair
 * with no funds and quote far away from the market, so nothing can match, and
 * every order is cancelled before the test ends.
 */

import { afterAll, describe, expect, it } from "vitest";
import { KryonClient, KeypairSigner, signOrderIntent } from "../src/index.js";

const live = process.env.KRYON_LIVE_TEST === "1";
const signer = KeypairSigner.random();
const client = new KryonClient({ network: "testnet", signer });
const placed: bigint[] = [];

afterAll(async () => {
  if (placed.length > 0) await client.cancelOrders(placed);
});

describe.skipIf(!live)("live testnet", () => {
  it("reports the venue as ready", async () => {
    const status = await client.status();
    expect(status.ok).toBe(true);
    expect(status.network).toBe("testnet");
    expect(status.markets.length).toBeGreaterThan(0);
  });

  it("serves every advertised market", async () => {
    const [status, markets] = await Promise.all([client.status(), client.markets()]);
    expect(markets.map((m) => m.symbol).sort()).toEqual([...status.markets].sort());
  });

  it("publishes a fresh oracle price", async () => {
    const market = await client.market("XLM-PERP");
    expect(Number(market.lastOraclePrice)).toBeGreaterThan(0);
  });

  it(
    "accepts an SDK-signed order and an SDK-signed cancel",
    { timeout: 60_000 },
    async () => {
      const market = await client.market("XLM-PERP");
      // Half the oracle price: rests, cannot cross, cannot be filled.
      const price = (Number(market.lastOraclePrice) * 0.5).toFixed(4);

      const order = await client.placeOrder({
        market: "XLM-PERP",
        side: "buy",
        size: 10,
        price,
        ttlSeconds: 120,
      });
      placed.push(order.nonce);
      expect(order.id).toBe(`${signer.publicKey()}:${order.nonce}`);

      // The venue reflects it in the public book.
      await new Promise((r) => setTimeout(r, 3000));
      const book = await client.orderbook("XLM-PERP");
      expect(book.bids.some((b) => b.price === order.limitPrice)).toBe(true);

      // The cancel uses the OTHER canonical form; this proves both are right.
      await client.cancelOrder(order.nonce);
      placed.pop();

      await new Promise((r) => setTimeout(r, 3000));
      const after = await client.orderbook("XLM-PERP");
      expect(after.bids.some((b) => b.price === order.limitPrice)).toBe(false);
    },
  );

  it("rejects an intent signed for the wrong network", async () => {
    // Sign with MAINNET's passphrase, submit to the TESTNET venue. The venue
    // must refuse it: this is the cross-network replay guard, and it is the
    // reason the passphrase is baked into every canonical message.
    //
    // Built and posted by hand rather than through a mainnet-configured
    // client, because that client would send `?network=mainnet` and place a
    // real order on the real venue.
    const intent = {
      owner: signer.publicKey(),
      market_id: 1,
      is_long: true,
      size: "10000000",
      limit_price: "50000000000000000",
      reduce_only: false,
      nonce: (BigInt(Date.now()) * 1000n).toString(),
      expiry_ts: (Math.floor(Date.now() / 1000) + 120).toString(),
    };
    const wrongNetworkSigned = await signOrderIntent(
      signer,
      "Public Global Stellar Network ; September 2015",
      intent,
    );

    const response = await fetch(
      "https://kryonprotocol.live/api/orders?network=testnet",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wrongNetworkSigned),
      },
    );
    const body = (await response.json()) as { ok: boolean; error?: string };

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/signature/i);
  });
});
