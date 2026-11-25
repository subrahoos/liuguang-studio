import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ insert: mocks.insert }),
}));

vi.mock("@/lib/db/schema", () => ({
  authUsers: {},
  modelApiCalls: {},
}));

import { auditModelApiCall, normalizeModelApiUsage } from "@/lib/model-api-audit";

const context = {
  userId: "user-001",
  callType: "llm" as const,
  providerKey: "openai-compatible",
  channelId: "llm-default",
  channelName: "LLM",
  model: "gpt-test",
  source: "test.audit",
};

describe("model API audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.values.mockResolvedValue(undefined);
  });

  it("keeps only explicitly allowed numeric usage fields", () => {
    expect(normalizeModelApiUsage({
      prompt_tokens: 12.9,
      completion_tokens: 34,
      total_tokens: "46",
      prompt: "must not be retained",
      api_key: "must not be retained",
    })).toEqual({
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
      values: {
        prompt_tokens: 12,
        completion_tokens: 34,
        total_tokens: 46,
      },
    });
  });

  it("redacts a provider failure before writing it to the database", async () => {
    const upstreamError = Object.assign(
      new Error("401 Authorization: Bearer sk-sensitive-key, prompt=private prompt"),
      { code: "API_ERROR", status: 401 },
    );

    await expect(auditModelApiCall(context, async () => {
      throw upstreamError;
    })).rejects.toBe(upstreamError);

    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      httpStatus: 401,
      errorCode: "API_ERROR",
      errorMessage: "模型服务返回请求错误。",
    }));
    expect(JSON.stringify(mocks.values.mock.calls[0][0])).not.toContain("sk-sensitive-key");
    expect(JSON.stringify(mocks.values.mock.calls[0][0])).not.toContain("private prompt");
  });

  it("marks a completed non-2xx result as an error without interrupting fallback handling", async () => {
    const result = await auditModelApiCall(context, async () => ({ ok: false, status: 429 }), {
      toResult: (value) => ({ httpStatus: value.status }),
      toError: (value) => value.ok ? undefined : { errorCode: "API_ERROR" },
    });

    expect(result).toEqual({ ok: false, status: 429 });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      httpStatus: 429,
      errorCode: "API_ERROR",
      errorMessage: "模型服务请求失败。",
    }));
  });
});
