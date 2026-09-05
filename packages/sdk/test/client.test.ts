/**
 * Client tests. These use a stub fetch — no network, no live venue.
 */

import { describe, expect, it, vi } from "vitest";
import { KryonClient } from "../src/client/index.js";
import { KeypairSigner, verifySignedMessage, orderCanonicalMessage, pubkeyHexFromAddress } from "../src/signing/index.js";
import {
  PreflightError,
  RateLimitError,
  ServerError,
  SignatureError,
  ValidationError,
} from "../src/util/errors.js";

/** A fetch stub that records calls and replays queued responses. */
function stubFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json", ...(next.headers ?? {}) },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const ORDERBOOK = {
  bids: [{ price: "0.2000", size: "100" }, { price: "0.1990", size: "50" }],
  asks: [{ price: "0.2010", size: "80" }],
  timestamp: 1780061673243,
};

describe("network targeting", () => {
  it("always sends an explicit ?network=, so a cookie cannot redirect a bot", async () => {
    const { fetch, calls } = stubFetch([{ body: ORDERBOOK }]);
    const client = new KryonClient({ network: "testnet", fetch });
    await client.orderbook("XLM-PERP");
    expect(calls[0]!.url).toContain("network=testnet");
  });

  it("uses the right passphrase per network when signing", async () => {
    const signer = KeypairSigner.random();
    for (const [network, passphrase] of [
      ["testnet", "Test SDF Network ; September 2015"],
      ["mainnet", "Public Global Stellar Network ; September 2015"],
    ] as const) {
      const { fetch, calls } = stubFetch([{ body: { ok: true } }]);
      const client = new KryonClient({ network, signer, fetch });
      const order = await client.placeOrder({
        market: "XLM-PERP", side: "buy", size: 100, price: 0.2,
      });
      const body = JSON.parse(String(calls[0]!.init.body));
      const message = orderCanonicalMessage(
        passphrase,
        pubkeyHexFromAddress(signer.publicKey()),
        body,
      );
      expect(verifySignedMessage(signer.publicKey(), message, body.signature)).toBe(true);
      expect(order.nonce).toBeTypeOf("bigint");
    }
  });
});

describe("order placement", () => {
  it("converts human units to wire units", async () => {
    const signer = KeypairSigner.random();
    const { fetch, calls } = stubFetch([{ body: { ok: true } }]);
    const client = new KryonClient({ network: "testnet", signer, fetch });

    await client.placeOrder({ market: "XLM-PERP", side: "buy", size: 100, price: 0.2 });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.size).toBe("1000000000");            // 100 * 1e7
    expect(body.limit_price).toBe("200000000000000000"); // 0.2 * 1e18
    expect(body.is_long).toBe(true);
    expect(body.market_id).toBe(1);
  });

  it("sends limit_price 0 for a market order", async () => {
    const { fetch, calls } = stubFetch([{ body: { ok: true } }]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch,
    });
    await client.placeOrder({ market: "XLM-PERP", side: "sell", size: 1 });
    expect(JSON.parse(String(calls[0]!.init.body)).limit_price).toBe("0");
  });

  it("rounds price down to the market tick", async () => {
    const { fetch, calls } = stubFetch([{ body: { ok: true } }]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch,
    });
    // XLM tick is 0.0001; 0.203847 must become 0.2038.
    await client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.203847 });
    expect(JSON.parse(String(calls[0]!.init.body)).limit_price).toBe("203800000000000000");
  });

  it("issues a fresh, increasing nonce per order", async () => {
    const { fetch, calls } = stubFetch([{ body: { ok: true } }, { body: { ok: true } }]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch,
    });
    await client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 });
    await client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 });
    const first = BigInt(JSON.parse(String(calls[0]!.init.body)).nonce);
    const second = BigInt(JSON.parse(String(calls[1]!.init.body)).nonce);
    expect(second).toBeGreaterThan(first);
  });

  it("refuses to place without a signer", async () => {
    const { fetch } = stubFetch([]);
    const client = new KryonClient({ network: "testnet", fetch });
    await expect(
      client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 }),
    ).rejects.toBeInstanceOf(PreflightError);
  });

  it.each([
    ["unknown market", { market: "DOGE-PERP", side: "buy", size: 1 }],
    ["zero size", { market: "XLM-PERP", side: "buy", size: 0 }],
    ["negative size", { market: "XLM-PERP", side: "buy", size: -1 }],
    ["ttl too short", { market: "XLM-PERP", side: "buy", size: 1, ttlSeconds: 3 }],
    ["ttl too long", { market: "XLM-PERP", side: "buy", size: 1, ttlSeconds: 8 * 24 * 3600 }],
  ])("rejects %s locally, without spending a request", async (_label, params) => {
    const { fetch, calls } = stubFetch([]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch,
    });
    await expect(client.placeOrder(params as never)).rejects.toBeInstanceOf(PreflightError);
    expect(calls).toHaveLength(0);
  });
});

