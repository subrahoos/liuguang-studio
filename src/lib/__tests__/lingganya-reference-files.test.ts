import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => {
  const lookup = vi.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
  return { default: { lookup }, lookup };
});

import {
  uploadLingganyaReferenceFile,
  uploadLingganyaReferenceFiles,
} from "@/lib/lingganya-reference-files";

function dataUri(contentType: string, value: string | Buffer) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

function uploadedFileResponse(input: { fileId: string; bytes: number; mediaType: string; expiresAt?: number }) {
  return new Response(JSON.stringify({
    id: input.fileId,
    file_id: input.fileId,
    bytes: input.bytes,
    media_type: input.mediaType,
    content_type: input.mediaType === "image" ? "image/png" : "video/mp4",
    expires_at: input.expiresAt || 1_800_000_000,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Lingganya temporary reference files", () => {
  it("uploads multipart file and filename fields with account authorization", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://www.lingganyaapi.com/v1/files");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Bearer account-key" });
      const form = init.body as FormData;
      const file = form.get("file") as File;
      expect(file).toBeInstanceOf(Blob);
      expect(file.name).toBe("product-front.png");
      expect(file.type).toBe("image/png");
      expect(form.get("filename")).toBe("product-front.png");
      return uploadedFileResponse({ fileId: "file_image_1", bytes: file.size, mediaType: "image" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLingganyaReferenceFile({
      baseUrl: "https://www.lingganyaapi.com/v1/videos",
      apiKey: "account-key",
      source: dataUri("image/png", "png-bytes"),
      referenceId: "product-front",
      mediaType: "image",
    })).resolves.toMatchObject({
      fileId: "file_image_1",
      bytes: 9,
      mediaType: "image",
      contentType: "image/png",
    });
  });

  it("uploads a batch sequentially and preserves its reference order", async () => {
    const uploadedNames: string[] = [];
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const onUploaded = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      activeUploads += 1;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      const file = (init.body as FormData).get("file") as File;
      uploadedNames.push(file.name);
      await Promise.resolve();
      activeUploads -= 1;
      return uploadedFileResponse({
        fileId: `file_${uploadedNames.length}`,
        bytes: file.size,
        mediaType: "image",
        expiresAt: 1_800_000_000 + uploadedNames.length,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadLingganyaReferenceFiles({
      baseUrl: "https://www.lingganyaapi.com/v1",
      apiKey: "account-key",
      sources: [dataUri("image/png", "one"), dataUri("image/png", "two")],
      referenceIds: ["first", "second"],
      mediaType: "image",
      onUploaded,
    });

    expect(result.fileIds).toEqual(["file_1", "file_2"]);
    expect(uploadedNames).toEqual(["first.png", "second.png"]);
    expect(maxActiveUploads).toBe(1);
    expect(onUploaded).toHaveBeenCalledTimes(2);
  });

  it("awaits each asynchronous audit receipt before uploading the next file", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const index = fetchMock.mock.calls.length;
      events.push(`upload-${index}`);
      if (index === 2) expect(events).toContain("saved-1");
      const file = (init.body as FormData).get("file") as File;
      return uploadedFileResponse({ fileId: `file_async_${index}`, bytes: file.size, mediaType: "image" });
    });
    vi.stubGlobal("fetch", fetchMock);
    let receipts = 0;
    await uploadLingganyaReferenceFiles({
      baseUrl: "https://www.lingganyaapi.com/v1", apiKey: "account-key",
      sources: [dataUri("image/png", "one"), dataUri("image/png", "two")], mediaType: "image",
      onUploaded: async () => { const index = ++receipts; await Promise.resolve(); events.push(`saved-${index}`); },
    });
    expect(events).toEqual(["upload-1", "saved-1", "upload-2", "saved-2"]);
  });

  it("downloads a public HTTPS reference and reuploads its verified bytes", async () => {
    const remoteBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(remoteBytes, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "4" },
      }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const file = (init.body as FormData).get("file") as File;
        expect(file.size).toBe(4);
        return uploadedFileResponse({ fileId: "file_remote", bytes: 4, mediaType: "image" });
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLingganyaReferenceFile({
      baseUrl: "https://www.lingganyaapi.com/v1",
      apiKey: "account-key",
      source: "https://cdn.example.com/reference.png",
      referenceId: "remote-reference",
      mediaType: "image",
    })).resolves.toMatchObject({ fileId: "file_remote", bytes: 4 });
    expect(fetchMock.mock.calls[0][0].toString()).toBe("https://cdn.example.com/reference.png");
    expect(fetchMock.mock.calls[1][0]).toBe("https://www.lingganyaapi.com/v1/files");
  });

  it("rejects files over 20 MiB before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLingganyaReferenceFile({
      baseUrl: "https://www.lingganyaapi.com/v1",
      apiKey: "account-key",
      source: dataUri("video/mp4", Buffer.alloc(20 * 1024 * 1024 + 1)),
      referenceId: "oversized-video",
      mediaType: "video",
    })).rejects.toThrow("20 MiB");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects byte-count and media-type mismatches from the upload response", async () => {
    const source = dataUri("image/png", "image-bytes");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploadedFileResponse({ fileId: "file_bad_bytes", bytes: 999, mediaType: "image" }))
      .mockResolvedValueOnce(uploadedFileResponse({ fileId: "file_bad_type", bytes: 11, mediaType: "video" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLingganyaReferenceFile({
      baseUrl: "https://www.lingganyaapi.com/v1",
      apiKey: "account-key",
      source,
      referenceId: "bad-bytes",
      mediaType: "image",
    })).rejects.toThrow("字节数与本地素材不一致");
    await expect(uploadLingganyaReferenceFile({
      baseUrl: "https://www.lingganyaapi.com/v1",
      apiKey: "account-key",
      source,
      referenceId: "bad-type",
      mediaType: "image",
    })).rejects.toThrow("与预期 image 不一致");
  });

  it("surfaces the upstream HTTP error without accepting a file id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "unsupported media" },
    }), { status: 400, headers: { "Content-Type": "application/json" } })));

    await expect(uploadLingganyaReferenceFile({
      baseUrl: "https://www.lingganyaapi.com/v1",
      apiKey: "account-key",
      source: dataUri("audio/mpeg", "audio"),
      referenceId: "audio",
      mediaType: "audio",
    })).rejects.toThrow("HTTP 400");
  });
});
