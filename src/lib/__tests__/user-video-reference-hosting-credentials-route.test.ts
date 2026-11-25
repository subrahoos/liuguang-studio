import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  handleAuthRouteError: vi.fn(),
  clearCredentials: vi.fn(),
  getCredentialState: vi.fn(),
  replaceCredentials: vi.fn(),
  revealCredential: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: mocks.requireAdmin,
  handleAuthRouteError: mocks.handleAuthRouteError,
}));
vi.mock("@/lib/user-video-reference-hosting-credentials", () => ({
  clearUserVideoReferenceHostingCredentials: mocks.clearCredentials,
  getUserVideoReferenceHostingCredentialState: mocks.getCredentialState,
  replaceUserVideoReferenceHostingCredentials: mocks.replaceCredentials,
  revealUserVideoReferenceHostingCredential: mocks.revealCredential,
}));

import { DELETE, GET, PATCH } from "@/app/api/model-settings/hosting-credentials/route";

function request(method: string, query = "", body?: unknown) {
  return new NextRequest(`http://localhost/api/model-settings/hosting-credentials${query}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("normal-user video reference hosting credential route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-001", role: "admin" });
    mocks.handleAuthRouteError.mockReturnValue(null);
  });

  it("returns credential state and a requested field with no-store headers", async () => {
    mocks.getCredentialState.mockResolvedValue({ configured: true, updatedAt: null });
    mocks.revealCredential.mockResolvedValue("test-user-hosting-key");

    const stateResponse = await GET(request("GET", "?userId=user-001"));
    expect(stateResponse.status).toBe(200);
    expect(await stateResponse.json()).toEqual({ credential: { configured: true, updatedAt: null } });
    expect(stateResponse.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(stateResponse.headers.get("Pragma")).toBe("no-cache");

    const revealResponse = await GET(request("GET", "?userId=user-001&revealField=apiKey"));
    expect(revealResponse.status).toBe(200);
    expect(await revealResponse.json()).toEqual({ field: "apiKey", value: "test-user-hosting-key" });
    expect(revealResponse.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(revealResponse.headers.get("Pragma")).toBe("no-cache");
    expect(mocks.revealCredential).toHaveBeenCalledWith("user-001", "apiKey");
  });

  it("rejects unsupported credential fields before reading storage", async () => {
    const response = await GET(request("GET", "?userId=user-001&revealField=cloudName"));

    expect(response.status).toBe(400);
    expect(mocks.getCredentialState).not.toHaveBeenCalled();
    expect(mocks.revealCredential).not.toHaveBeenCalled();
  });

  it("keeps every operation restricted to administrators", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("ADMIN_REQUIRED"));
    mocks.handleAuthRouteError.mockReturnValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));

    const response = await PATCH(request("PATCH", "", { userId: "user-001", apiKey: "test-key" }));

    expect(response.status).toBe(403);
    expect(mocks.replaceCredentials).not.toHaveBeenCalled();
  });

  it("requires both credentials for an initial save", async () => {
    mocks.replaceCredentials.mockRejectedValue(new Error("HOSTING_CREDENTIAL_PAIR_REQUIRED"));

    const response = await PATCH(request("PATCH", "", { userId: "user-001", apiKey: "test-key" }));

    expect(response.status).toBe(400);
    expect(mocks.replaceCredentials).toHaveBeenCalledWith("user-001", { apiKey: "test-key", apiSecret: undefined });
  });

  it("clears a normal user's hosting credentials", async () => {
    const response = await DELETE(request("DELETE", "", { userId: "user-001" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(mocks.clearCredentials).toHaveBeenCalledWith("user-001");
  });
});
