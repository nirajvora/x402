import { x402Client, x402ClientConfig, x402HTTPClient } from "@x402/core/client";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, ResponseBodyTooLargeError } from "@x402/core/http";
import {
  type PaymentPayload,
  type PaymentReconcileResult,
  type PaymentRequired,
} from "@x402/core/types";
import { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from "axios";

type X402RetryConfig = InternalAxiosRequestConfig & { __is402Retry?: boolean };
type AxiosHeaderValue = string | string[];
type AxiosHeaderRecord = Record<string, AxiosHeaderValue>;

/**
 * Resolves the final absolute URL for an Axios 402 response.
 *
 * @param config - Original Axios request configuration
 * @param axiosInstance - Axios instance used to serialize the request URL
 * @param response - Axios error response, if present
 * @returns Absolute request URL (prefers final URL after redirects)
 */
function resolveAxiosRequestUrl(
  config: InternalAxiosRequestConfig,
  axiosInstance: AxiosInstance,
  response?: AxiosError["response"],
): string {
  const responseUrl =
    (response?.request as { responseURL?: string } | undefined)?.responseURL ??
    (response?.request as { res?: { responseUrl?: string } } | undefined)?.res?.responseUrl;

  if (responseUrl) {
    return responseUrl;
  }

  const url = config.url ?? "";
  if (config.baseURL) {
    try {
      return new URL(axiosInstance.getUri(config)).href;
    } catch {
      return url || config.baseURL;
    }
  }

  return axiosInstance.getUri(config);
}

/**
 * Clones Axios headers into a plain record so the caller's Axios instance can
 * normalize them for the retry request.
 *
 * @param headers - Headers from the caller's original Axios request config.
 * @returns Serializable headers for Axios to normalize in the caller's instance.
 */
function cloneAxiosHeaders(headers: InternalAxiosRequestConfig["headers"]): AxiosHeaderRecord {
  const source =
    typeof headers.toJSON === "function"
      ? (headers.toJSON() as Record<string, unknown>)
      : (headers as unknown as Record<string, unknown>);

  return Object.entries(source).reduce<AxiosHeaderRecord>((acc, [key, value]) => {
    if (value === undefined || value === null || typeof value === "function") {
      return acc;
    }

    // Axios joins a Cookie array with "; " in its HTTP adapter. String()
    // joins with "," and changes the cookie the paid retry sends.
    if (Array.isArray(value)) {
      // Keep empty strings. Axios joins them too, so "" + "locale=zh"
      // stays "; locale=zh" on the paid retry instead of "locale=zh".
      // Keep an empty array. Dropping Cookie: [] lets Axios merge an
      // instance default back in on the paid retry.
      acc[key] = value.filter((item): item is string => typeof item === "string");
      return acc;
    }

    acc[key] = String(value);
    return acc;
  }, {});
}

/**
 * Sets a header on a retry header record.
 *
 * @param headers - Headers object to update.
 * @param key - Header name.
 * @param value - Header value.
 */
function setAxiosHeader(headers: AxiosHeaderRecord, key: string, value: string): void {
  headers[key] = value;
}

/**
 * Ensures an Axios `response.data` value stays within the control-plane body cap.
 * Axios buffers response bodies, so byte length can be checked without streaming.
 *
 * @param data - Axios `response.data` for a payment-required or retry response
 * @param maxBytes - Maximum allowed body size in bytes
 * @throws {@link ResponseBodyTooLargeError} when the buffered body exceeds `maxBytes`
 */
function assertAxiosResponseBodyWithinLimit(
  data: unknown,
  maxBytes: number = MAX_CONTROL_PLANE_RESPONSE_BYTES,
): void {
  if (data == null) {
    return;
  }

  let byteLength: number;
  if (typeof data === "string") {
    byteLength = new TextEncoder().encode(data).byteLength;
  } else if (data instanceof ArrayBuffer) {
    byteLength = data.byteLength;
  } else if (data instanceof Uint8Array) {
    byteLength = data.byteLength;
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    byteLength = data.size;
  } else {
    byteLength = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  }

  if (byteLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes);
  }
}

/**
 * Clones an Axios internal request config so a retry can treat HTTP 402 as a successful
 * response status for validation (so the interceptor can handle payment flow).
 *
 * @param config - Original Axios request configuration for the outgoing request.
 * @returns Request config with copied headers and validateStatus that returns true for 402.
 */
