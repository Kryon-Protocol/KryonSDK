/**
 * The HTTP layer: one place that knows how to talk to the Kryon API.
 *
 * Two behaviours here matter more than they look:
 *
 * 1. **Retries never re-sign.** A retry re-sends the identical bytes. If the
 *    SDK re-signed on retry it would mint a new nonce, and a timeout that was
 *    actually delivered would become two live orders instead of one.
 *
 * 2. **Only idempotent-safe failures are retried.** 5xx, 429 and transport
 *    errors are retried; every 4xx is surfaced immediately, because retrying a
 *    rejected signature just burns the rate limit.
 */

import {
  NetworkError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  ServerError,
  SignatureError,
  ValidationError,
} from "../util/errors.js";
import type { NetworkId } from "../config/networks.js";

export interface HttpOptions {
  /** API origin, e.g. `https://kryonprotocol.live`. */
  baseUrl: string;
  /** Which venue to address. Sent as `?network=` on every request. */
  network: NetworkId;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Attempts for retryable failures, including the first. Default 3. */
  maxAttempts?: number;
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Skip retries even if the failure looks retryable. */
  noRetry?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class HttpClient {
  readonly #baseUrl: string;
  readonly #network: NetworkId;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Record<string, string>;

  constructor(options: HttpOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#network = options.network;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#headers = options.headers ?? {};

    const f = options.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        "No fetch implementation available. Use Node 20+, or pass one as `fetch`.",
      );
    }
    // Bound so an unbound global fetch does not lose its receiver.
    this.#fetch = f.bind(globalThis);
  }

  get network(): NetworkId {
    return this.#network;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.#request<T>({ method: "GET", path, ...(query ? { query } : {}) });
  }

  async post<T>(path: string, body: unknown, opts?: { noRetry?: boolean }): Promise<T> {
    return this.#request<T>({
      method: "POST",
      path,
      body,
      ...(opts?.noRetry ? { noRetry: true } : {}),
    });
  }

  async #request<T>(options: RequestOptions): Promise<T> {
    // `?network=` is always explicit. The venue otherwise falls back to a
    // cookie and then to its own primary network, which for a bot means an
    // order could silently land on the wrong venue.
    const url = new URL(this.#baseUrl + options.path);
    url.searchParams.set("network", this.#network);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const attempts = options.noRetry ? 1 : this.#maxAttempts;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#attempt<T>(url, options);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof NetworkError ||
          error instanceof ServerError ||
          error instanceof RateLimitError;
        if (!retryable || attempt === attempts) throw error;

        const waitMs =
          error instanceof RateLimitError && error.retryAfterSeconds !== undefined
            ? error.retryAfterSeconds * 1000
            : backoffMs(attempt);
        await sleep(waitMs);
      }
    }

    throw lastError;
  }

  async #attempt<T>(url: URL, options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: options.method,
        headers: {
          Accept: "application/json",
          // Market data is freshness-critical; never serve it from a cache.
          "Cache-Control": "no-store",
          ...(options.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...this.#headers,
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? `timed out after ${this.#timeoutMs}ms`
          : String(error instanceof Error ? error.message : error);
      throw new NetworkError(`${options.method} ${options.path} failed: ${reason}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw toError(response, payload, text, options);
    }

    // Mutating routes answer `{ ok: false, error }` with a 200 in some paths;
    // treat that as the failure it is rather than returning a success shape.
    if (
      payload !== null &&
      typeof payload === "object" &&
      "ok" in payload &&
      (payload as { ok: unknown }).ok === false
    ) {
      const message = String((payload as { error?: unknown }).error ?? "request rejected");
      throw new ValidationError(`${options.method} ${options.path}: ${message}`, message);
    }

    return payload as T;
  }
}

function toError(
  response: Response,
  payload: unknown,
  rawText: string,
  options: RequestOptions,
): Error {
  const apiError =
    payload !== null && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : rawText.slice(0, 200) || response.statusText;
  const where = `${options.method} ${options.path}`;

  switch (response.status) {
    case 400:
      // The venue reports a bad signature as a 400 on placement but a 401 on
      // cancel; normalise both onto SignatureError so callers see one thing.
      return /signature/i.test(apiError)
        ? new SignatureError(`${where}: ${apiError}`)
        : new ValidationError(`${where}: ${apiError}`, apiError);
    case 401:
    case 403:
      return new SignatureError(`${where}: ${apiError}`);
    case 404:
      return new NotFoundError(`${where}: ${apiError}`);
    case 413:
      return new PayloadTooLargeError(`${where}: ${apiError}`);
    case 429: {
      const header = response.headers.get("retry-after");
      const retryAfter = header !== null ? Number(header) : Number.NaN;
      return new RateLimitError(
        `${where}: ${apiError}`,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }
    default:
      if (response.status >= 500) {
        return new ServerError(`${where}: ${apiError}`, response.status);
      }
      return new ValidationError(`${where}: ${apiError}`, apiError);
  }
}

/** Exponential backoff with full jitter, capped at 8s. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(8000, 250 * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
