import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  isAdmin: vi.fn(),
  handleAuthRouteError: vi.fn(),
  getUserModelSettings: vi.fn(),
  upsertUserModelSettings: vi.fn(),
  getGlobalModelSettings: vi.fn(),
  saveGlobalModelSettings: vi.fn(),
  resolveGlobalVideoReferenceHostingCredentials: vi.fn(),
  replaceGlobalVideoReferenceHostingCredentials: vi.fn(),
  mergeVideoReferenceHostingSetting: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: mocks.requireUser,
  isAdmin: mocks.isAdmin,
  handleAuthRouteError: mocks.handleAuthRouteError,
  getUserModelSettings: mocks.getUserModelSettings,
  upsertUserModelSettings: mocks.upsertUserModelSettings,
}));
vi.mock("@/lib/model-pool", () => ({
  getGlobalModelSettings: mocks.getGlobalModelSettings,
  saveGlobalModelSettings: mocks.saveGlobalModelSettings,
  resolveGlobalVideoReferenceHostingCredentials: mocks.resolveGlobalVideoReferenceHostingCredentials,
  replaceGlobalVideoReferenceHostingCredentials: mocks.replaceGlobalVideoReferenceHostingCredentials,
}));
vi.mock("@/lib/cloudinary-video-reference-hosting", () => ({
  mergeVideoReferenceHostingSetting: mocks.mergeVideoReferenceHostingSetting,
}));

import { GET } from "@/app/api/model-settings/route";

function getRequest(query = "") {
  return new NextRequest(`http://localhost/api/model-settings${query}`);
}

describe("model settings hosting credential reveal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "admin-001", role: "admin" });
    mocks.isAdmin.mockReturnValue(true);
    mocks.handleAuthRouteError.mockReturnValue(null);
  });

  it("reveals only the requested hosting credential with no-store headers", async () => {
    mocks.resolveGlobalVideoReferenceHostingCredentials.mockResolvedValue({
      apiKey: "test-hosting-key",
      apiSecret: "test-hosting-secret",
    });

    const response = await GET(getRequest("?revealHostingCredential=apiKey"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ field: "apiKey", value: "test-hosting-key" });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(mocks.resolveGlobalVideoReferenceHostingCredentials).toHaveBeenCalledOnce();
  });

  it("rejects unsupported hosting credential fields without reading settings", async () => {
    const response = await GET(getRequest("?revealHostingCredential=cloudName"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "不支持的公网托管凭证字段" });
    expect(mocks.getUserModelSettings).not.toHaveBeenCalled();
  });

  it("does not reveal hosting credentials to a non-administrator", async () => {
    mocks.isAdmin.mockReturnValue(false);

    const response = await GET(getRequest("?revealHostingCredential=apiSecret"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "需要管理员权限" });
    expect(mocks.getUserModelSettings).not.toHaveBeenCalled();
  });

  it("returns an empty value when the requested credential is not configured", async () => {
    mocks.resolveGlobalVideoReferenceHostingCredentials.mockResolvedValue(null);

    const response = await GET(getRequest("?revealHostingCredential=apiSecret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ field: "apiSecret", value: "" });
  });

  it("returns the auth error without reading settings when the session is missing", async () => {
    mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));
    mocks.handleAuthRouteError.mockReturnValue(NextResponse.json({ error: "未登录" }, { status: 401 }));

    const response = await GET(getRequest("?revealHostingCredential=apiKey"));

    expect(response.status).toBe(401);
    expect(mocks.getUserModelSettings).not.toHaveBeenCalled();
  });
});