function createX402RetryConfig(config: InternalAxiosRequestConfig): X402RetryConfig {
  const originalValidateStatus = config.validateStatus;

  return {
    ...config,
    headers: cloneAxiosHeaders(config.headers) as InternalAxiosRequestConfig["headers"],
    validateStatus: status => {
      if (status === 402) {
        return true;
      }

      return originalValidateStatus
        ? originalValidateStatus(status)
        : status >= 200 && status < 300;
    },
  };
}

/** Grace after the authorization window closes before an `"unsettled"` reconcile result is trusted. */
const RECONCILE_GRACE_MS = 15_000;
/**
 * Bound on held payments for one wrapped instance.
 * A full table refuses a new purchase. It does not drop a possible spend.
 */
const MAX_HELD_PAYMENTS = 1_000;

interface HeldPayment {
  paymentPayload: PaymentPayload;
  /** `null` when `accepted.maxTimeoutSeconds` is not a number. Those holds do not expire here. */
  expiresAt: number | null;
}

interface PaymentResponseView {
  status?: number;
  data?: unknown;
  headers?: unknown;
}

/**
 * Thrown when a payment for this purchase was created, the resource did not deliver,
 * and a later attempt still cannot show that the payment never settled.
 * Signing a new payment here could pay twice.
 */
export class PaymentOutcomeUnknownError extends Error {
  /**
   * @param paymentPayload - The payment that was created and may have settled
   * @param response - The last paid response, when one was received
   */
  constructor(
    readonly paymentPayload: PaymentPayload,
    readonly response: PaymentResponseView | undefined,
  ) {
    super(
      `Payment outcome unknown: HTTP ${response?.status ?? "no response"} after a payment was sent; not signing again`,
    );
    this.name = "PaymentOutcomeUnknownError";
  }
}

/**
 * Thrown when a new purchase cannot be remembered without dropping one that may have settled.
 * No payload is created for the refused purchase.
 */
export class PaymentHoldCapacityError extends Error {
  constructor() {
    super(
      `Payment hold table is full (${MAX_HELD_PAYMENTS}); refusing to sign a new payment or drop a possible spend`,
    );
    this.name = "PaymentHoldCapacityError";
  }
}

/**
 * Stable purchase-body key, or `null` when the body cannot be re-presented safely.
 * `null` is not an empty body. Supported values carry explicit encoding tags.
 *
 * @param data - Axios `config.data`
 * @returns A stable body string, or `null` for streams, FormData, and unstringifiable values
 */
