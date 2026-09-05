/**
 * Typed errors.
 *
 * The API returns `{ ok: false, error: "<prose>" }` with the detail only in
 * the message, so a bot that wants to branch on failure has to string-match.
 * These classes do that matching once, in one place, so strategy code can ask
 * "was this rate limiting or a bad signature?" without parsing English.
 */

/** Base class for everything this SDK throws. */
export class KryonError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request never reached the venue: DNS, TLS, timeout, connection reset. */
export class NetworkError extends KryonError {}

/** The venue rejected the request body (HTTP 400). */
export class ValidationError extends KryonError {
  constructor(
    message: string,
    /** The venue's own error string, unmodified. */
    readonly apiError: string,
  ) {
    super(message);
  }
}

/**
 * The signature did not verify (HTTP 400 on placement, 401 on cancel).
 *
 * Almost always one of: signing for the wrong network, signing the wrong
 * canonical form, or a signer whose public key is not the intent's owner.
 */
export class SignatureError extends KryonError {}

/** Rate limited (HTTP 429). */
export class RateLimitError extends KryonError {
  constructor(
    message: string,
    /** Seconds to wait before retrying, if the venue said. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
  }
}

/** The request body exceeded the venue's size cap (HTTP 413). */
export class PayloadTooLargeError extends KryonError {}

/** The venue failed (HTTP 5xx). Safe to retry with backoff. */
export class ServerError extends KryonError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The resource does not exist (HTTP 404). */
export class NotFoundError extends KryonError {}

/**
 * The SDK refused to send the request.
 *
 * Raised by client-side checks — unknown market, expiry already in the past,
 * size below the minimum — that would otherwise cost a rate-limit slot to
 * learn from the venue.
 */
export class PreflightError extends KryonError {}

/** True when retrying the identical request could plausibly succeed. */
export function isRetryable(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    error instanceof ServerError ||
    error instanceof RateLimitError
  );
}
