import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  requireAdmin: vi.fn(),
  handleAuthRouteError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/auth", () => ({
  requireAdmin: mocks.requireAdmin,
  handleAuthRouteError: mocks.handleAuthRouteError,
}));

import { DELETE, GET, POST } from "@/app/api/admin/invites/route";

const invite = {
  id: "invite-001",
  codeHash: "secret-hash",
  label: null,
  createdByUserId: "admin-001",
  usedByUserId: null,
  createdAt: "2026-08-05T10:00:00.000Z",
  expiresAt: "2026-09-04T10:00:00.000Z",
  usedAt: null,
};

const publicInvite = {
  id: invite.id,
  label: invite.label,
  createdAt: invite.createdAt,
  expiresAt: invite.expiresAt,
  usedAt: invite.usedAt,
  usedByUserId: invite.usedByUserId,
};

function jsonRequest(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/admin/invites", {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("admin invites route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-001", role: "admin" });
    mocks.handleAuthRouteError.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists only safe invitation fields", async () => {
    const orderBy = vi.fn().mockResolvedValue([publicInvite]);
    const from = vi.fn().mockReturnValue({ orderBy });
    const select = vi.fn().mockReturnValue({ from });
    mocks.getDb.mockReturnValue({ select });

    const response = await GET(jsonRequest("GET"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invites: [publicInvite] });
    expect(Object.keys(select.mock.calls[0][0])).toEqual([
      "id",
      "label",
      "createdAt",
      "expiresAt",
      "usedAt",
      "usedByUserId",
    ]);
    expect(Object.keys(select.mock.calls[0][0])).not.toContain("codeHash");
  });

  it("returns the plaintext code once but never returns its hash", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "invite-001" });
    const returning = vi.fn().mockResolvedValue([invite]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    mocks.getDb.mockReturnValue({ insert });

    const response = await POST(jsonRequest("POST", { code: "luma-safe-code", days: 30 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      invite: publicInvite,
      code: "LUMA-SAFE-CODE",
    });
  });

  it("allows an administrator to delete an invitation record", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: invite.id }]);
    const where = vi.fn().mockReturnValue({ returning });
    const remove = vi.fn().mockReturnValue({ where });
    mocks.getDb.mockReturnValue({ delete: remove });

    const response = await DELETE(jsonRequest("DELETE", { id: invite.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedId: invite.id });
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects deletion without a record ID and does not touch the database", async () => {
    const response = await DELETE(jsonRequest("DELETE"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "缺少邀请码记录 ID" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("reports a missing invitation record", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    mocks.getDb.mockReturnValue({ delete: vi.fn().mockReturnValue({ where }) });

    const response = await DELETE(jsonRequest("DELETE", { id: "missing-invite" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "邀请码记录不存在" });
  });

  it("keeps deletion restricted to administrators", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("ADMIN_REQUIRED"));
    mocks.handleAuthRouteError.mockReturnValue(NextResponse.json({ error: "需要管理员权限" }, { status: 403 }));

    const response = await DELETE(jsonRequest("DELETE", { id: invite.id }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "需要管理员权限" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