describe("error mapping", () => {
  it.each([
    [400, { ok: false, error: "Unknown market_id" }, ValidationError],
    [400, { ok: false, error: "Invalid order signature" }, SignatureError],
    [401, { ok: false, error: "Invalid cancel signature" }, SignatureError],
    [500, { ok: false, error: "Failed to persist order" }, ServerError],
  ])("maps HTTP %i to the right error type", async (status, body, expected) => {
    const { fetch } = stubFetch([{ status, body }]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch, maxAttempts: 1,
    });
    await expect(
      client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 }),
    ).rejects.toBeInstanceOf(expected);
  });

  it("treats a 200 carrying ok:false as a failure", async () => {
    const { fetch } = stubFetch([{ status: 200, body: { ok: false, error: "nope" } }]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch,
    });
    await expect(
      client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("surfaces retry-after on a 429", async () => {
    const { fetch } = stubFetch([
      { status: 429, body: { ok: false, error: "Too many order requests" }, headers: { "retry-after": "7" } },
    ]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch, maxAttempts: 1,
    });
    await client
      .placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 })
      .then(
        () => expect.unreachable("should have thrown"),
        (error: unknown) => {
          expect(error).toBeInstanceOf(RateLimitError);
          expect((error as RateLimitError).retryAfterSeconds).toBe(7);
        },
      );
  });
});

describe("retries", () => {
  it("retries a 500 without re-signing, so one order stays one order", async () => {
    const { fetch, calls } = stubFetch([
      { status: 500, body: { ok: false, error: "boom" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch, maxAttempts: 2,
    });
    await client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 });

    expect(calls).toHaveLength(2);
    // Identical bytes on both attempts: same nonce, same signature.
    expect(calls[0]!.init.body).toBe(calls[1]!.init.body);
  });

  it("does not retry a rejected signature", async () => {
    const { fetch, calls } = stubFetch([
      { status: 400, body: { ok: false, error: "Invalid order signature" } },
    ]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch, maxAttempts: 3,
    });
    await expect(
      client.placeOrder({ market: "XLM-PERP", side: "buy", size: 1, price: 0.2 }),
    ).rejects.toBeInstanceOf(SignatureError);
    expect(calls).toHaveLength(1);
  });
});

describe("order book", () => {
  it("reports best levels, mid and spread", async () => {
    const { fetch } = stubFetch([{ body: ORDERBOOK }]);
    const client = new KryonClient({ network: "testnet", fetch });
    const book = await client.orderbook("XLM-PERP");
    expect(book.bestBid).toBe("0.2000");
    expect(book.bestAsk).toBe("0.2010");
    expect(book.mid).toBe("0.2005");
    expect(book.spread).toBe("0.0010");
    expect(book.crossed).toBe(false);
  });

  it("flags a crossed book, as mainnet's currently is", async () => {
    const { fetch } = stubFetch([
      { body: { bids: [{ price: "0.2016", size: "1" }], asks: [{ price: "0.1817", size: "1" }], timestamp: 1 } },
    ]);
    const client = new KryonClient({ network: "mainnet", fetch });
    const book = await client.orderbook("XLM-PERP");
    expect(book.crossed).toBe(true);
    expect(book.spread).toBe("-0.0199");
  });

  it("handles an empty book without throwing", async () => {
    const { fetch } = stubFetch([{ body: { bids: [], asks: [], timestamp: 1 } }]);
    const client = new KryonClient({ network: "testnet", fetch });
    const book = await client.orderbook("XLM-PERP");
    expect(book.bestBid).toBeNull();
    expect(book.mid).toBeNull();
    expect(book.crossed).toBe(false);
  });
});

describe("markets()", () => {
  it("skips markets the venue advertises but does not serve", async () => {
    const { fetch } = stubFetch([
      { body: { ok: true, network: "mainnet", markets: ["XLM-PERP", "BTC-PERP"], websocketConfigured: true, timestamp: "" } },
      { body: { market_id: 1, symbol: "XLM-PERP", last_price: "183100000000000000", volume: "0", long_open_interest: "0", short_open_interest: "0", funding_long_index: "0", funding_short_index: "0", last_oracle_price: "183169000000000000", active: true } },
      { status: 404, body: { error: "market_not_found" } },
    ]);
    const client = new KryonClient({ network: "mainnet", fetch, maxAttempts: 1 });
    const markets = await client.markets();
    expect(markets.map((m) => m.symbol)).toEqual(["XLM-PERP"]);
    expect(markets[0]!.lastPrice).toBe("0.1831");
  });
});

describe("cancel", () => {
  it("signs the cancel form, not the order form", async () => {
    const signer = KeypairSigner.random();
    const { fetch, calls } = stubFetch([{ body: { ok: true } }]);
    const client = new KryonClient({ network: "testnet", signer, fetch });
    await client.cancelOrder(1780061000000n);

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.owner).toBe(signer.publicKey());
    expect(body.nonce).toBe("1780061000000");
    expect(body).not.toHaveProperty("market_id");
  });

  it("collects failures instead of stranding the rest", async () => {
    const { fetch } = stubFetch([
      { body: { ok: true } },
      { status: 500, body: { ok: false, error: "boom" } },
      { body: { ok: true } },
    ]);
    const client = new KryonClient({
      network: "testnet", signer: KeypairSigner.random(), fetch, maxAttempts: 1,
    });
    const failures = await client.cancelOrders([1n, 2n, 3n]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.nonce).toBe("2");
  });
});
