import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { sqlite } from "@/lib/db";
import { createProductProductionTask, productProductionTaskRoot, updateProductProductionTask } from "@/lib/product-production";

const mocks = vi.hoisted(() => ({ owner: "" }));
vi.mock("@/lib/server/product-production-access", () => ({
  getOwnedProductProductionAccess: async (_req: unknown, id: string) => {
    const { getProductProductionTask } = await import("@/lib/product-production");
    const task = await getProductProductionTask(id, mocks.owner);
    return task ? { task, user: { id: mocks.owner } } : null;
  },
}));
import { GET } from "@/app/api/product-production/[id]/file/[assetId]/route";

describe("owner-scoped streaming production files", () => {
  let id = "";
  beforeEach(async () => {
    mocks.owner = `file-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(mocks.owner, crypto.randomUUID(), mocks.owner, Date.now(), Date.now());
    const task = await createProductProductionTask(mocks.owner);
    id = task.id;
    const directory = path.join(productProductionTaskRoot(mocks.owner, id), "outputs");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "unit.mp4");
    await writeFile(filePath, "0123456789");
    await updateProductProductionTask(id, mocks.owner, (value) => {
      value.payload.assets.push({ id: "result", name: "产品视频", kind: "video_output", filePath, publicUrl: "unit", mimeType: "video/mp4", bytes: 10, createdAt: new Date().toISOString() });
      return value;
    });
  });
  function get(range?: string, download = false) {
    return GET(new NextRequest(`http://localhost/api/product-production/${id}/file/result${download ? "?download=1" : ""}`, { headers: range ? { Range: range } : {} }), { params: Promise.resolve({ id, assetId: "result" }) });
  }
  it("serves only the requested bytes for video seeking", async () => {
    const response = await get("bytes=2-5");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });
  it("returns 416 for an invalid range and attachment for explicit downloads", async () => {
    const invalid = await get("bytes=10-");
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */10");
    const download = await get(undefined, true);
    expect(download.headers.get("Content-Disposition")).toContain("attachment;");
    expect(download.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await download.text()).toBe("0123456789");
  });
  it("does not expose another owner's files", async () => {
    mocks.owner = "other-owner";
    expect((await get()).status).toBe(404);
  });
  it("rejects asset paths outside the current task directory", async () => {
    await updateProductProductionTask(id, mocks.owner, (value) => { value.payload.assets[0].filePath = path.resolve("package.json"); return value; });
    expect((await get()).status).toBe(404);
  });
});
