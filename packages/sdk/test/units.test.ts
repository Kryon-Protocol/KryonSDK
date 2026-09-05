import { describe, expect, it } from "vitest";
import {
  fromFixedPoint,
  priceFromWire,
  priceToWire,
  roundToTick,
  sizeFromWire,
  sizeToWire,
  toFixedPoint,
} from "../src/util/units.js";
import { AMOUNT_PRECISION, PRICE_PRECISION } from "../src/signing/canonical.js";

describe("toFixedPoint", () => {
  it("scales prices exactly, without float error", () => {
    // 0.1 * 1e18 in floating point is 1.0000000000000001e17.
    expect(priceToWire(0.1)).toBe(100000000000000000n);
    expect(priceToWire("0.2038")).toBe(203800000000000000n);
    expect(priceToWire("77334.1")).toBe(77334100000000000000000n);
  });

  it("scales sizes at 1e7", () => {
    expect(sizeToWire(1)).toBe(10000000n);
    expect(sizeToWire("0.0001")).toBe(1000n);
  });

  it("handles integers, strings and bigints alike", () => {
    expect(toFixedPoint(5, AMOUNT_PRECISION)).toBe(50000000n);
    expect(toFixedPoint("5", AMOUNT_PRECISION)).toBe(50000000n);
    expect(toFixedPoint(5n, AMOUNT_PRECISION)).toBe(50000000n);
  });

  it("keeps negatives signed", () => {
    expect(toFixedPoint("-1.5", AMOUNT_PRECISION)).toBe(-15000000n);
  });

  it("does not use exponent notation for very small values", () => {
    expect(sizeToWire(0.0000001)).toBe(1n);
  });

  it("refuses to silently round away precision", () => {
    // 8 decimals on a 7-decimal field would quietly change the size.
    expect(() => sizeToWire("0.00000001")).toThrow(/decimal places/);
  });

  it("rejects malformed input", () => {
    expect(() => priceToWire("abc")).toThrow();
    expect(() => priceToWire("")).toThrow();
    expect(() => priceToWire(Number.NaN)).toThrow();
    expect(() => priceToWire(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("fromFixedPoint", () => {
  it("round-trips prices", () => {
    expect(priceFromWire(priceToWire("77334.1"))).toBe("77334.1");
    expect(priceFromWire(priceToWire("0.2038"))).toBe("0.2038");
  });

  it("round-trips sizes", () => {
    expect(sizeFromWire(sizeToWire("1.2345"))).toBe("1.2345");
  });

  it("keeps full precision on a value no float could hold", () => {
    const wire = 77334123456789012345678n;
    expect(priceFromWire(wire)).toBe("77334.123456789012345678");
  });

  it("trims to a requested number of decimals", () => {
    expect(priceFromWire(priceToWire("0.20384999"), 4)).toBe("0.2038");
  });

  it("renders whole numbers without a trailing dot", () => {
    expect(priceFromWire(PRICE_PRECISION)).toBe("1");
    expect(sizeFromWire(0n)).toBe("0");
  });

  it("keeps negatives signed", () => {
    expect(fromFixedPoint(-15000000n, AMOUNT_PRECISION)).toBe("-1.5");
  });
});

describe("roundToTick", () => {
  it("rounds an XLM price down to the 0.0001 tick", () => {
    expect(priceFromWire(roundToTick(priceToWire("0.203847"), 0.0001))).toBe("0.2038");
  });

  it("rounds a BTC price down to the 0.1 tick", () => {
    expect(priceFromWire(roundToTick(priceToWire("77334.17"), 0.1))).toBe("77334.1");
  });

  it("leaves an already-aligned price untouched", () => {
    const aligned = priceToWire("0.2038");
    expect(roundToTick(aligned, 0.0001)).toBe(aligned);
  });
});
