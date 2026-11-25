import http from "http";
import https from "https";
import { Agent, EnvHttpProxyAgent, request as undiciRequest } from "undici";

export type LongJsonResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
  raw: string;
};

export type LongJsonResponseHeaders = {
  status: number;
  statusText: string;
  contentLength: string;
  requestId: string;
};

export type LongJsonRetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
};

type LongJsonRequestOptions = {
  onResponseHeaders?: (headers: LongJsonResponseHeaders) => void | Promise<void>;
  onRetry?: (info: LongJsonRetryInfo) => void | Promise<void>;
  retryDelayMs?: number;
};

// A TLS disconnect before response headers means the request did not reach the
// model. A few exponential retries are safe and help when a proxy/CF route
// briefly resets a new connection.
const MAX_DEFINITELY_UNSENT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function hasConfiguredOutboundProxy() {
  return Boolean(
    process.env.http_proxy?.trim()
      || process.env.HTTP_PROXY?.trim()
      || process.env.https_proxy?.trim()
      || process.env.HTTPS_PROXY?.trim()
      || process.env.all_proxy?.trim()
      || process.env.ALL_PROXY?.trim(),
  );
}

function longJsonDispatcher() {
  const options = {
    connectTimeout: 60_000,
    headersTimeout: 0,
    bodyTimeout: 0,
  };
  // undici.request does not automatically inherit Node's environment-proxy
  // support. Use the same HTTP(S)_PROXY settings supplied by the 3100 launcher.
  return hasConfiguredOutboundProxy()
    ? new EnvHttpProxyAgent(options)
    : new Agent(options);
}

function responseHeaderValue(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value || "";
}

function requestErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return causeMessage && causeMessage !== error.message
    ? `${error.message} (${causeMessage})`
    : error.message;
}

function isDefinitelyUnsentConnectionError(error: unknown) {
  const message = requestErrorMessage(error);
  return [
    /before secure TLS connection was established/i,
    /\bUND_ERR_CONNECT_TIMEOUT\b/i,
    /\bConnect Timeout Error\b/i,
    /\bconnect ECONNREFUSED\b/i,
    /\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN)\b/i,
    /\bconnect (?:ENETUNREACH|EHOSTUNREACH)\b/i,
  ].some((pattern) => pattern.test(message));
}

function retryDelay(ms: number, signal: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Request aborted during retry delay."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function postJsonWithLongTimeout(
  urlString: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 0,
): Promise<LongJsonResponse> {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  const client = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const requestOptions: http.RequestOptions | https.RequestOptions = {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": headers["Content-Type"] || "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Accept": headers.Accept || "application/json",
        "Connection": headers.Connection || "close",
      },
    };
    if (timeoutMs > 0) requestOptions.timeout = timeoutMs;

    const req = client.request(
      url,
      requestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          resolve({
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            payload: parsed,
            raw,
          });
        });
      },
    );

    if (timeoutMs > 0) {
      req.on("timeout", () => {
        req.destroy(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s before completion.`));
      });
    }
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Non-streaming Chat Completions request for long board-workflow results.
 * This deliberately matches the transport used by the LLM capability tests:
 * native fetch, a complete JSON response, and no SSE connection to keep alive.
 */
export async function postOpenAiChatJsonWithLongTimeout(
  urlString: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
  timeoutMs = 0,
  options: LongJsonRequestOptions = {},
): Promise<LongJsonResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const maxAttempts = MAX_DEFINITELY_UNSENT_RETRIES + 1;
  const safeRetryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : null;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const dispatcher = longJsonDispatcher();
      let responsePhase: "headers" | "body" = "headers";
      try {
        // Node fetch applies a fixed five-minute response-header deadline. Long,
        // non-streaming LLM calls may legitimately exceed it before returning the
        // first byte, so use Undici with that internal deadline disabled.
        const response = await undiciRequest(urlString, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": headers["Content-Type"] || "application/json",
            "Accept": headers.Accept || "application/json",
          },
          body: JSON.stringify({ ...payload, stream: false }),
          signal: controller.signal,
          headersTimeout: 0,
          bodyTimeout: 0,
          dispatcher,
        });
        responsePhase = "body";
        try {
          await options.onResponseHeaders?.({
            status: response.statusCode,
            statusText: response.statusText || "",
            contentLength: responseHeaderValue(response.headers, "content-length"),
            requestId: responseHeaderValue(response.headers, "x-request-id")
              || responseHeaderValue(response.headers, "x-correlation-id"),
          });
        } catch {
          // Diagnostics must never invalidate an otherwise successful model result.
        }
        const raw = await response.body.text();
        let parsed: unknown = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = { raw };
        }
        return {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          statusText: response.statusText || "",
          payload: parsed,
          raw,
        };
      } catch (error) {
        if (timedOut || controller.signal.aborted) {
          throw new Error(`LLM non-stream request timed out after ${Math.round(timeoutMs / 1000)}s while waiting for ${responsePhase}.`);
        }
        const retryable = responsePhase === "headers"
          && attempt < maxAttempts
          && isDefinitelyUnsentConnectionError(error);
        if (!retryable) {
          const retrySuffix = attempt > 1 ? ` after ${attempt - 1} safe retry` : "";
          throw new Error(`LLM non-stream request failed${retrySuffix} while waiting for ${responsePhase}: ${requestErrorMessage(error)}`);
        }
        const retryDelayForAttempt = safeRetryDelayMs * (2 ** (attempt - 1));
        try {
          await options.onRetry?.({
            attempt: attempt + 1,
            maxAttempts,
            delayMs: retryDelayForAttempt,
            reason: requestErrorMessage(error),
          });
        } catch {
          // Diagnostics must never block a retry that is known to be safe.
        }
        await retryDelay(retryDelayForAttempt, controller.signal);
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
    }
    throw new Error("LLM non-stream request exhausted its safe retry budget.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function extractLongJsonError(result: LongJsonResponse) {
  const payload = result.payload as { error?: { message?: string } | string; message?: string; raw?: string };
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message || payload.message || payload.raw || result.raw || `${result.status} ${result.statusText}`;
}
