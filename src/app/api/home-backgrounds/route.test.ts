import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  requireUser: vi.fn(),
  handleAuthRouteError: vi.fn(),
  backgrounds: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: { mkdir: mocks.mkdir, writeFile: mocks.writeFile },
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));
vi.mock("@/lib/auth", () => ({
  requireUser: mocks.requireUser,
  handleAuthRouteError: mocks.handleAuthRouteError,
}));
vi.mock("@/lib/storage-root", () => ({
  storagePaths: { backgrounds: mocks.backgrounds },
}));

import { POST } from "@/app/api/home-backgrounds/route";

function uploadRequest(file: File, expectedSize?: string) {
  const form = new FormData();
  if (expectedSize !== undefined) form.set("expectedSize", expectedSize);
  form.set("file", file);
  return { formData: vi.fn().mockResolvedValue(form) } as unknown as NextRequest;
}

describe("home background upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-001" });
    mocks.handleAuthRouteError.mockReturnValue(null);
    mocks.backgrounds.mockImplementation((userId?: string) => userId ? `D:/test/backgrounds/${userId}` : "D:/test/backgrounds");
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("persists a complete local video and returns a playable user-scoped URL", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "planet.mp4", { type: "video/mp4" });

    const response = await POST(uploadRequest(file, String(file.size)));

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "video",
      url: expect.stringMatching(/^\/api\/home-backgrounds\/user-001\/.+\.mp4$/),
    });
    expect(mocks.mkdir).toHaveBeenCalledWith("D:/test/backgrounds/user-001", { recursive: true });
    expect(mocks.writeFile).toHaveBeenCalledOnce();
  });

  it("rejects a truncated upload before it can be written", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "planet.mp4", { type: "video/mp4" });

    const response = await POST(uploadRequest(file, String(file.size + 1)));

    expect(response.status, await response.clone().text()).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "背景视频上传不完整，请重新导入后再试" });
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a malformed declared upload size", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "planet.mp4", { type: "video/mp4" });

    const response = await POST(uploadRequest(file, "not-a-size"));

    expect(response.status, await response.clone().text()).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "背景素材上传参数无效" });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
