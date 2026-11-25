import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  handleAuthRouteError: vi.fn(),
  listModelApiCalls: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: mocks.requireAdmin,
  handleAuthRouteError: mocks.handleAuthRouteError,
}));

vi.mock("@/lib/model-api-audit", () => ({
  listModelApiCalls: mocks.listModelApiCalls,
}));

import { GET } from "@/app/api/admin/model-api-calls/route";

function request(query = "") {
  return new NextRequest(`http://localhost/api/admin/model-api-calls${query}`);
}

describe("admin model API calls route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-001", role: "admin" });
    mocks.handleAuthRouteError.mockReturnValue(null);
    mocks.listModelApiCalls.mockResolvedValue([]);
  });

  it("enforces bounded filters and disables response caching", async () => {
    const response = await GET(request("?userId=user-001&type=video&status=error&channelId=video-001&from=2026-08-01&to=2026-08-03&limit=999&offset=-4"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logs: [], limit: 100, offset: 0 });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(mocks.listModelApiCalls).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-001",
      callType: "video",
      status: "error",
      channelId: "video-001",
      limit: 100,
      offset: 0,
      from: expect.any(Date),
      to: expect.any(Date),
    }));
  });

  it("returns the authorization response without reading call records", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("AUTH_REQUIRED"));
    mocks.handleAuthRouteError.mockReturnValue(NextResponse.json({ error: "未登录" }, { status: 401 }));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(mocks.listModelApiCalls).not.toHaveBeenCalled();
  });
});
