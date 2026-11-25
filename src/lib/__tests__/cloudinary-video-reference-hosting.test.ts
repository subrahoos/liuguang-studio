import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    fetch: ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)) as unknown as typeof actual.fetch,
  };
});

import { SERVER_MANAGED_API_KEY } from "@/lib/auth-constants";
import {
  cleanupCloudinaryVideoReferences,
  hostVideoReferencesForModel,
  mergeVideoReferenceHostingSetting,
  signCloudinaryParameters,
} from "@/lib/cloudinary-video-reference-hosting";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";

const setting: VideoReferenceHostingSetting = {
  provider: "cloudinary",
  enabled: true,
  cloudName: "demo-cloud",
  apiKey: "demo-key",
  apiSecret: "demo-secret",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Cloudinary video reference hosting", () => {
  it("signs sorted Cloudinary parameters", () => {
    expect(signCloudinaryParameters({
      timestamp: 1_700_000_000,
      public_id: "test_asset",
    }, "secret")).toBe("11d2024a8914003b9dc9a85496c476ac2754a417");
  });

  it("preserves server-managed credentials while accepting public field changes", () => {
    expect(mergeVideoReferenceHostingSetting({
      ...setting,
      cloudName: "new-cloud",
      apiKey: SERVER_MANAGED_API_KEY,
      apiSecret: SERVER_MANAGED_API_KEY,
    }, setting)).toEqual({
      ...setting,
      cloudName: "new-cloud",
    });
  });

  it("does not require hosting for a non-Grok video model", async () => {
    const sources = ["data:image/png;base64,AAAA"];
    await expect(hostVideoReferencesForModel({
      model: "omni-flash",
      sources,
      ownerId: "owner-1",
      scopeId: "scope-1",
    })).resolves.toEqual({
      urls: sources,
      assets: [],
      transport: "original",
    });
  });

  it("requires Cloudinary before sending Grok image references", async () => {
    await expect(hostVideoReferencesForModel({
      model: "grok-imagine-video-1.5",
      sources: ["data:image/png;base64,AAAA"],
      ownerId: "owner-1",
      scopeId: "scope-1",
    })).rejects.toThrow("Cloudinary");
  });

  it("requires Cloudinary before sending Grok's configured multi-reference package", async () => {
    await expect(hostVideoReferencesForModel({
      model: "grok-imagine-video",
      sources: Array.from({ length: 5 }, (_, index) => `data:image/png;base64,AAA${index}`),
      ownerId: "owner-1",
      scopeId: "scope-1",
    })).rejects.toThrow("Cloudinary");
  });

  it("uploads Grok's multi-reference images in order and cleans the temporary assets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      const form = init?.body as FormData;
      if (requestUrl.endsWith("/image/upload")) {
        const source = form.get("file");
        expect(source).toBeInstanceOf(Blob);
        const bytes = Buffer.from(await (source as Blob).arrayBuffer());
        const suffix = bytes.equals(Buffer.from("AAAA", "base64")) ? "one" : "two";
        return new Response(JSON.stringify({
          secure_url: `https://res.cloudinary.com/demo-cloud/image/upload/v1/${suffix}.png`,
          public_id: `public-${suffix}`,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (requestUrl.startsWith("https://res.cloudinary.com/demo-cloud/image/upload/v1/")) {
        const suffix = requestUrl.endsWith("one.png") ? "AAAA" : "BBBB";
        return new Response(Buffer.from(suffix, "base64"), { status: 200 });
      }
      if (requestUrl.endsWith("/image/destroy")) {
        return new Response(JSON.stringify({ result: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    });

    const hosted = await hostVideoReferencesForModel({
      model: "grok-imagine-video",
      sources: [
        "data:image/png;base64,AAAA",
        "data:image/png;base64,BBBB",
      ],
      setting,
      ownerId: "owner-1",
      scopeId: "scope-1",
      referenceIds: ["main", "product"],
    });

    expect(hosted.transport).toBe("cloudinary_https");
    expect(hosted.urls).toEqual([
      "https://res.cloudinary.com/demo-cloud/image/upload/v1/one.png",
      "https://res.cloudinary.com/demo-cloud/image/upload/v1/two.png",
    ]);
    expect(hosted.urls.every((url) => url.startsWith("https://"))).toBe(true);
    expect(hosted.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceBytes: 3, sourceSha256: expect.any(String), verifiedAt: expect.any(String) }),
    ]));

    const cleanup = await cleanupCloudinaryVideoReferences(setting, hosted.assets);
    expect(cleanup).toMatchObject({
      total: 2,
      deleted: 2,
      alreadyAbsent: 0,
      failed: 0,
      status: "confirmed",
    });
    expect(cleanup.assets.map((asset) => asset.status)).toEqual(["deleted", "deleted"]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("records Cloudinary's per-reference delete response without claiming an absent asset was deleted", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const form = init?.body as FormData;
      const publicId = String(form.get("public_id"));
      if (publicId === "already-gone") {
        return new Response(JSON.stringify({ result: "not found" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "Invalid Signature" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    });

    const cleanup = await cleanupCloudinaryVideoReferences(setting, [
      { secureUrl: "https://res.cloudinary.com/demo/image/upload/already-gone.png", publicId: "already-gone" },
      { secureUrl: "https://res.cloudinary.com/demo/video/upload/cannot-delete.mp4", publicId: "cannot-delete", resourceType: "video" },
    ]);

    expect(cleanup).toMatchObject({
      total: 2,
      deleted: 0,
      alreadyAbsent: 1,
      failed: 1,
      status: "partial_failure",
    });
    expect(cleanup.assets).toEqual([
      expect.objectContaining({ publicId: "already-gone", status: "already_absent" }),
      expect.objectContaining({ publicId: "cannot-delete", resourceType: "video", status: "failed", error: expect.stringContaining("Invalid Signature") }),
    ]);
  });

  it("retries a transient upload failure without changing reference order", async () => {
    vi.useFakeTimers();
    const uploadedSources: string[] = [];
    let uploadAttempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      const form = init?.body as FormData;
      if (requestUrl.startsWith("https://res.cloudinary.com/demo-cloud/image/upload/v1/")) {
        const suffix = requestUrl.endsWith("one.png") ? "AAAA" : "BBBB";
        return new Response(Buffer.from(suffix, "base64"), { status: 200 });
      }
      if (!requestUrl.endsWith("/image/upload")) {
        throw new Error(`Unexpected URL: ${requestUrl}`);
      }
      uploadAttempt += 1;
      if (uploadAttempt === 1) throw new TypeError("fetch failed");
      const source = form.get("file") as Blob;
      const sourceBase64 = Buffer.from(await source.arrayBuffer()).toString("base64");
      uploadedSources.push(sourceBase64);
      const suffix = sourceBase64 === "AAAA" ? "one" : "two";
      return new Response(JSON.stringify({
        secure_url: `https://res.cloudinary.com/demo-cloud/image/upload/v1/${suffix}.png`,
        public_id: `public-${suffix}`,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const hostedPromise = hostVideoReferencesForModel({
      model: "grok-imagine-video-1.5",
      sources: [
        "data:image/png;base64,AAAA",
        "data:image/png;base64,BBBB",
      ],
      setting,
      ownerId: "owner-1",
      scopeId: "scope-1",
      referenceIds: ["main", "product"],
    });

    await vi.runAllTimersAsync();
    const hosted = await hostedPromise;
    expect(uploadAttempt).toBe(3);
    expect(uploadedSources).toEqual([
      "AAAA",
      "BBBB",
    ]);
    expect(hosted.urls).toEqual([
      "https://res.cloudinary.com/demo-cloud/image/upload/v1/one.png",
      "https://res.cloudinary.com/demo-cloud/image/upload/v1/two.png",
    ]);
  });

  it("uses Cloudinary's video endpoint for a direct reference video and cleans it as video", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/video/upload")) {
        // A large direct-reference video must not be aborted by a short client-side upload deadline.
        expect(init?.signal).toBeUndefined();
        return new Response(JSON.stringify({
          secure_url: "https://res.cloudinary.com/demo-cloud/video/upload/v1/reference.mp4",
          public_id: "reference-video",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestUrl === "https://res.cloudinary.com/demo-cloud/video/upload/v1/reference.mp4") {
        return new Response(Buffer.from("AAAA", "base64"), { status: 200 });
      }
      if (requestUrl.endsWith("/video/destroy")) {
        return new Response(JSON.stringify({ result: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    });
    const hosted = await hostVideoReferencesForModel({
      model: "video-ds-2.0",
      sources: ["data:video/mp4;base64,AAAA"],
      setting,
      ownerId: "owner-1",
      scopeId: "scope-1",
      resourceType: "video",
    });
    expect(hosted.urls).toEqual(["https://res.cloudinary.com/demo-cloud/video/upload/v1/reference.mp4"]);
    expect(hosted.assets[0]?.resourceType).toBe("video");
    expect(hosted.assets[0]).toMatchObject({ sourceBytes: 3, sourceSha256: expect.any(String), verifiedAt: expect.any(String) });
    await expect(cleanupCloudinaryVideoReferences(setting, hosted.assets)).resolves.toMatchObject({ deleted: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses a byte-mismatched Cloudinary delivery and deletes the unverified temporary video", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/video/upload")) {
        return new Response(JSON.stringify({
          secure_url: "https://res.cloudinary.com/demo-cloud/video/upload/v1/reference.mp4",
          public_id: "reference-video",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestUrl === "https://res.cloudinary.com/demo-cloud/video/upload/v1/reference.mp4") {
        return new Response(Buffer.from("BBBB", "base64"), { status: 200 });
      }
      if (requestUrl.endsWith("/video/destroy")) {
        return new Response(JSON.stringify({ result: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    });

    await expect(hostVideoReferencesForModel({
      model: "video-ds-2.0",
      sources: ["data:video/mp4;base64,AAAA"],
      setting,
      ownerId: "owner-1",
      scopeId: "scope-1",
      resourceType: "video",
    })).rejects.toThrow("SHA-256 不一致");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