function stableRequestBody(data: unknown): string | null {
  // Encoding tags distinguish binary bytes from text with the same encoding.
  // Hex needs neither a Node Buffer global nor a browser-specific base64 API.
  const binary = (bytes: Uint8Array): string => {
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return `bytes:${hex}`;
  };
  if (data == null) {
    return "empty:";
  }
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return `text:${String(data)}`;
  }
  if (data instanceof ArrayBuffer) {
    return binary(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return binary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams) {
    return `urlencoded:${data.toString()}`;
  }
  if (typeof FormData !== "undefined" && data instanceof FormData) {
    return null;
  }
  if (typeof data === "object") {
    const record = data as { pipe?: unknown };
    if (
      typeof record.pipe === "function" ||
      (typeof ReadableStream !== "undefined" && data instanceof ReadableStream)
    ) {
      return null;
    }
    try {
      const serialized = JSON.stringify(data);
      return typeof serialized === "string" ? `json:${serialized}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function responseView(value: unknown): PaymentResponseView | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate =
    "response" in value && (value as { response?: unknown }).response
      ? (value as { response?: unknown }).response
      : value;
  if (!candidate || typeof candidate !== "object" || !("status" in candidate)) {
    return undefined;
  }
  const response = candidate as { status?: number; data?: unknown; headers?: unknown };
  return { status: response.status, data: response.data, headers: response.headers };
}

/**
 * Wraps an Axios instance with x402 payment handling.
 *
 * This function adds an interceptor to automatically handle 402 Payment Required responses
 * by creating and sending payment headers. It will:
 * 1. Intercept 402 responses
 * 2. Parse the payment requirements
 * 3. Create a payment header using the configured x402HTTPClient
 * 4. Retry the request with the payment header
 *
 * One purchase (caller method, caller URL, and stable body) owns one in-flight payload.
 * The payload is held until the resource returns a status below 400, or until
 * `accepted.maxTimeoutSeconds` plus {@link RECONCILE_GRACE_MS} have passed and
 * `reconcilePaymentPayload` returns `"unsettled"`. A settle `errorReason`, including a
 * snake_case token with an empty `transaction`, is not proof that nothing was broadcast:
 * resource servers copy thrown error messages into that field.
 *
 * Payloads with no numeric timeout, including v1, stay held for the life of this process.
 * The map is not kept across process restart. Streams and FormData are not keyed; those
 * requests keep one-shot payment behavior because the body cannot be re-presented safely.
 * At {@link MAX_HELD_PAYMENTS} a new purchase is refused rather than evicting a possible spend.
 *
 * @param axiosInstance - The Axios instance to wrap
 * @param client - Configured x402Client instance for handling payments
 * @returns The wrapped Axios instance that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { wrapAxiosWithPayment, x402Client } from '@x402/axios';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const account = privateKeyToAccount('0x...');
 * const client = new x402Client()
 *   .register('eip155:*', new ExactEvmScheme(account));
 *
 * const api = wrapAxiosWithPayment(axios.create(), client);
 *
 * // Make a request that may require payment
 * const response = await api.get('https://api.example.com/paid-endpoint');
 * ```
 *
 * @throws {Error} If no schemes are provided
 * @throws {Error} If the request configuration is missing
 * @throws {Error} If a payment has already been attempted for this request
 * @throws {Error} If there's an error creating the payment header
 * @throws {PaymentOutcomeUnknownError} If a re-presented payment still is not delivered and settlement is not ruled out
 * @throws {PaymentHoldCapacityError} If a new payment cannot be held without dropping a possible spend
 */
export function wrapAxiosWithPayment(
  axiosInstance: AxiosInstance,
  client: x402Client | x402HTTPClient,
): AxiosInstance {
  const httpClient = client instanceof x402HTTPClient ? client : new x402HTTPClient(client);
  const held = new Map<string, HeldPayment>();
  const inflight = new Map<string, Promise<HeldPayment>>();

  const headerValue = (headers: Record<string, unknown>, name: string): string | undefined => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return typeof value === "string" ? value : undefined;
  };

  const occupied = (): number => {
    const keys = new Set<string>(held.keys());
    for (const key of inflight.keys()) {
      keys.add(key);
    }
    return keys.size;
  };

  const remember = (key: string, paymentPayload: PaymentPayload): HeldPayment => {
    const maxTimeoutSeconds = paymentPayload.accepted?.maxTimeoutSeconds;
    const expiresAt =
      typeof maxTimeoutSeconds === "number" ? Date.now() + maxTimeoutSeconds * 1000 : null;
    const hold = { paymentPayload, expiresAt };
    held.set(key, hold);
    return hold;
  };

  const reconcile = async (
    paymentPayload: PaymentPayload,
  ): Promise<PaymentReconcileResult> => {
    if (typeof client.reconcilePaymentPayload !== "function") {
      return "unknown";
    }
    try {
      const outcome = await client.reconcilePaymentPayload(paymentPayload);
      if (outcome === "settled" || outcome === "unsettled" || outcome === "unknown") {
        return outcome;
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  };

  const releaseIfProvenUnsettled = async (key: string, prior: HeldPayment): Promise<boolean> => {
    if (prior.expiresAt == null) {
      return false;
    }
    const now = Date.now();
    if (now < prior.expiresAt) {
      return false;
    }
    const outcome = await reconcile(prior.paymentPayload);
    // A concurrent caller may already have replaced this hold. Only that same
    // record may be dropped, and only on this one clock snapshot.
    if (
      outcome === "unsettled" &&
      now >= prior.expiresAt + RECONCILE_GRACE_MS &&
      held.get(key) === prior
    ) {
      held.delete(key);
      return true;
    }
    return false;
  };

  const startPayload = (key: string, paymentRequired: PaymentRequired): Promise<HeldPayment> => {
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }
    if (occupied() >= MAX_HELD_PAYMENTS) {
      throw new PaymentHoldCapacityError();
    }

    const deferred: {
      resolve: (hold: HeldPayment) => void;
      reject: (error: unknown) => void;
    } = {
      resolve: () => undefined,
      reject: () => undefined,
    };
    const created = new Promise<HeldPayment>((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    inflight.set(key, created);

    // A synchronous throw from createPaymentPayload must reject `created` and
    // leave the in-flight slot. Otherwise the next caller waits forever.
    Promise.resolve()
      .then(() => client.createPaymentPayload(paymentRequired))
      .then(paymentPayload => {
        deferred.resolve(remember(key, paymentPayload));
      })
      .catch(error => {
        deferred.reject(error);
      })
      .finally(() => {
        if (inflight.get(key) === created) {
          inflight.delete(key);
        }
      });

    return created;
  };

  const trackedPayload = async (
    key: string,
    paymentRequired: PaymentRequired,
  ): Promise<{ paymentPayload: PaymentPayload; represented: boolean; hold: HeldPayment }> => {
    const prior = held.get(key);
    if (prior) {
      const released = await releaseIfProvenUnsettled(key, prior);
      if (!released) {
        const current = held.get(key);
        if (current) {
          return { paymentPayload: current.paymentPayload, represented: true, hold: current };
        }
      }
    }
    const joined = inflight.get(key);
    const hold = await (joined ?? startPayload(key, paymentRequired));
    return { paymentPayload: hold.paymentPayload, represented: false, hold };
  };

  const purchaseKey = (config: InternalAxiosRequestConfig): string | null => {
    const body = stableRequestBody(config.data);
    if (body == null) {
      return null;
    }
    const method = (config.method ?? "GET").toUpperCase();
    let url = config.url ?? "";
    try {
      url = axiosInstance.getUri(config);
    } catch {
      // Keep the raw URL when Axios cannot serialize this config.
    }
    return JSON.stringify([method, url, body]);
  };

  const applyPayment = (
    config: InternalAxiosRequestConfig,
    paymentPayload: PaymentPayload,
  ): X402RetryConfig => {
    const paidConfig = createX402RetryConfig(config);
    paidConfig.__is402Retry = true;
    for (const [name, value] of Object.entries(
      httpClient.encodePaymentSignatureHeader(paymentPayload),
    )) {
      setAxiosHeader(paidConfig.headers, name, value);
    }
    setAxiosHeader(
      paidConfig.headers,
      "Access-Control-Expose-Headers",
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
    return paidConfig;
  };

  const failedCreate = (paymentError: unknown): Error =>
    new Error(
      `Failed to create payment payload: ${paymentError instanceof Error ? paymentError.message : "Unknown error"}`,
    );

  axiosInstance.interceptors.response.use(
    response => {
      if (response.status === 402) {
        assertAxiosResponseBodyWithinLimit(response.data);
      }
      return response;
    },
    async (error: AxiosError) => {
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      const originalConfig = error.config;
      if (!originalConfig || !originalConfig.headers) {
        return Promise.reject(new Error("Missing axios request configuration"));
      }

      // Check if this is already a retry to prevent infinite loops
      if ((originalConfig as X402RetryConfig).__is402Retry) {
        assertAxiosResponseBodyWithinLimit(error.response.data);
        return Promise.reject(error);
      }

      try {
        const response = error.response;
        assertAxiosResponseBodyWithinLimit(response.data);

        // Parse payment requirements from response
        let paymentRequired: PaymentRequired;
        try {
          const getHeader = (name: string) => headerValue(response.headers, name);
          const body = response.data as PaymentRequired | undefined;
          paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
        } catch (parseError) {
          return Promise.reject(
            new Error(
              `Failed to parse payment requirements: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
            ),
          );
        }

        // Run payment required hooks
        const requestUrl = resolveAxiosRequestUrl(originalConfig, axiosInstance, error.response);
        const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired, requestUrl);
        if (hookHeaders) {
          const hookConfig = createX402RetryConfig(originalConfig);
          Object.entries(hookHeaders).forEach(([name, value]) => {
            setAxiosHeader(hookConfig.headers, name, value);
          });
          const hookResponse = await axiosInstance.request(hookConfig);
          if (hookResponse.status !== 402) {
            return hookResponse; // Hook succeeded
          }
          assertAxiosResponseBodyWithinLimit(hookResponse.data);
          // Hook's retry got 402, fall through to payment
        }

        const key = purchaseKey(originalConfig);
        let paymentPayload: PaymentPayload;
        let represented = false;
        let trackedHold: HeldPayment | undefined;
        if (key == null) {
          try {
            paymentPayload = await client.createPaymentPayload(paymentRequired);
          } catch (paymentError) {
            throw failedCreate(paymentError);
          }
        } else {
          try {
            const tracked = await trackedPayload(key, paymentRequired);
            paymentPayload = tracked.paymentPayload;
            represented = tracked.represented;
            trackedHold = tracked.hold;
          } catch (paymentError) {
            if (
              paymentError instanceof PaymentHoldCapacityError ||
              paymentError instanceof PaymentOutcomeUnknownError
            ) {
              throw paymentError;
            }
            throw failedCreate(paymentError);
          }
        }

        const paidConfig = applyPayment(originalConfig, paymentPayload);
        let secondResponse;
        try {
          secondResponse = await axiosInstance.request(paidConfig);
        } catch (sendError) {
          if (represented && key != null && held.get(key) === trackedHold) {
            throw new PaymentOutcomeUnknownError(paymentPayload, responseView(sendError));
          }
          throw sendError;
        }
        if (secondResponse.status === 402) {
          assertAxiosResponseBodyWithinLimit(secondResponse.data);
        }

        const result = await httpClient.processPaymentResult(
          paymentPayload,
          name => headerValue(secondResponse.headers, name),
          secondResponse.status,
        );

        if (result.recovered) {
          // The hook may retry the request. It does not prove the sent payment
          // never settled, so a tracked purchase re-presents that same payload.
          // An unkeyed body has no hold, so that recovery still signs once more.
          const retryPayload =
            key == null
              ? await client.createPaymentPayload(paymentRequired).catch(paymentError => {
                  throw failedCreate(paymentError);
                })
              : paymentPayload;
          const retryConfig = applyPayment(originalConfig, retryPayload);
          let retryResponse;
          try {
            retryResponse = await axiosInstance.request(retryConfig);
          } catch (sendError) {
            if (represented && key != null && held.get(key) === trackedHold) {
              throw new PaymentOutcomeUnknownError(paymentPayload, responseView(sendError));
            }
            throw sendError;
          }
          if (retryResponse.status === 402) {
            assertAxiosResponseBodyWithinLimit(retryResponse.data);
          }
          await httpClient.processPaymentResult(
            retryPayload,
            name => headerValue(retryResponse.headers, name),
            retryResponse.status,
          );
          if (retryResponse.status < 400 && key != null) {
            // An older response must never release a newer purchase generation.
            if (held.get(key) === trackedHold) {
              held.delete(key);
            }
            return retryResponse;
          }
          if (represented && key != null && held.get(key) === trackedHold) {
            throw new PaymentOutcomeUnknownError(paymentPayload, responseView(retryResponse));
          }
          return retryResponse;
        }

        if (secondResponse.status < 400) {
          if (key != null && held.get(key) === trackedHold) {
            held.delete(key);
          }
          return secondResponse;
        }

        if (represented && key != null && held.get(key) === trackedHold) {
          throw new PaymentOutcomeUnknownError(paymentPayload, responseView(secondResponse));
        }

        return secondResponse;
      } catch (retryError) {
        return Promise.reject(retryError);
      }
    },
  );

  return axiosInstance;
}

/**
 * Wraps an Axios instance with x402 payment handling using a configuration object.
 *
 * @param axiosInstance - The Axios instance to wrap
 * @param config - Configuration options including scheme registrations and selectors
 * @returns The wrapped Axios instance that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { wrapAxiosWithPaymentFromConfig } from '@x402/axios';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const account = privateKeyToAccount('0x...');
 *
 * const api = wrapAxiosWithPaymentFromConfig(axios.create(), {
 *   schemes: [
 *     { network: 'eip155:*', client: new ExactEvmScheme(account) }
 *   ]
 * });
 *
 * const response = await api.get('https://api.example.com/paid-endpoint');
 * ```
 */
export function wrapAxiosWithPaymentFromConfig(
  axiosInstance: AxiosInstance,
  config: x402ClientConfig,
): AxiosInstance {
  const client = x402Client.fromConfig(config);
  return wrapAxiosWithPayment(axiosInstance, client);
}

// Re-export types and utilities for convenience
export { x402Client, x402HTTPClient } from "@x402/core/client";
export type {
  HTTPResourceResponse,
  PaymentPolicy,
  SchemeRegistration,
  SelectPaymentRequirements,
  x402ClientConfig,
} from "@x402/core/client";
export { decodePaymentResponseHeader, ResponseBodyTooLargeError } from "@x402/core/http";
export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
