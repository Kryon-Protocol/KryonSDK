/**
 * Conversion between human units and Kryon's wire units.
 *
 * Kryon uses two different fixed-point scales, which is the single easiest
 * thing to get wrong:
 *
 *   prices  ->  1e18
 *   sizes   ->  1e7   (Stellar's 7-decimal convention)
 *
 * On top of that, the REST API is not internally consistent about which side
 * of the conversion it returns: `GET /api/markets/:id` returns RAW fixed-point
 * strings, while `/orderbook`, `/trades`, `/candles`, `/fills`, `/funding`,
 * `/portfolio` and `/leaderboard` return values already scaled to human units.
 * The client layer normalises this so callers only ever see human numbers; the
 * helpers here are what it normalises with.
 *
 * All conversions go through bigint. Prices at 1e18 exceed `Number.MAX_SAFE_
 * INTEGER` by ten orders of magnitude, so parsing one into a float silently
 * loses precision — a $77,334.10 BTC price becomes 77334.09999999999 and the
 * resulting limit price no longer means what the caller wrote.
 */

import { AMOUNT_PRECISION, PRICE_PRECISION } from "../signing/canonical.js";

/**
 * Convert a human decimal to fixed-point, exactly.
 *
 * The input is parsed as a decimal string rather than via float arithmetic, so
 * `0.1` scales to exactly 1e17 rather than 100000000000000001.
 *
 * @param value A number or decimal string, e.g. `0.2038` or `"77334.1"`.
 * @param precision The target scale, e.g. `PRICE_PRECISION`.
 * @throws on a non-finite number, a malformed string, or more decimal places
 *   than the scale can represent.
 */
export function toFixedPoint(value: number | string | bigint, precision: bigint): bigint {
  if (typeof value === "bigint") return value * precision;

  const text = typeof value === "number" ? formatFloat(value) : value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`Not a valid decimal number: ${JSON.stringify(value)}`);
  }

  const [, sign, whole = "", frac = ""] = match;
  const scaleDigits = precision.toString().length - 1;
  if (frac.length > scaleDigits) {
    // Refuse rather than round: silently dropping digits from a price is how a
    // bot ends up quoting something it did not intend.
    throw new Error(
      `${value} has ${frac.length} decimal places, but this field supports at most ${scaleDigits}`,
    );
  }

  const digits = `${whole || "0"}${frac.padEnd(scaleDigits, "0")}`;
  const magnitude = BigInt(digits);
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * Convert fixed-point back to a human decimal string, without float rounding.
 *
 * @param decimals Trim to this many decimal places. Omit to keep them all.
 */
export function fromFixedPoint(
  value: bigint | string,
  precision: bigint,
  decimals?: number,
): string {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;

  const scaleDigits = precision.toString().length - 1;
  const whole = magnitude / precision;
  const frac = (magnitude % precision).toString().padStart(scaleDigits, "0");

  const kept = decimals === undefined ? frac.replace(/0+$/, "") : frac.slice(0, decimals);
  const sign = negative ? "-" : "";
  return kept.length > 0 ? `${sign}${whole}.${kept}` : `${sign}${whole}`;
}

/** Human price -> 1e18 wire price. */
export function priceToWire(price: number | string | bigint): bigint {
  return toFixedPoint(price, PRICE_PRECISION);
}

/** 1e18 wire price -> human decimal string. */
export function priceFromWire(price: bigint | string, decimals?: number): string {
  return fromFixedPoint(price, PRICE_PRECISION, decimals);
}

/** Human size -> 1e7 wire size. */
export function sizeToWire(size: number | string | bigint): bigint {
  return toFixedPoint(size, AMOUNT_PRECISION);
}

/** 1e7 wire size -> human decimal string. */
export function sizeFromWire(size: bigint | string, decimals?: number): string {
  return fromFixedPoint(size, AMOUNT_PRECISION, decimals);
}

/**
 * Round a wire price down to a multiple of `tick`, toward zero.
 *
 * Kryon does not reject off-tick prices, so this is about the book being
 * legible rather than about validity — but quoting at a precision no other
 * participant uses means never sitting at the front of a level.
 *
 * @param tick The tick size in human units, e.g. `0.0001`.
 */
export function roundToTick(wirePrice: bigint, tick: number): bigint {
  const tickWire = priceToWire(tick);
  if (tickWire <= 0n) return wirePrice;
  const remainder = wirePrice % tickWire;
  return remainder === 0n ? wirePrice : wirePrice - remainder;
}

/**
 * Render a float as a plain decimal string, without exponent notation.
 *
 * `Number.prototype.toString` produces "1e-7" for small sizes, which the
 * decimal parser above would reject.
 */
function formatFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Not a finite number: ${value}`);
  }
  if (!/e/i.test(String(value))) return String(value);
  // 20 is the maximum toFixed supports and exceeds both of Kryon's scales
  // for any magnitude a price or size realistically takes.
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}
