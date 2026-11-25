import { afterEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("undici", async (importOriginal) => {
  const original = await importOriginal<typeof import("undici")>();
  return { ...original, request: requestMock };
});

import { postOpenAiChatJsonWithLongTimeout } from "@/lib/server/long-json-request";

afterEach(() => {
  requestMock.mockReset();
});

describe("non-streaming board LLM request", () => {
  it("uses a long-lived Undici connection and explicitly disables streaming", async () => {
    requestMock.mockResolvedValue({
      statusCode: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { text: vi.fn().mockResolvedValue(JSON.stringify({
        choices: [{ message: { content: "complete result" } }],
      })) },
    });

    const result = await postOpenAiChatJsonWithLongTimeout(
      "https://api.example.test/v1/chat/completions",
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "test" }] },
      { Authorization: "Bearer test" },
      10_000,
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      payload: { choices: [{ message: { content: "complete result" } }] },
    });
    const init = requestMock.mock.calls[0]?.[1] as { body?: string; headers?: Record<string, string>; headersTimeout?: number; bodyTimeout?: number };
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: false, model: "gpt-5.6-sol" });
    expect(init.headers).toMatchObject({ Accept: "application/json", Authorization: "Bearer test" });
    expect(init).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
  });

  it("retries once with a fresh connection when TLS failed before the request was sent", async () => {
    requestMock
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockResolvedValueOnce({
        statusCode: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: "complete after retry" } }],
        })) },
      });
    const onRetry = vi.fn();

    const result = await postOpenAiChatJsonWithLongTimeout(
      "https://api.example.test/v1/chat/completions",
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "test" }] },
      { Authorization: "Bearer test" },
      10_000,
      { onRetry, retryDelayMs: 0 },
    );

    expect(result.ok).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2,
      maxAttempts: 4,
      reason: expect.stringContaining("before secure TLS connection was established"),
    }));
  });

  it("does not retry an ambiguous disconnect before response headers", async () => {
    requestMock.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(postOpenAiChatJsonWithLongTimeout(
      "https://api.example.test/v1/chat/completions",
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "test" }] },
      { Authorization: "Bearer test" },
      10_000,
      { retryDelayMs: 0 },
    )).rejects.toThrow("socket hang up");

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry after response headers have been received", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { text: vi.fn().mockRejectedValue(new Error("Client network socket disconnected before secure TLS connection was established")) },
    });

    await expect(postOpenAiChatJsonWithLongTimeout(
      "https://api.example.test/v1/chat/completions",
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "test" }] },
      { Authorization: "Bearer test" },
      10_000,
      { retryDelayMs: 0 },
    )).rejects.toThrow("while waiting for body");

    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
