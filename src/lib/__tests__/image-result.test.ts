// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  DEFAULT_IMAGE_REQUEST_TIMEOUT_MS,
  ImageResponseBodyIdleTimeoutError,
  normalizeOpenAICompatiblePath,
  OpenAISeedanceProvider,
  preferredOpenAIImageResult,
  readImageResponseBodyWithIdleTimeout,
} from "@/lib/providers/openai-seedance";
import {
  IMAGE_RESPONSE_BODY_IDLE_TIMEOUT_MS,
  IMAGE_RESPONSE_BODY_TIMEOUT_MS,
} from "@/lib/image-generation-policy";

describe("OpenAI image result transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always prefers Base64 when the upstream returns both Base64 and URL", () => {
    const result = preferredOpenAIImageResult({
      url: "https://example.com/temporary-image.png",
      b64_json: "iVBORw0KGgo=",
    });
    expect(result.transport).toBe("b64_json");
    expect(result.value).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("uses URL only when Base64 is not present", () => {
    expect(preferredOpenAIImageResult({ url: "https://example.com/temporary-image.png" })).toEqual({
      value: "https://example.com/temporary-image.png",
      transport: "url",
    });
  });

  it("normalizes a saved /v1 endpoint against a base URL that already contains /v1", () => {
    expect(normalizeOpenAICompatiblePath("/v1/images/edits", "https://example.com/v1"))
      .toBe("/images/edits");
    expect(normalizeOpenAICompatiblePath("/v1/images/edits", "https://example.com"))
      .toBe("/v1/images/edits");
  });

  it("uses the bounded shared image request timeout", () => {
    expect(DEFAULT_IMAGE_REQUEST_TIMEOUT_MS).toBe(1_800_000);
    expect(IMAGE_RESPONSE_BODY_TIMEOUT_MS).toBe(1_800_000);
    expect(IMAGE_RESPONSE_BODY_IDLE_TIMEOUT_MS).toBe(1_200_000);
  });

  it("reads a chunked Base64 response while the body keeps making progress", async () => {
    async function* body() {
      yield Buffer.from('{"data":[{"b64_json":"');
      yield Buffer.from('iVBORw0KGgo=');
      yield Buffer.from('"}]}');
    }

    const result = await readImageResponseBodyWithIdleTimeout(body(), 50);
    expect(result).toMatchObject({
      text: '{"data":[{"b64_json":"iVBORw0KGgo="}]}',
      bytesReceived: expect.any(Number),
      chunkCount: 3,
      firstByteWaitMs: expect.any(Number),
      bodyTransferMs: expect.any(Number),
      maxChunkGapMs: expect.any(Number),
    });
  });

  it("detects a response body that stops transferring after successful headers", async () => {
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let callCount = 0;
        return {
          next() {
            callCount += 1;
            if (callCount === 1) {
              return Promise.resolve({ done: false as const, value: new Uint8Array([123]) });
            }
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
        };
      },
    };

    await expect(readImageResponseBodyWithIdleTimeout(body, 20)).rejects.toMatchObject({
      name: ImageResponseBodyIdleTimeoutError.name,
      timeoutMs: 20,
      bytesReceived: 1,
    });
  });

  it("sends a complete multipart image-edit request on the wire", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = Buffer.alloc(0);
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        receivedHeaders = request.headers;
        receivedBody = Buffer.concat(chunks);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");

    const provider = new OpenAISeedanceProvider({
      name: "openai-seedance",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });

    try {
      const result = await provider.generateImage({
        modelId: "gpt-image-2",
        mode: "image-to-image",
        prompt: "test image edit",
        width: 2160,
        height: 3840,
        referenceImageUrl: "data:image/png;base64,iVBORw0KGgo=",
      });
      expect(result.extra?.timing).toMatchObject({ responseBodyBytes: expect.any(Number) });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect(receivedHeaders["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(receivedHeaders["content-length"]).toBeDefined();
    expect(Number(receivedHeaders["content-length"])).toBe(receivedBody.length);
    expect(receivedHeaders["transfer-encoding"]).toBeUndefined();
    expect(receivedBody.toString("utf8")).toContain('name="model"');
    expect(receivedBody.toString("utf8")).toContain("gpt-image-2");
    expect(receivedBody.toString("utf8")).toContain('name="size"');
    expect(receivedBody.toString("utf8")).toContain("2160x3840");
    expect(receivedBody.toString("utf8")).toContain('name="response_format"');
    expect(receivedBody.toString("utf8")).toContain("b64_json");
  });
});
