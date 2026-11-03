import axios, {
  AxiosError,
  AxiosHeaders,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaymentHoldCapacityError,
  PaymentOutcomeUnknownError,
  wrapAxiosWithPayment,
  wrapAxiosWithPaymentFromConfig,
} from "./index";
import type { x402Client, x402ClientConfig } from "@x402/core/client";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, ResponseBodyTooLargeError } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

// Mock the @x402/core/client module
vi.mock("@x402/core/client", () => {
  const MockX402HTTPClient = vi.fn();
  MockX402HTTPClient.prototype.getPaymentRequiredResponse = vi.fn();
  MockX402HTTPClient.prototype.encodePaymentSignatureHeader = vi.fn();
  MockX402HTTPClient.prototype.handlePaymentRequired = vi.fn();
  MockX402HTTPClient.prototype.processPaymentResult = vi.fn();

  const MockX402Client = vi.fn() as ReturnType<typeof vi.fn> & {
    fromConfig: ReturnType<typeof vi.fn>;
  };
  MockX402Client.prototype.createPaymentPayload = vi.fn();
  MockX402Client.fromConfig = vi.fn();

  return {
    x402HTTPClient: MockX402HTTPClient,
    x402Client: MockX402Client,
  };
});

describe("wrapAxiosWithPayment()", () => {
  let mockAxiosClient: AxiosInstance;
  let mockClient: x402Client;
  let interceptor: (error: AxiosError) => Promise<AxiosResponse>;

  const validPaymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        extra: {},
      } as PaymentRequirements,
    ],
  };

  const validPaymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: validPaymentRequired.resource,
    accepted: validPaymentRequired.accepts[0],
    payload: { signature: "0xmocksignature" },
  };

  const createErrorConfig = (isRetry = false): InternalAxiosRequestConfig =>
    ({
      headers: new AxiosHeaders(),
      url: "https://api.example.com",
      method: "GET",
      ...(isRetry ? { __is402Retry: true } : {}),
    }) as InternalAxiosRequestConfig;

  const createAxiosError = (
    status: number,
    config?: InternalAxiosRequestConfig,
    data?: PaymentRequired | Uint8Array | string,
    headers?: Record<string, string>,
  ): AxiosError => {
    return new AxiosError(
      "Error",
      "ERROR",
      config,
      {},
      {
        status,
        statusText: status === 402 ? "Payment Required" : "Not Found",
        data,
        headers: headers || {},
        config: config || createErrorConfig(),
      },
    );
  };

  const createAxiosResponse = (
    status: number,
    data?: unknown,
    headers?: Record<string, string>,
  ): AxiosResponse =>
    ({
      status,
      statusText: status === 402 ? "Payment Required" : "OK",
      data,
      headers: headers || {},
      config: createErrorConfig(),
    }) as AxiosResponse;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Mock axios client
    mockAxiosClient = {
      interceptors: {
        response: {
          use: vi.fn(),
        },
      },
      request: vi.fn(),
      getUri: axios.getUri,
    } as unknown as AxiosInstance;

    // Create mock client
    const { x402Client: MockX402Client, x402HTTPClient: MockX402HTTPClient } = await import(
      "@x402/core/client"
    );

    mockClient = new MockX402Client() as unknown as x402Client;

    // Setup default mock implementations
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      validPaymentPayload,
    );

    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockReturnValue(validPaymentRequired);
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      "PAYMENT-SIGNATURE": "encoded-payment-header",
    });
    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ recovered: false });

    // Set up the interceptor
    wrapAxiosWithPayment(mockAxiosClient, mockClient);
    interceptor = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
  });

  it("should return the axios client instance", () => {
    const result = wrapAxiosWithPayment(mockAxiosClient, mockClient);
    expect(result).toBe(mockAxiosClient);
  });

  it("should set up response interceptor", () => {
    expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalled();
  });

  it("should pass through successful responses", async () => {
    const successHandler = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    const response = { status: 200, data: "success" } as AxiosResponse;
    expect(successHandler(response)).toBe(response);
  });

  it("should not handle non-402 errors", async () => {
    const error = createAxiosError(404);
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should not handle errors without response", async () => {
    const error = new AxiosError("Network Error", "ECONNREFUSED");
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should handle 402 errors and retry with payment header", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = { data: "success" } as AxiosResponse;

    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired, {
      "PAYMENT-REQUIRED": "encoded-payment-required",
    });

    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(validPaymentRequired);
    expect(MockX402HTTPClient.prototype.encodePaymentSignatureHeader).toHaveBeenCalledWith(
      validPaymentPayload,
    );
    expect(mockAxiosClient.request).toHaveBeenCalled();

    // Verify the retry config has payment headers and retry flag
    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.__is402Retry).toBe(true);
  });

  it("keeps a Cookie array so Axios can join it with semicolons on the paid retry", async () => {
    const successResponse = { data: "success" } as AxiosResponse;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const config = createErrorConfig();
    config.headers.set("Cookie", ["session=demo", "locale=zh"]);
    config.headers.set("X-Trace", "keep-me");

    await interceptor(createAxiosError(402, config, validPaymentRequired));

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers.Cookie).toEqual(["session=demo", "locale=zh"]);
    expect(retryConfig.headers["X-Trace"]).toBe("keep-me");
    expect(retryConfig.headers["PAYMENT-SIGNATURE"]).toBe("encoded-payment-header");
  });

  it("keeps empty Cookie array elements so the paid retry matches native join", async () => {
    const successResponse = { data: "success" } as AxiosResponse;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const config = createErrorConfig();
    config.headers.set("Cookie", ["", "locale=zh"]);

    await interceptor(createAxiosError(402, config, validPaymentRequired));

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers.Cookie).toEqual(["", "locale=zh"]);
  });

  it("keeps an empty Cookie array so it still overrides an instance default", async () => {
    const successResponse = { data: "success" } as AxiosResponse;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const config = createErrorConfig();
    config.headers.set("Cookie", []);

    await interceptor(createAxiosError(402, config, validPaymentRequired));

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers.Cookie).toEqual([]);
  });

  it("should not retry if already retried", async () => {
    const error = createAxiosError(402, createErrorConfig(true), validPaymentRequired);
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should reject if missing request config", async () => {
    const error = createAxiosError(402, undefined, validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow("Missing axios request configuration");
  });

  it("should reject if missing headers in config", async () => {
    const configWithoutHeaders = {
      url: "https://api.example.com",
      method: "GET",
    } as InternalAxiosRequestConfig;

    const error = createAxiosError(402, configWithoutHeaders, validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow("Missing axios request configuration");
  });

  it("should reject with descriptive error if payment requirements parsing fails", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error("Invalid payment header format");
    });

    const error = createAxiosError(402, createErrorConfig(), undefined);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to parse payment requirements: Invalid payment header format",
    );
  });

  it("should reject with descriptive error if payment payload creation fails", async () => {
    const paymentError = new Error("Insufficient funds");
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockRejectedValue(paymentError);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to create payment payload: Insufficient funds",
    );
  });

  it("should reject with generic error message for unknown parsing errors", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw "String error"; // Non-Error thrown
    });

    const error = createAxiosError(402, createErrorConfig(), undefined);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to parse payment requirements: Unknown error",
    );
  });

  it("should reject with generic error message for unknown payment creation errors", async () => {
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockRejectedValue("String error");

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to create payment payload: Unknown error",
    );
  });

  it("should handle v1 payment responses from body", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = { data: "success" } as AxiosResponse;

    const v1PaymentRequired: PaymentRequired = {
      ...validPaymentRequired,
      x402Version: 1,
    };

    const v1PaymentPayload: PaymentPayload = {
      ...validPaymentPayload,
      x402Version: 1,
    };

    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockReturnValue(v1PaymentRequired);
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      "X-PAYMENT": "v1-payment-header",
    });
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      v1PaymentPayload,
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), v1PaymentRequired);

    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.encodePaymentSignatureHeader).toHaveBeenCalledWith(
      v1PaymentPayload,
    );
  });

  it("should propagate retry errors", async () => {
    const retryError = new Error("Retry failed");
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockRejectedValue(retryError);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);

    await expect(interceptor(error)).rejects.toBe(retryError);
  });

  it("should set Access-Control-Expose-Headers on retry request", async () => {
    const successResponse = { data: "success" } as AxiosResponse;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);

    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers["Access-Control-Expose-Headers"]).toBe(
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
  });

  it("should clone retry headers into a serializable record", async () => {
    /**
     * Minimal axios-like headers object with a Map-backed set and JSON serialization.
     */
    class CallerAxiosHeaders {
      private readonly values = new Map<string, string>();

      /**
       * Stores a header name/value pair.
       *
       * @param key - Header name
       * @param value - Header value
       */
      set(key: string, value: string): void {
        this.values.set(key, value);
      }

      /**
       * Returns headers as a plain object for JSON-style cloning.
       *
       * @returns Header entries as a string record
       */
      toJSON(): Record<string, string> {
        return Object.fromEntries(this.values);
      }
    }

    const successResponse = { data: "success" } as AxiosResponse;
    const config = createErrorConfig();
    const callerHeaders = new CallerAxiosHeaders();
    callerHeaders.set("Accept", "application/json");
    config.headers = callerHeaders as unknown as InternalAxiosRequestConfig["headers"];
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, config, validPaymentRequired);
    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers).not.toBeInstanceOf(CallerAxiosHeaders);
    expect(retryConfig.headers).not.toBe(callerHeaders);
    expect(retryConfig.headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        "PAYMENT-SIGNATURE": "encoded-payment-header",
      }),
    );
    expect(Object.values(retryConfig.headers).some(value => typeof value === "function")).toBe(
      false,
    );
  });

  it("should re-present the held payload when a paid retry hook asks to recover", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "corrective-payment-required",
    });
    const successResponse = createAxiosResponse(
      200,
      { data: "success" },
      {
        "PAYMENT-RESPONSE": "settled",
      },
    );

    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      validPaymentPayload,
    );
    (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ recovered: true })
      .mockResolvedValueOnce({ recovered: false });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(correctiveResponse)
      .mockResolvedValueOnce(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(2);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenNthCalledWith(
      1,
      validPaymentPayload,
      expect.any(Function),
      402,
    );
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenNthCalledWith(
      2,
      validPaymentPayload,
      expect.any(Function),
      200,
    );
  });

  it("should return a corrective 402 paid retry when recovery does not run", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "corrective-payment-required",
    });

    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(correctiveResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(correctiveResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledWith(
      validPaymentPayload,
      expect.any(Function),
      402,
    );
  });

  it("should preserve caller validateStatus for non-402 retry statuses", async () => {
    const successResponse = createAxiosResponse(200, { data: "success" });
    const config = createErrorConfig();
    config.validateStatus = status => status === 409;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, config, validPaymentRequired);
    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.validateStatus(402)).toBe(true);
    expect(retryConfig.validateStatus(409)).toBe(true);
    expect(retryConfig.validateStatus(200)).toBe(false);
    expect(retryConfig.validateStatus(500)).toBe(false);
  });

  it("should fall through to paid retry when hook retry returns 402", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const hookResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "hook-payment-required",
    });
    const successResponse = createAxiosResponse(200, { data: "success" });

    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ "X-HOOK": "handled" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(hookResponse)
      .mockResolvedValueOnce(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    const hookConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const paidConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(hookConfig.validateStatus(402)).toBe(true);
    expect(hookConfig.headers["X-HOOK"]).toBe("handled");
    expect(paidConfig.headers["PAYMENT-SIGNATURE"]).toBe("encoded-payment-header");
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(validPaymentRequired);
  });

  it("rejects an oversized initial 402 response", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const oversizedBody = new Uint8Array(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), oversizedBody),
    ).catch(caught => caught as Error);

    expect(error).toBeInstanceOf(ResponseBodyTooLargeError);
    expect(mockAxiosClient.request).not.toHaveBeenCalled();
    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).not.toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("rejects an oversized auth-retry 402 response", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const oversizedBody = "x".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1);

    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ "X-HOOK": "handled" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createAxiosResponse(402, oversizedBody),
    );

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch(caught => caught as Error);

    expect(error).toBeInstanceOf(ResponseBodyTooLargeError);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("rejects an oversized paid-retry 402 response", async () => {
    const oversizedBody = "x".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1);
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createAxiosResponse(402, oversizedBody),
    );

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch(caught => caught as Error);

    expect(error).toBeInstanceOf(ResponseBodyTooLargeError);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized recovery 402 response", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const oversizedBody = "x".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1);

    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ recovered: true });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createAxiosResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(createAxiosResponse(402, oversizedBody));

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch(caught => caught as Error);

    expect(error).toBeInstanceOf(ResponseBodyTooLargeError);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized already-retried 402 error", async () => {
    const oversizedBody = "x".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1);
    const error = await interceptor(
      createAxiosError(402, createErrorConfig(true), oversizedBody),
    ).catch(caught => caught as Error);

    expect(error).toBeInstanceOf(ResponseBodyTooLargeError);
    expect(mockAxiosClient.request).not.toHaveBeenCalled();
  });

  it("caps a 402 on the success interceptor", async () => {
    const successHandler = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    const oversizedBody = "x".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1);

    expect(() => successHandler(createAxiosResponse(402, oversizedBody))).toThrow(
      ResponseBodyTooLargeError,
    );
  });

  it("should return immediately when hook retry succeeds with a non-402 status", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const hookResponse = createAxiosResponse(200, { data: "hook-success" });

    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ "X-HOOK": "handled" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(hookResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(hookResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
    const hookConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(hookConfig.headers["X-HOOK"]).toBe("handled");
  });

  it("should prefer the browser redirect URL when resolving the payment request URL", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    if (error.response) {
      error.response.request = { responseURL: "https://cdn.example.com/final" };
    }

    await interceptor(error);

    expect(MockX402HTTPClient.prototype.handlePaymentRequired).toHaveBeenCalledWith(
      validPaymentRequired,
      "https://cdn.example.com/final",
    );
  });

  it("should prefer the Node redirect URL when resolving the payment request URL", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    if (error.response) {
      error.response.request = { res: { responseUrl: "https://cdn.example.com/node-final" } };
    }

    await interceptor(error);

    expect(MockX402HTTPClient.prototype.handlePaymentRequired).toHaveBeenCalledWith(
      validPaymentRequired,
      "https://cdn.example.com/node-final",
    );
  });

  it("should resolve a relative url against baseURL", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const config = createErrorConfig();
    config.baseURL = "https://api.example.com/v1/";
    config.url = "paid";
    const error = createAxiosError(402, config, validPaymentRequired);

    await interceptor(error);

    expect(MockX402HTTPClient.prototype.handlePaymentRequired).toHaveBeenCalledWith(
      validPaymentRequired,
      "https://api.example.com/v1/paid",
    );
  });

  it("should fall back to url or baseURL when URL resolution fails", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const config = createErrorConfig();
    config.baseURL = "not-a-valid-base";
    config.url = "/paid";
    const error = createAxiosError(402, config, validPaymentRequired);

    await interceptor(error);

    expect(MockX402HTTPClient.prototype.handlePaymentRequired).toHaveBeenCalledWith(
      validPaymentRequired,
      "/paid",
    );
  });

  it("should fall back to baseURL when relative url is empty and resolution fails", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const config = createErrorConfig();
    config.baseURL = "not-a-valid-base";
    config.url = "";
    const error = createAxiosError(402, config, validPaymentRequired);

    await interceptor(error);

    expect(MockX402HTTPClient.prototype.handlePaymentRequired).toHaveBeenCalledWith(
      validPaymentRequired,
      "not-a-valid-base",
    );
  });

  it("should clone plain object headers that do not implement toJSON", async () => {
    const successResponse = createAxiosResponse(200, { data: "success" });
    const config = createErrorConfig();
    config.headers = {
      Accept: "application/json",
      skip: undefined,
      drop: null,
      compute: () => "nope",
    } as unknown as InternalAxiosRequestConfig["headers"];
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, config, validPaymentRequired);
    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        "PAYMENT-SIGNATURE": "encoded-payment-header",
      }),
    );
    expect(retryConfig.headers.skip).toBeUndefined();
    expect(retryConfig.headers.drop).toBeUndefined();
    expect(retryConfig.headers.compute).toBeUndefined();
  });

  it("should treat 200-299 as success and reject others when no validateStatus is set", async () => {
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.validateStatus(200)).toBe(true);
    expect(retryConfig.validateStatus(299)).toBe(true);
    expect(retryConfig.validateStatus(300)).toBe(false);
    expect(retryConfig.validateStatus(402)).toBe(true);
    expect(retryConfig.validateStatus(500)).toBe(false);
  });

  it("should look up payment-required headers case-insensitively and ignore non-strings", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(200, { data: "success" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);
    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockImplementation((getHeader: (name: string) => string | undefined) => {
      expect(getHeader("PAYMENT-REQUIRED")).toBe("encoded-from-lower");
      expect(getHeader("X-COUNT")).toBeUndefined();
      return validPaymentRequired;
    });

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired, {
      "payment-required": "encoded-from-lower",
    });
    if (error.response) {
      (error.response.headers as Record<string, unknown>)["x-count"] = 2;
    }

    await interceptor(error);

    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).toHaveBeenCalled();
  });

  it("should look up payment-response headers case-insensitively and ignore non-strings", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createAxiosResponse(
      200,
      { data: "success" },
      {
        "payment-response": "settled",
      },
    );
    (successResponse.headers as Record<string, unknown>)["x-count"] = 2;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async (
        _payload: PaymentPayload,
        getResponseHeader: (name: string) => string | undefined,
        status: number,
      ) => {
        expect(status).toBe(200);
        expect(getResponseHeader("PAYMENT-RESPONSE")).toBe("settled");
        expect(getResponseHeader("X-COUNT")).toBeUndefined();
        return { recovered: false };
      },
    );

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    await interceptor(error);

    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalled();
  });

  it("should look up recovery retry headers case-insensitively and ignore non-strings", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired);
    const retryResponse = createAxiosResponse(
      200,
      { data: "success" },
      {
        "payment-response": "recovered",
      },
    );
    (retryResponse.headers as Record<string, unknown>)["x-count"] = 2;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(correctiveResponse)
      .mockResolvedValueOnce(retryResponse);
    (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ recovered: true })
      .mockImplementationOnce(
        async (
          _payload: PaymentPayload,
          getRetryHeader: (name: string) => string | undefined,
          status: number,
        ) => {
          expect(status).toBe(200);
          expect(getRetryHeader("PAYMENT-RESPONSE")).toBe("recovered");
          expect(getRetryHeader("X-COUNT")).toBeUndefined();
          return { recovered: false };
        },
      );

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(retryResponse);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(2);
  });

  // Maintainer regressions for the three purchase-hold corrections. The adapter
  // below is a browser-compatible fixture: it records the consumer path and
  // does not launch a browser or open a network.
  const payloadSignature = (payload: PaymentPayload): string => {
    const signature = payload.payload.signature;
    return typeof signature === "string" ? signature : "";
  };

  const dispatchAdapter = (
    config: InternalAxiosRequestConfig,
    response: AxiosResponse,
  ): AxiosResponse => {
    const validateStatus = config.validateStatus;
    if (!response.status || !validateStatus || validateStatus(response.status)) {
      return response;
    }
    throw new AxiosError(
      `Request failed with status code ${response.status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      {},
      response,
    );
  };

  const retainNewerPurchase = async (useRecovery: boolean): Promise<void> => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    let nextId = 0;
    let releaseCreate = (): void => undefined;
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      nextId += 1;
      const payload: PaymentPayload = {
        ...validPaymentPayload,
        payload: { signature: `0x${nextId}` },
      };
      if (nextId === 1) {
        await createGate;
      }
      return payload;
    });
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockImplementation((payload: PaymentPayload) => ({
      "PAYMENT-SIGNATURE": `pay-${payloadSignature(payload)}`,
    }));
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockImplementation(async (_payload: PaymentPayload, _header: unknown, status: number) => ({
      recovered: useRecovery && status === 402,
    }));

    const hookWaiters: Array<(value: null) => void> = [];
    let gateHooks = true;
    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockImplementation(
      () =>
        new Promise(resolve => {
          if (!gateHooks) {
            resolve(null);
            return;
          }
          hookWaiters.push(resolve);
        }),
    );

    const paid: Array<{ payment: string; release: (status: number) => void }> = [];
    const api = wrapAxiosWithPayment(
      axios.create({
        baseURL: "https://api.example.com",
        adapter: async (config: InternalAxiosRequestConfig) => {
          const raw = config.headers.get("PAYMENT-SIGNATURE");
          const payment = typeof raw === "string" ? raw : "";
          const respond = (status: number): AxiosResponse =>
            ({
              data: status === 402 ? validPaymentRequired : status < 400 ? "ok" : "ambiguous",
              status,
              statusText: String(status),
              headers: status === 402 ? { "PAYMENT-REQUIRED": "encoded-payment-required" } : {},
              config,
              request: {},
            }) as AxiosResponse;
          if (payment.length === 0) {
            return dispatchAdapter(config, respond(402));
          }
          let released = false;
          let resolveStatus: (status: number) => void = () => undefined;
          const gate = new Promise<number>(resolve => {
            resolveStatus = resolve;
          });
          paid.push({
            payment,
            release: status => {
              if (released) {
                return;
              }
              released = true;
              resolveStatus(status);
            },
          });
          return dispatchAdapter(config, respond(await gate));
        },
      }),
      mockClient,
    );

    const pending: Array<Promise<unknown>> = [];
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.push(
        promise.then(
          () => undefined,
          () => undefined,
        ),
      );
      return promise;
    };
    const settle = async (
      pendingCall: Promise<AxiosResponse>,
    ): Promise<{ response?: AxiosResponse; error?: unknown }> => {
      try {
        return { response: await pendingCall };
      } catch (error) {
        return { error };
      }
    };

    const originals = [track(api.get("/item")), track(api.get("/item"))];
    try {
      await vi.waitFor(
        () => {
          expect(hookWaiters.length).toBe(2);
        },
        { timeout: 4000, interval: 10 },
      );
      gateHooks = false;
      for (const release of hookWaiters.splice(0, hookWaiters.length)) {
        release(null);
      }
      await vi.waitFor(
        () => {
          expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
        },
        { timeout: 4000, interval: 10 },
      );
      releaseCreate();
      await vi.waitFor(
        () => {
          expect(paid.length).toBe(2);
        },
        { timeout: 4000, interval: 10 },
      );

      const lateIndex = useRecovery ? 3 : 1;
      if (useRecovery) {
        paid[0].release(402);
        paid[1].release(402);
        await vi.waitFor(
          () => {
            expect(paid.length).toBe(4);
          },
          { timeout: 4000, interval: 10 },
        );
        paid[2].release(200);
      } else {
        paid[0].release(200);
      }

      const early = await Promise.race(originals.map(call => settle(call)));
      expect(early.response?.status).toBe(200);
      expect(paid[lateIndex].payment).toBe("pay-0x1");

      const newerPending = track(api.get("/item"));
      await vi.waitFor(
        () => {
          expect(paid.length).toBe(useRecovery ? 5 : 3);
        },
        { timeout: 4000, interval: 10 },
      );
      const newerSlot = paid[paid.length - 1];
      expect(newerSlot.payment).toBe("pay-0x2");
      newerSlot.release(500);
      const newer = await settle(newerPending);
      expect(newer.error).toBeInstanceOf(AxiosError);
      expect((newer.error as AxiosError).response?.status).toBe(500);
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);

      paid[lateIndex].release(200);
      const oldResults = await Promise.all(originals.map(call => settle(call)));
      expect(oldResults.map(result => result.response?.status)).toEqual([200, 200]);

      const retryPending = track(api.get("/item"));
      await vi.waitFor(
        () => {
          expect(paid.length).toBe(useRecovery ? 6 : 4);
        },
        { timeout: 4000, interval: 10 },
      );
      const retrySlot = paid[paid.length - 1];
      expect(retrySlot.payment).toBe("pay-0x2");
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
      retrySlot.release(500);
      const retried = await settle(retryPending);
      expect(retried.error).toBeInstanceOf(PaymentOutcomeUnknownError);
      expect(payloadSignature((retried.error as PaymentOutcomeUnknownError).paymentPayload)).toBe(
        "0x2",
      );
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
    } finally {
      gateHooks = false;
      for (const release of hookWaiters.splice(0, hookWaiters.length)) {
        release(null);
      }
      releaseCreate();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        for (const slot of paid) {
          slot.release(500);
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await Promise.allSettled(pending);
    }
  };

  it("retains the newer purchase when a late success arrives on the direct delivery path", async () => {
    await retainNewerPurchase(false);
  });

  it("retains the newer purchase when a late success arrives on the recovery delivery path", async () => {
    await retainNewerPurchase(true);
  });

  it("does not share a purchase between binary x and the literal text eA==", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    let nextId = 0;
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      nextId += 1;
      return {
        ...validPaymentPayload,
        payload: { signature: `0x${nextId}` },
      } as PaymentPayload;
    });
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockImplementation((payload: PaymentPayload) => ({
      "PAYMENT-SIGNATURE": `pay-${payloadSignature(payload)}`,
    }));

    const wire: string[] = [];
    const signatures: string[] = [];
    const api = wrapAxiosWithPayment(
      axios.create({
        baseURL: "https://api.example.com",
        adapter: async (config: InternalAxiosRequestConfig) => {
          const raw = config.headers.get("PAYMENT-SIGNATURE");
          const payment = typeof raw === "string" ? raw : "";
          if (payment.length > 0) {
            signatures.push(payment);
            wire.push(
              Buffer.isBuffer(config.data) ? config.data.toString("utf8") : String(config.data),
            );
          }
          const status = payment.length > 0 ? 500 : 402;
          return dispatchAdapter(config, {
            data: status === 402 ? validPaymentRequired : "ambiguous",
            status,
            statusText: String(status),
            headers: status === 402 ? { "PAYMENT-REQUIRED": "encoded-payment-required" } : {},
            config,
            request: {},
          } as AxiosResponse);
        },
      }),
      mockClient,
    );

    const headers = { "Content-Type": "application/octet-stream" };
    const settle = async (pendingCall: Promise<AxiosResponse>) => {
      try {
        return { response: await pendingCall, error: undefined };
      } catch (error) {
        return { response: undefined, error };
      }
    };
    const binary = await settle(api.post("/item", Buffer.from("x"), { headers }));
    const text = await settle(api.post("/item", "eA==", { headers }));
    const binaryAgain = await settle(api.post("/item", Buffer.from("x"), { headers }));

    expect(signatures).toEqual(["pay-0x1", "pay-0x2", "pay-0x1"]);
    expect(wire).toEqual(["x", "eA==", "x"]);
    expect(binary.error).toBeInstanceOf(AxiosError);
    expect((binary.error as AxiosError).response?.status).toBe(500);
    expect(text.error).toBeInstanceOf(AxiosError);
    expect(text.error).not.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect((text.error as AxiosError).response?.status).toBe(500);
    expect(binaryAgain.error).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(payloadSignature((binaryAgain.error as PaymentOutcomeUnknownError).paymentPayload)).toBe(
      "0x1",
    );
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);

    const verb = await settle(api.put("/item", "eA==", { headers }));
    expect(verb.error).toBeInstanceOf(AxiosError);
    expect(verb.error).not.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(3);

    const otherResource = await settle(api.post("/other", Buffer.from("x"), { headers }));
    expect(otherResource.error).toBeInstanceOf(AxiosError);
    expect(otherResource.error).not.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(4);
    expect(signatures.slice(3)).toEqual(["pay-0x3", "pay-0x4"]);

    const identity = [(data: unknown) => data];
    const encoded = await settle(
      api.post("/item", new URLSearchParams("a=1"), { headers, transformRequest: identity }),
    );
    const encodedAgain = await settle(
      api.post("/item", new URLSearchParams("a=1"), { headers, transformRequest: identity }),
    );
    const encodedText = await settle(
      api.post("/item", "a=1", { headers, transformRequest: identity }),
    );
    expect(encoded.error).toBeInstanceOf(AxiosError);
    expect((encoded.error as AxiosError).response?.status).toBe(500);
    expect(encodedAgain.error).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(
      payloadSignature((encodedAgain.error as PaymentOutcomeUnknownError).paymentPayload),
    ).toBe("0x5");
    expect(encodedText.error).toBeInstanceOf(AxiosError);
    expect(encodedText.error).not.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(6);

    const document = { a: 1 };
    const structured = await settle(
      api.post("/item", document, { headers, transformRequest: identity }),
    );
    const structuredAgain = await settle(
      api.post("/item", document, { headers, transformRequest: identity }),
    );
    const structuredText = await settle(
      api.post("/item", JSON.stringify(document), { headers, transformRequest: identity }),
    );
    expect(structured.error).toBeInstanceOf(AxiosError);
    expect(structuredAgain.error).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(
      payloadSignature((structuredAgain.error as PaymentOutcomeUnknownError).paymentPayload),
    ).toBe("0x7");
    expect(structuredText.error).toBeInstanceOf(AxiosError);
    expect(structuredText.error).not.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(8);
    expect(signatures.slice(5)).toEqual([
      "pay-0x5",
      "pay-0x5",
      "pay-0x6",
      "pay-0x7",
      "pay-0x7",
      "pay-0x8",
    ]);
  });

  it("keys ArrayBuffer and byte views without a global Buffer", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      validPaymentPayload,
    );
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockReturnValue({ "PAYMENT-SIGNATURE": "encoded-payment-header" });

    const observed: Array<{ bufferAbsent: boolean; bytes: number[]; paid: boolean }> = [];
    const byteList = (data: unknown): number[] => {
      if (data instanceof ArrayBuffer) {
        return [...new Uint8Array(data)];
      }
      if (ArrayBuffer.isView(data)) {
        return [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
      }
      return [];
    };
    const api = wrapAxiosWithPayment(
      axios.create({
        baseURL: "https://browser.invalid",
        adapter: async (config: InternalAxiosRequestConfig) => {
          const raw = config.headers.get("PAYMENT-SIGNATURE");
          const payment = typeof raw === "string" ? raw : "";
          observed.push({
            bufferAbsent: typeof globalThis.Buffer === "undefined",
            bytes: byteList(config.data),
            paid: payment.length > 0,
          });
          const status = payment.length > 0 ? 500 : 402;
          return dispatchAdapter(config, {
            data: status === 402 ? validPaymentRequired : "ambiguous",
            status,
            statusText: String(status),
            headers: status === 402 ? { "PAYMENT-REQUIRED": "encoded-payment-required" } : {},
            config,
            request: {},
          } as AxiosResponse);
        },
      }),
      mockClient,
    );

    const globalRecord = globalThis as { Buffer?: typeof Buffer };
    const originalBuffer = globalRecord.Buffer;
    const settle = async (pendingCall: Promise<AxiosResponse>) => {
      try {
        return { response: await pendingCall, error: undefined };
      } catch (error) {
        return { response: undefined, error };
      }
    };
    let first: { response?: AxiosResponse; error?: unknown };
    let second: { response?: AxiosResponse; error?: unknown };
    try {
      globalRecord.Buffer = undefined;
      const identity = [(data: unknown) => data];
      first = await settle(
        api.post("/item", Uint8Array.from([120]).buffer, {
          headers: { "Content-Type": "application/octet-stream" },
          transformRequest: identity,
        }),
      );
      const view = new Uint8Array(new Uint8Array([9, 120, 9]).buffer, 1, 1);
      second = await settle(
        api.post("/item", view, {
          headers: { "Content-Type": "application/octet-stream" },
          transformRequest: identity,
        }),
      );
    } finally {
      globalRecord.Buffer = originalBuffer;
    }

    expect(globalRecord.Buffer).toBe(originalBuffer);
    expect(first.error).toBeInstanceOf(AxiosError);
    expect((first.error as AxiosError).response?.status).toBe(500);
    expect(second.error).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(4);
    expect(observed.every(row => row.bufferAbsent)).toBe(true);
    expect(observed.every(row => JSON.stringify(row.bytes) === "[120]")).toBe(true);
    expect(observed.filter(row => row.paid)).toHaveLength(2);
  });

  const paidFailure = (): AxiosResponse => createAxiosResponse(500, "ambiguous");

  const callWith = (
    url: string,
    data?: unknown,
    config: Partial<InternalAxiosRequestConfig> = {},
  ): Promise<AxiosResponse> => {
    const requestConfig = createErrorConfig();
    requestConfig.url = url;
    requestConfig.method = config.method ?? requestConfig.method;
    if (data !== undefined) {
      requestConfig.data = data as InternalAxiosRequestConfig["data"];
    }
    if (config.baseURL) {
      requestConfig.baseURL = config.baseURL;
    }
    return interceptor(createAxiosError(402, requestConfig, validPaymentRequired));
  };

  it("counts another in-flight purchase when choosing whether a new purchase can be held", async () => {
    const releases: Array<(payload: PaymentPayload) => void> = [];
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<PaymentPayload>(resolve => {
          releases.push(resolve);
        }),
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(
      createAxiosResponse(200, "ok"),
    );

    const first = callWith("https://api.example.com/flight");
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    const second = callWith("https://api.example.com/other-flight");
    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    releases[0]({ ...validPaymentPayload, payload: { signature: "0xflight" } });
    await expect(first).resolves.toMatchObject({ status: 200 });
    releases[1]({ ...validPaymentPayload, payload: { signature: "0xother" } });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });

  it("refuses a new purchase at 1000 held payments instead of dropping one", async () => {
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(paidFailure());
    for (let index = 1; index <= 1000; index += 1) {
      const result = await callWith(`https://api.example.com/k/${index}`);
      expect(result.status).toBe(500);
    }
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1000);
    await expect(callWith("https://api.example.com/k/1")).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );
    await expect(callWith("https://api.example.com/k/1001")).rejects.toBeInstanceOf(
      PaymentHoldCapacityError,
    );
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1000);
  });

  it("releases a hold only after the window, the grace, and an unsettled reconcile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const reconcile = vi.fn(async () => "unsettled" as const);
    (
      mockClient as unknown as { reconcilePaymentPayload?: typeof reconcile }
    ).reconcilePaymentPayload = reconcile;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(paidFailure());
    try {
      await expect(callWith("https://api.example.com/release")).resolves.toMatchObject({
        status: 500,
      });
      await expect(callWith("https://api.example.com/release")).rejects.toBeInstanceOf(
        PaymentOutcomeUnknownError,
      );
      vi.setSystemTime(start.getTime() + 300_000 + 14_999);
      await expect(callWith("https://api.example.com/release")).rejects.toBeInstanceOf(
        PaymentOutcomeUnknownError,
      );
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
      vi.setSystemTime(start.getTime() + 300_000 + 15_000);
      await expect(callWith("https://api.example.com/release")).resolves.toMatchObject({
        status: 500,
      });
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the held payload when reconcile is missing, throws, settled, or not a known result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(paidFailure());
    const clientWithReconcile = mockClient as {
      reconcilePaymentPayload?: (payload: PaymentPayload) => Promise<unknown>;
    };
    try {
      await callWith("https://api.example.com/missing");
      vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
      await expect(callWith("https://api.example.com/missing")).rejects.toBeInstanceOf(
        PaymentOutcomeUnknownError,
      );

      const cases: Array<[string, () => Promise<unknown>]> = [
        ["https://api.example.com/throws", async () => Promise.reject(new Error("down"))],
        ["https://api.example.com/settled", async () => "settled"],
        ["https://api.example.com/unknown", async () => "unknown"],
        ["https://api.example.com/garbage", async () => "maybe"],
      ];
      for (const [url, implementation] of cases) {
        clientWithReconcile.reconcilePaymentPayload = implementation;
        await expect(callWith(url)).resolves.toMatchObject({ status: 500 });
        await expect(callWith(url)).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
      }
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1 + cases.length);
    } finally {
      delete clientWithReconcile.reconcilePaymentPayload;
      vi.useRealTimers();
    }
  });

  it("keeps a hold that has no numeric settlement window", async () => {
    const openPayload: PaymentPayload = {
      ...validPaymentPayload,
      accepted: { ...validPaymentRequired.accepts[0] },
    };
    delete (openPayload.accepted as { maxTimeoutSeconds?: number }).maxTimeoutSeconds;
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(openPayload);
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(paidFailure());
    (
      mockClient as unknown as { reconcilePaymentPayload?: () => Promise<string> }
    ).reconcilePaymentPayload = async () => "unsettled";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await expect(callWith("https://api.example.com/open")).resolves.toMatchObject({
        status: 500,
      });
      vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
      await expect(callWith("https://api.example.com/open")).rejects.toBeInstanceOf(
        PaymentOutcomeUnknownError,
      );
      expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    } finally {
      delete (mockClient as { reconcilePaymentPayload?: unknown }).reconcilePaymentPayload;
      vi.useRealTimers();
    }
  });

  it("does not key streams, FormData, or unstringifiable bodies, and signs a fresh unkeyed recovery", async () => {
    mockAxiosClient.getUri = config => config?.url ?? "";
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const unkeyed = [
      new FormData(),
      { pipe: () => undefined },
      new ReadableStream(),
      circular,
      Symbol("body"),
      { toJSON: () => undefined },
    ];
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(paidFailure());
    for (const body of unkeyed) {
      await expect(callWith("https://api.example.com/unsafe", body)).resolves.toMatchObject({
        status: 500,
      });
      await expect(callWith("https://api.example.com/unsafe", body)).resolves.toMatchObject({
        status: 500,
      });
    }
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(unkeyed.length * 2);

    const sameObject = { item: "x" };
    await expect(callWith("https://api.example.com/json", sameObject)).resolves.toMatchObject({
      status: 500,
    });
    await expect(callWith("https://api.example.com/json", sameObject)).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );
    await expect(callWith("https://api.example.com/number", 1)).resolves.toMatchObject({
      status: 500,
    });
    await expect(callWith("https://api.example.com/number", true)).resolves.toMatchObject({
      status: 500,
    });
    const params = new URLSearchParams("a=1");
    await expect(callWith("https://api.example.com/query", params)).resolves.toMatchObject({
      status: 500,
    });
    await expect(callWith("https://api.example.com/query", params)).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(unkeyed.length * 2 + 4);

    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createAxiosResponse(402, validPaymentRequired),
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createAxiosResponse(200, "ok"),
    );
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ recovered: true })
      .mockResolvedValueOnce({ recovered: false });
    const recovered = await callWith("https://api.example.com/form-recover", new FormData());
    expect(recovered.status).toBe(200);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(unkeyed.length * 2 + 6);

    let recoveryCreates = 0;
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      recoveryCreates += 1;
      if (recoveryCreates === 2) {
        throw new Error("fresh failed");
      }
      return validPaymentPayload;
    });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createAxiosResponse(402, validPaymentRequired),
    );
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ recovered: true });
    await expect(
      callWith("https://api.example.com/form-fresh-fails", new FormData()),
    ).rejects.toThrow("Failed to create payment payload: fresh failed");

    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(callWith("https://api.example.com/sync")).rejects.toThrow(
      "Failed to create payment payload: boom",
    );
    await expect(callWith("https://api.example.com/sync")).rejects.toThrow(
      "Failed to create payment payload: boom",
    );
  });

  it("keeps a represented purchase when the recovery retry is not delivered", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockImplementation(async (_payload: PaymentPayload, _header: unknown, status: number) => ({
      recovered: status === 402,
    }));
    const request = mockAxiosClient.request as ReturnType<typeof vi.fn>;
    request.mockResolvedValueOnce(paidFailure());
    await expect(callWith("https://api.example.com/recover-throw")).resolves.toMatchObject({
      status: 500,
    });
    request.mockResolvedValueOnce(createAxiosResponse(402, validPaymentRequired));
    request.mockRejectedValueOnce("network down");
    const thrown = await callWith("https://api.example.com/recover-throw").catch(
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect((thrown as PaymentOutcomeUnknownError).response).toBeUndefined();
    expect((thrown as PaymentOutcomeUnknownError).message).toContain("no response");

    request.mockResolvedValueOnce(paidFailure());
    await expect(callWith("https://api.example.com/recover-status")).resolves.toMatchObject({
      status: 500,
    });
    request.mockResolvedValueOnce(createAxiosResponse(402, validPaymentRequired));
    request.mockResolvedValueOnce(paidFailure());
    await expect(callWith("https://api.example.com/recover-status")).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );

    request.mockResolvedValueOnce(createAxiosResponse(402, validPaymentRequired));
    request.mockResolvedValueOnce(paidFailure());
    const unkeyed = await callWith("https://api.example.com/recover-unkeyed", new FormData());
    expect(unkeyed.status).toBe(500);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized ArrayBuffer and Blob payment bodies before creating a payload", async () => {
    const oversized = MAX_CONTROL_PLANE_RESPONSE_BYTES + 1;
    await expect(
      interceptor(
        createAxiosError(
          402,
          createErrorConfig(),
          new ArrayBuffer(oversized) as unknown as PaymentRequired,
        ),
      ),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    await expect(
      interceptor(
        createAxiosError(
          402,
          createErrorConfig(),
          new Blob([new Uint8Array(oversized)]) as unknown as PaymentRequired,
        ),
      ),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("keeps the caller URL when Axios cannot serialize the purchase", async () => {
    mockAxiosClient.getUri = () => {
      throw new Error("bad uri");
    };
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(paidFailure());
    await expect(
      callWith("https://api.example.com/raw", undefined, { baseURL: "https://api.example.com" }),
    ).resolves.toMatchObject({ status: 500 });
    await expect(
      callWith("https://api.example.com/raw", undefined, { baseURL: "https://api.example.com" }),
    ).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
    const config = createErrorConfig();
    delete (config as { url?: string }).url;
    config.baseURL = "https://api.example.com/base";
    await expect(
      interceptor(createAxiosError(402, config, validPaymentRequired)),
    ).resolves.toMatchObject({ status: 500 });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });
});

describe("wrapAxiosWithPaymentFromConfig()", () => {
  let mockAxiosClient: AxiosInstance;

  beforeEach(async () => {
    vi.resetAllMocks();

    mockAxiosClient = {
      interceptors: {
        response: {
          use: vi.fn(),
        },
      },
      request: vi.fn(),
    } as unknown as AxiosInstance;

    const { x402Client: MockX402Client } = await import("@x402/core/client");
    (MockX402Client.fromConfig as ReturnType<typeof vi.fn>).mockReturnValue(new MockX402Client());
  });

  it("should create client from config and wrap axios", async () => {
    const { x402Client: MockX402Client } = await import("@x402/core/client");

    const config: x402ClientConfig = {
      schemes: [],
    };

    const result = wrapAxiosWithPaymentFromConfig(mockAxiosClient, config);

    expect(MockX402Client.fromConfig).toHaveBeenCalledWith(config);
    expect(result).toBe(mockAxiosClient);
    expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalled();
  });

  it("should return the axios client instance", () => {
    const config: x402ClientConfig = {
      schemes: [],
    };

    const result = wrapAxiosWithPaymentFromConfig(mockAxiosClient, config);
    expect(result).toBe(mockAxiosClient);
  });
});
