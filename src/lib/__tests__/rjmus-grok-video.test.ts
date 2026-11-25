import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch, Response as UndiciResponse } from "undici";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});

import {
  RjmusGrokVideoError,
  cancelRjmusGrokVideo,
  downloadRjmusGrokVideo,
  getRjmusGrokVideoStatus,
  isRetryableRjmusVideoError,
  isTransientVideoPollInterruption,
  probeLingganyaCompletedVideoContent,
  submitRjmusGrokVideo,
  verifyRjmusGrokVideoChannel,
} from "@/lib/rjmus-grok-video";
import { BOARD_VIDEO_MODEL } from "@/lib/video-shot-segments";
import {
  LINGGANYA_SD_2_BOARD_VIDEO_MODEL,
  LINGGANYA_SD_2_MINI_BOARD_VIDEO_MODEL,
  LINGGANYA_SD_2_T_BOARD_VIDEO_MODEL,
} from "@/lib/board-video-protocol";

const channel = {
  baseUrl: "https://video.rjm.us.ci",
  apiKey: "test-key",
  model: BOARD_VIDEO_MODEL,
};
const imageUrl = "https://cdn.example.com/current-shot.jpg";
const lingganyaChannel = {
  baseUrl: "https://www.lingganyaapi.com",
  apiKey: "test-key",
  model: LINGGANYA_SD_2_BOARD_VIDEO_MODEL,
};
const lingganyaImages = ["base", "product", "face", "model", "scene"].map((name) => `https://cdn.example.com/${name}.jpg`);
const currentLingganyaChannel = {
  id: "lgy-sd-multimedia",
  baseUrl: "https://www.lingganyaapi.com/v1",
  apiKey: "test-key",
  model: LINGGANYA_SD_2_T_BOARD_VIDEO_MODEL,
  submitPath: "/videos",
  statusPath: "/videos/{id}",
  contentPath: "/videos/{id}/content",
  durationOptions: [15],
  maxReferenceImages: 4,
  maxReferenceVideos: 1,
  maxReferenceAudios: 1,
};
const configuredLingganyaVipChannel = {
  ...currentLingganyaChannel,
  id: "lgy-sd-vip",
  model: "sd-2.0-vip",
};
const configuredLingganyaSd20GChannel = {
  ...currentLingganyaChannel,
  id: "lgy-sd2.0-g",
  model: "sd-2.0-g",
  durationOptions: Array.from({ length: 12 }, (_, index) => index + 4),
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  directVideoReplacementPromptLanguage: "zh-CN" as const,
  directVideoReplacementSceneOptional: true,
  directVideoReplacementFaceOptional: true,
  directVideoReplacementReferenceContract: "product_front_face" as const,
  directVideoReplacementPromptVersion: "v2" as const,
};
const configuredLingganyaSd20MiniChannel = {
  ...currentLingganyaChannel,
  id: "lgy-sd2.0-mini",
  model: LINGGANYA_SD_2_MINI_BOARD_VIDEO_MODEL,
  durationOptions: Array.from({ length: 11 }, (_, index) => index + 5),
  maxReferenceImages: 6,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  directVideoReplacementPromptLanguage: "zh-CN" as const,
  directVideoReplacementSceneOptional: true,
  directVideoReplacementFaceOptional: true,
  directVideoReplacementReferenceContract: "product_front_face" as const,
};
const directLingganyaImages = ["product", "face", "model", "scene"].map((name) => `https://cdn.example.com/${name}.jpg`);
const grokMultiReferenceChannel = {
  baseUrl: "https://video.rjm.us.ci/v1",
  apiKey: "test-key",
  model: "grok-imagine-video",
  durationOptions: [10],
  maxReferenceImages: 7,
};
const multimediaVideoDsChannel = {
  id: "rim-sd-multimedia",
  baseUrl: "https://video.rjm.us.ci/v1",
  apiKey: "test-key",
  model: "video-ds-2.0",
  submitPath: "/videos",
  statusPath: "/videos/{id}",
  contentPath: "/videos/{id}/content",
  durationOptions: [15],
  maxReferenceImages: 4,
  maxReferenceVideos: 3,
  maxReferenceAudios: 1,
};
const mikotoSeedanceChannel = {
  id: "mkosd",
  baseUrl: "https://api.mikoto.vip",
  apiKey: "test-key",
  model: "seedance-2.0-1080p",
  videoProtocol: "mikoto" as const,
  submitPath: "/videos",
  statusPath: "/videos/{id}",
  contentPath: "/videos/{id}/content",
  durationOptions: [4, 5, 6],
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  directVideoReplacementSceneOptional: true,
  directVideoReplacementFaceOptional: true,
  directVideoReplacementReferenceContract: "product_front_face" as const,
};
const mikotoSoraChannel = {
  id: "mkosor",
  baseUrl: "https://api.mikoto.vip",
  apiKey: "test-key",
  model: "sora-v3-pro",
  videoProtocol: "mikoto_sora" as const,
  submitPath: "/videos",
  statusPath: "/videos/{id}",
  contentPath: "/videos/{id}/content",
  durationOptions: [4, 5, 6],
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  directVideoReplacementSceneOptional: true,
  directVideoReplacementFaceOptional: false,
  directVideoReplacementReferenceContract: "product_front_face" as const,
};
const mikotoImages = ["product", "face", "scene"].map((name) => `https://cdn.example.com/mikoto-${name}.jpg`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(undiciFetch).mockReset();
});

