import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getGlobalModelSettings: vi.fn(),
  resolveGlobalImageChannel: vi.fn(),
  resolveGlobalLLMSetting: vi.fn(),
  resolveGlobalVideoChannel: vi.fn(),
  resolveGlobalVideoReferenceHosting: vi.fn(),
  resolveGlobalVideoReferenceHostingCredentials: vi.fn(),
  resolveUserVideoReferenceHostingCredentials: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/model-pool", () => ({
  getGlobalModelSettings: mocks.getGlobalModelSettings,
  resolveGlobalImageChannel: mocks.resolveGlobalImageChannel,
  resolveGlobalLLMSetting: mocks.resolveGlobalLLMSetting,
  resolveGlobalVideoChannel: mocks.resolveGlobalVideoChannel,
  resolveGlobalVideoReferenceHosting: mocks.resolveGlobalVideoReferenceHosting,
  resolveGlobalVideoReferenceHostingCredentials: mocks.resolveGlobalVideoReferenceHostingCredentials,
}));
vi.mock("@/lib/user-video-reference-hosting-credentials", () => ({
  resolveUserVideoReferenceHostingCredentials: mocks.resolveUserVideoReferenceHostingCredentials,
}));

import { resolveVideoReferenceHosting } from "@/lib/server-model-settings";

function request() {
  return new NextRequest("http://localhost/api/video-reference-hosting");
}

const sharedHosting = {
  provider: "cloudinary" as const,
  enabled: true,
  cloudName: "shared-cloud",
  apiKey: "admin-hosting-key",
  apiSecret: "admin-hosting-secret",
};

describe("video reference hosting credential isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGlobalVideoReferenceHosting.mockResolvedValue(sharedHosting);
    mocks.resolveGlobalVideoReferenceHostingCredentials.mockResolvedValue({
      apiKey: "admin-hosting-key",
      apiSecret: "admin-hosting-secret",
    });
  });

  it("keeps the administrator on the existing shared hosting configuration", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "admin-001", role: "admin" });

    await expect(resolveVideoReferenceHosting(request())).resolves.toEqual(sharedHosting);
    expect(mocks.resolveGlobalVideoReferenceHostingCredentials).toHaveBeenCalledOnce();
    expect(mocks.resolveUserVideoReferenceHostingCredentials).not.toHaveBeenCalled();
  });

  it("combines shared hosting metadata with only the current normal user's credentials", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user-001", role: "user" });
    mocks.resolveUserVideoReferenceHostingCredentials.mockResolvedValue({
      apiKey: "user-001-hosting-key",
      apiSecret: "user-001-hosting-secret",
    });

    await expect(resolveVideoReferenceHosting(request())).resolves.toEqual({
      ...sharedHosting,
      apiKey: "user-001-hosting-key",
      apiSecret: "user-001-hosting-secret",
    });
    expect(mocks.resolveUserVideoReferenceHostingCredentials).toHaveBeenCalledWith("user-001");
  });

  it("does not fall back to administrator credentials for an unconfigured normal user", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user-002", role: "user" });
    mocks.resolveUserVideoReferenceHostingCredentials.mockResolvedValue(null);

    await expect(resolveVideoReferenceHosting(request())).resolves.toBeNull();
    expect(mocks.resolveUserVideoReferenceHostingCredentials).toHaveBeenCalledWith("user-002");
  });
});