describe("rjm Grok asynchronous board video protocol", () => {
  it("checks video visibility through the documented models endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: BOARD_VIDEO_MODEL }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRjmusGrokVideoChannel(channel)).resolves.toMatchObject({
      modelIds: [BOARD_VIDEO_MODEL],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://video.rjm.us.ci/v1/models?type=video");
  });

  it("treats a missing async-video catalogue entry as advisory instead of blocking submission", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRjmusGrokVideoChannel(grokMultiReferenceChannel)).resolves.toMatchObject({
      modelIds: [],
      modelVisible: false,
    });
  });

  it("submits one HTTPS visual base to the documented asynchronous endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ taskId: "task-1" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...channel,
      prompt: "DIRECTOR SHOT SPECIFICATION",
      imageUrl,
    })).resolves.toEqual({ taskId: "task-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://video.rjm.us.ci/v1/videos/generations");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({
      model: BOARD_VIDEO_MODEL,
      prompt: "DIRECTOR SHOT SPECIFICATION",
      resolution: "720p",
      aspect_ratio: "9:16",
      seconds: 10,
      image_url: imageUrl,
    });
  });

  it("submits the five-role package to rjm Grok's multi-reference model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ taskId: "task-multi-1" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...grokMultiReferenceChannel,
      prompt: "DIRECTOR SHOT SPECIFICATION",
      imageUrls: lingganyaImages,
    })).resolves.toEqual({ taskId: "task-multi-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://video.rjm.us.ci/v1/videos/generations");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "grok-imagine-video",
      prompt: "DIRECTOR SHOT SPECIFICATION",
      resolution: "720p",
      aspect_ratio: "9:16",
      seconds: 10,
      image_urls: lingganyaImages,
    });
  });

  it("uses the saved multimedia channel contract without changing legacy video-ds channels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-media-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...multimediaVideoDsChannel,
      prompt: "DIRECTOR SHOT SPECIFICATION",
      imageUrls: [imageUrl, imageUrl, imageUrl, imageUrl],
      videoUrls: ["https://cdn.example.com/motion.mp4"],
      audioUrls: ["https://cdn.example.com/music.mp3"],
    })).resolves.toEqual({ taskId: "task-media-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://video.rjm.us.ci/v1/videos");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "video-ds-2.0",
      prompt: "DIRECTOR SHOT SPECIFICATION",
      seconds: "15",
      aspect_ratio: "9:16",
      images: [imageUrl, imageUrl, imageUrl, imageUrl],
      videos: ["https://cdn.example.com/motion.mp4"],
      audios: ["https://cdn.example.com/music.mp3"],
    });
  });

  it("rejects an input that is not one public HTTPS image before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitRjmusGrokVideo({
      ...channel,
      prompt: "test",
      imageUrl: "C:\\local\\image.png",
    })).rejects.toMatchObject({ code: "INVALID_REFERENCES" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an overlong Grok prompt locally before creating an upstream task", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...grokMultiReferenceChannel,
      prompt: "x".repeat(4_097),
      imageUrls: lingganyaImages,
    })).rejects.toMatchObject({ code: "PROMPT_TOO_LONG" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a prompt whose UTF-8 bytes exceed Grok's limit even when character count does not", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const prompt = "中".repeat(1_400);
    expect(prompt.length).toBeLessThan(4_096);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(4_096);
    await expect(submitRjmusGrokVideo({
      ...grokMultiReferenceChannel,
      prompt,
      imageUrls: lingganyaImages,
    })).rejects.toMatchObject({ code: "PROMPT_TOO_LONG" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses taskId, understands documented task states, and reads data[].url", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "running" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "completed",
        data: [{ url: "https://signed.example.com/result.mp4" }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRjmusGrokVideoStatus({ ...channel, taskId: "task-2" })).resolves.toMatchObject({ status: "running" });
    await expect(getRjmusGrokVideoStatus({ ...channel, taskId: "task-2" })).resolves.toMatchObject({
      status: "completed",
      resultUrls: ["https://signed.example.com/result.mp4"],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://video.rjm.us.ci/v1/videos/tasks/task-2");
  });

  it("recognizes terminal failures wrapped in a task status envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        task: {
          state: "failed",
          error: { message: "上游生成失败" },
        },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRjmusGrokVideoStatus({ ...configuredLingganyaVipChannel, taskId: "task-wrapped-failure" })).resolves.toMatchObject({
      status: "failed",
      error: "上游生成失败",
    });
  });

  it("uses the configured multimedia status and protected content paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRjmusGrokVideoStatus({ ...multimediaVideoDsChannel, taskId: "task-media-2" })).resolves.toMatchObject({
      status: "completed",
      resultUrls: ["https://video.rjm.us.ci/v1/videos/task-media-2/content"],
      contentRequiresApiKey: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://video.rjm.us.ci/v1/videos/task-media-2");
  });

  it("downloads the signed result directly without forwarding the video API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadRjmusGrokVideo({ resultUrl: "https://signed.example.com/result.mp4" })).resolves.toMatchObject({
      ext: "mp4",
      bytes: Buffer.from([1, 2, 3]),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toMatchObject({ Authorization: expect.any(String) });
    expect(init.signal).toBeUndefined();
  });

  it("submits MKOSD with only its Seedance field contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "mkosd-task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...mikotoSeedanceChannel,
      prompt: "保持人物动作与商品一致",
      imageUrls: mikotoImages.slice(0, 2),
      videoUrls: ["https://cdn.example.com/motion.mp4"],
      audioUrls: ["https://cdn.example.com/music.mp3"],
      generationSeconds: 5,
    })).resolves.toEqual({ taskId: "mkosd-task-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mikoto.vip/v1/videos");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "seedance-2.0-1080p",
      prompt: "保持人物动作与商品一致",
      duration: 5,
      aspect_ratio: "9:16",
      images: mikotoImages.slice(0, 2),
      reference_mode: "media",
      referenceVideos: ["https://cdn.example.com/motion.mp4"],
      referenceAudios: ["https://cdn.example.com/music.mp3"],
      generate_audio: true,
    });
  });

  it("retries only MKOSD's non-billable model catalogue after a connection reset", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: reset }))
      .mockResolvedValueOnce(new UndiciResponse(JSON.stringify({ data: [{ id: "seedance-2.0-1080p" }] }), { status: 200 }));

    await expect(verifyRjmusGrokVideoChannel(mikotoSeedanceChannel)).resolves.toMatchObject({
      modelIds: ["seedance-2.0-1080p"],
      modelVisible: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.mikoto.vip/v1/models");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.mikoto.vip/v1/models");
    expect(fetchMock.mock.calls.every(([, init]) => (init?.headers as { Connection?: string }).Connection === "close")).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.dispatcher)).toBe(true);
  });

  it("reports a redacted category after MKOSOR's safe catalogue retries are exhausted", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: reset }));

    await expect(verifyRjmusGrokVideoChannel(mikotoSoraChannel)).rejects.toMatchObject({
      code: "MIKOTO_CATALOGUE_NETWORK_ERROR",
      message: expect.stringContaining("连接被重置"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === "https://api.mikoto.vip/v1/models")).toBe(true);
  });

  it("does not add model-catalogue retries to Lingganya", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRjmusGrokVideoChannel(currentLingganyaChannel)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
  });

  it("submits MKOSOR with only its Sora field contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "mkosor-task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...mikotoSoraChannel,
      prompt: "keep product and face consistent",
      imageUrls: mikotoImages,
      videoUrls: ["https://cdn.example.com/motion.mp4"],
      audioUrls: ["https://cdn.example.com/music.mp3"],
      generationSeconds: 6,
    })).resolves.toEqual({ taskId: "mkosor-task-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mikoto.vip/v1/videos");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "sora-v3-pro",
      prompt: "keep product and face consistent",
      seconds: "6",
      aspect_ratio: "9:16",
      resolution: "720p",
      image_url: mikotoImages[0],
      reference_image_urls: mikotoImages.slice(1),
      reference_videos: ["https://cdn.example.com/motion.mp4"],
      audio_url: "https://cdn.example.com/music.mp3",
      video_config: { reference_mode: "auto" },
    });
  });

  it("keeps both Mikoto protocols local on cancellation because neither documents an upstream cancel endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelRjmusGrokVideo({ ...mikotoSeedanceChannel, taskId: "mkosd-task-cancel" })).resolves.toEqual({});
    await expect(cancelRjmusGrokVideo({ ...mikotoSoraChannel, taskId: "mkosor-task-cancel" })).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads an MKOSOR video_url with the channel API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "completed",
      video_url: "https://api.mikoto.vip/v1/videos/mkosor-task-2/content",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRjmusGrokVideoStatus({ ...mikotoSoraChannel, taskId: "mkosor-task-2" })).resolves.toMatchObject({
      status: "completed",
      resultUrls: ["https://api.mikoto.vip/v1/videos/mkosor-task-2/content"],
      contentRequiresApiKey: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.mikoto.vip/v1/videos/mkosor-task-2");
  });

  it("sends best-effort cancellation to the documented task endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelRjmusGrokVideo({ ...channel, taskId: "task-3" })).resolves.toEqual({});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://video.rjm.us.ci/v1/videos/tasks/task-3");
    expect(init.method).toBe("DELETE");
  });

  it("treats only transient transport and server failures as retryable", () => {
    expect(isRetryableRjmusVideoError(new RjmusGrokVideoError("temporarily unavailable", "API_ERROR", 503))).toBe(true);
    expect(isRetryableRjmusVideoError(new RjmusGrokVideoError("wrong task", "API_ERROR", 404))).toBe(false);
  });

  it("keeps a submitted task recoverable when only the local poll connection terminates", () => {
    expect(isTransientVideoPollInterruption(new Error("terminated"))).toBe(true);
    expect(isTransientVideoPollInterruption(Object.assign(new Error("cancelled by browser"), { name: "AbortError" }))).toBe(true);
    expect(isTransientVideoPollInterruption(new Error("HTTP 400: unsupported field"))).toBe(false);
  });

  it("submits Lingganya sd-2.0 with five ordered image references and audio enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lingganya-1",
      task_id: "task-lingganya-1",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...lingganyaChannel,
      prompt: "DIRECTOR SHOT SPECIFICATION",
      imageUrls: lingganyaImages,
    })).resolves.toEqual({ taskId: "task-lingganya-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.lingganyaapi.com/v1/videos");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "sd-2.0",
      prompt: "DIRECTOR SHOT SPECIFICATION",
      seconds: 15,
      resolution: "1080p",
      size: "9:16",
      images: lingganyaImages,
      extra: { reference_mode: "frame", generate_audio: true },
    });
  });

  it("submits current LGY sd-2.0-T media references without the unsupported reference_mode field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-direct-1",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...currentLingganyaChannel,
      prompt: "DIRECT VIDEO REPLACEMENT",
      imageUrls: directLingganyaImages,
      videoUrls: ["https://cdn.example.com/motion.mp4"],
      audioUrls: ["https://cdn.example.com/music.mp3"],
      // This is the current node's selected resolution, not a saved channel field.
      resolution: "720p",
    })).resolves.toEqual({ taskId: "task-lgy-direct-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.lingganyaapi.com/v1/videos");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "sd-2.0-T",
      prompt: "DIRECT VIDEO REPLACEMENT",
      seconds: 15,
      resolution: "1080p",
      size: "9:16",
      images: directLingganyaImages,
      extra: {
        reference_videos: ["https://cdn.example.com/motion.mp4"],
        reference_audios: ["https://cdn.example.com/music.mp3"],
      },
    });
  });

  it("submits three required images when the saved LGY scene reference is optional", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-optional-scene",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...currentLingganyaChannel,
      directVideoReplacementSceneOptional: true,
      prompt: "DIRECT VIDEO REPLACEMENT WITHOUT SCENE",
      imageUrls: directLingganyaImages.slice(0, 3),
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })).resolves.toEqual({ taskId: "task-lgy-optional-scene" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "sd-2.0-T",
      images: directLingganyaImages.slice(0, 3),
      extra: {
        reference_videos: ["https://cdn.example.com/motion.mp4"],
      },
    });
    expect(JSON.parse(String(init.body)).extra).not.toHaveProperty("reference_mode");
    expect(JSON.parse(String(init.body)).extra).not.toHaveProperty("generate_audio");
  });

  it("accepts four images when an optional LGY scene reference is connected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-optional-scene-with-image",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...currentLingganyaChannel,
      directVideoReplacementSceneOptional: true,
      prompt: "DIRECT VIDEO REPLACEMENT WITH SCENE",
      imageUrls: directLingganyaImages,
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })).resolves.toEqual({ taskId: "task-lgy-optional-scene-with-image" });
  });

  it("submits the saved Lingganya model name without replacing it with an example identifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-vip-1",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaVipChannel,
      prompt: "DIRECT VIDEO REPLACEMENT",
      imageUrls: directLingganyaImages,
      videoUrls: ["https://cdn.example.com/motion.mp4"],
      audioUrls: ["https://cdn.example.com/music.mp3"],
    })).resolves.toEqual({ taskId: "task-lgy-vip-1" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "sd-2.0-vip",
      seconds: 15,
      resolution: "720p",
      images: directLingganyaImages,
      extra: {
        reference_videos: ["https://cdn.example.com/motion.mp4"],
        reference_audios: ["https://cdn.example.com/music.mp3"],
      },
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("videos");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("audios");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("generate_audio");
  });

  it("applies the optional-scene contract to the saved sd-2.0-vip channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-vip-optional-scene",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaVipChannel,
      directVideoReplacementSceneOptional: true,
      prompt: "DIRECT VIDEO REPLACEMENT WITHOUT SCENE",
      imageUrls: directLingganyaImages.slice(0, 3),
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })).resolves.toEqual({ taskId: "task-lgy-vip-optional-scene" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "sd-2.0-vip",
      images: directLingganyaImages.slice(0, 3),
    });
  });

  it("submits two images for the saved product-front LGY contract with Seedance reference media in extra", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-vip-product-front",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaVipChannel,
      directVideoReplacementSceneOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      prompt: "PRODUCT FRONT + FACE DIRECT VIDEO REPLACEMENT",
      imageUrls: directLingganyaImages.slice(0, 2),
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })).resolves.toEqual({ taskId: "task-lgy-vip-product-front" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "sd-2.0-vip",
      images: directLingganyaImages.slice(0, 2),
      extra: {
        reference_videos: ["https://cdn.example.com/motion.mp4"],
      },
    });
    expect(body).not.toHaveProperty("audios");
    expect(body).not.toHaveProperty("videos");
    expect(body).not.toHaveProperty("generate_audio");
  });

  it("submits Lingganya temporary file ids in their documented media fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-vip-file-ids",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaVipChannel,
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      prompt: "PRODUCT REPLACEMENT WITH TEMPORARY REFERENCES",
      imageUrls: ["file_product", "file_face"],
      videoUrls: ["file_video"],
      audioUrls: ["file_audio"],
    })).resolves.toEqual({ taskId: "task-lgy-vip-file-ids" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "sd-2.0-vip",
      prompt: "PRODUCT REPLACEMENT WITH TEMPORARY REFERENCES",
      seconds: 15,
      resolution: "720p",
      size: "9:16",
      images: ["file_product", "file_face"],
      extra: {
        reference_videos: ["file_video"],
        reference_audios: ["file_audio"],
      },
    });
  });

  it("submits sd-2.0-g reference editing with only the documented top-level fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-sd20g-edit",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaSd20GChannel,
      generationSeconds: 12,
      prompt: "编辑参考视频：只替换模特上衣，保持镜头运动连贯",
      imageUrls: ["file_product", "file_face"],
      videoUrls: ["file_video"],
    })).resolves.toEqual({ taskId: "task-lgy-sd20g-edit" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "sd-2.0-g",
      prompt: "编辑参考视频：只替换模特上衣，保持镜头运动连贯",
      duration: 12,
      resolution: "720p",
      ratio: "9:16",
      images: ["file_product", "file_face"],
      videos: ["file_video"],
    });
    expect(body).not.toHaveProperty("seconds");
    expect(body).not.toHaveProperty("size");
    expect(body).not.toHaveProperty("extra");
    expect(body).not.toHaveProperty("generate_audio");
  });

  it("submits sd-2.0-mini references with the official unified fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-sd20mini-reference",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaSd20MiniChannel,
      generationSeconds: 10,
      prompt: "参考视频中的镜头和动作，用图 1 商品替换模特当前上衣",
      imageUrls: ["file_product", "file_face"],
      videoUrls: ["file_video"],
      audioUrls: ["file_audio"],
    })).resolves.toEqual({ taskId: "task-lgy-sd20mini-reference" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "sd-2.0-mini",
      prompt: "参考视频中的镜头和动作，用图 1 商品替换模特当前上衣",
      seconds: 10,
      resolution: "720p",
      size: "9:16",
      images: ["file_product", "file_face"],
      extra: {
        reference_videos: ["file_video"],
        reference_audios: ["file_audio"],
      },
    });
  });

  it("submits only the product image when this exact LGY channel opts into reference-video identity retention", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-vip-reference-video-face",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaVipChannel,
      directVideoReplacementSceneOptional: true,
      directVideoReplacementFaceOptional: true,
      directVideoReplacementReferenceContract: "product_front_face",
      prompt: "PRODUCT FRONT + REFERENCE VIDEO IDENTITY DIRECT VIDEO REPLACEMENT",
      imageUrls: directLingganyaImages.slice(0, 1),
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })).resolves.toEqual({ taskId: "task-lgy-vip-reference-video-face" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "sd-2.0-vip",
      images: directLingganyaImages.slice(0, 1),
      extra: {
        reference_videos: ["https://cdn.example.com/motion.mp4"],
      },
    });
  });

  it("accepts four images for the saved sd-2.0-vip channel when its optional scene is connected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "task-lgy-vip-optional-scene-with-image",
      status: "queued",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRjmusGrokVideo({
      ...configuredLingganyaVipChannel,
      directVideoReplacementSceneOptional: true,
      prompt: "DIRECT VIDEO REPLACEMENT WITH SCENE",
      imageUrls: directLingganyaImages,
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })).resolves.toEqual({ taskId: "task-lgy-vip-optional-scene-with-image" });
  });

  it("checks current LGY model visibility without creating a video task", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "sd-2.0-T" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRjmusGrokVideoChannel(currentLingganyaChannel)).resolves.toMatchObject({
      modelIds: ["sd-2.0-T"],
      modelVisible: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.lingganyaapi.com/v1/models");
  });

  it("checks the exact saved Lingganya model name without creating a video task", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "sd-2.0-vip" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRjmusGrokVideoChannel(configuredLingganyaVipChannel)).resolves.toMatchObject({
      modelIds: ["sd-2.0-vip"],
      modelVisible: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.lingganyaapi.com/v1/models");
  });

  it("reads Lingganya video_url and downloads the protected content with its API key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "completed",
        video_url: "https://www.lingganyaapi.com/v1/videos/task-lingganya-2/content",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRjmusGrokVideoStatus({ ...lingganyaChannel, taskId: "task-lingganya-2" })).resolves.toMatchObject({
      status: "completed",
      resultUrls: ["https://www.lingganyaapi.com/v1/videos/task-lingganya-2/content"],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.lingganyaapi.com/v1/videos/task-lingganya-2");

    await expect(downloadRjmusGrokVideo({
      resultUrl: "https://www.lingganyaapi.com/v1/videos/task-lingganya-2/content",
      apiKey: lingganyaChannel.apiKey,
      requiresApiKey: true,
    })).resolves.toMatchObject({ bytes: Buffer.from([4, 5, 6]) });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("recovers Lingganya's deterministic content URL when status permission lags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 0-0/8579645",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeLingganyaCompletedVideoContent({
      ...configuredLingganyaVipChannel,
      taskId: "task-completed-but-status-403",
    })).resolves.toBe("https://www.lingganyaapi.com/v1/videos/task-completed-but-status-403/content");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.lingganyaapi.com/v1/videos/task-completed-but-status-403/content");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      Range: "bytes=0-0",
    });
  });

  it("does not send a protected result token to a different host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadRjmusGrokVideo({
      resultUrl: "https://unexpected.example.com/content",
      apiKey: "secret",
      requiresApiKey: true,
      authorizedBaseUrl: "https://www.lingganyaapi.com/v1",
    })).rejects.toThrow("不属于当前模型通道");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
