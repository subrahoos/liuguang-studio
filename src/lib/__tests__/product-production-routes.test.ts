import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { sqlite } from "@/lib/db";
import { createProductProductionTask, getProductProductionTask, updateProductProductionTask } from "@/lib/product-production";

const mocks = vi.hoisted(() => ({ user: { id: "" } }));
vi.mock("@/lib/server/product-production-access", () => ({
  getOwnedProductProductionAccess: async (_req: unknown, id: string) => {
    const { getProductProductionTask } = await import("@/lib/product-production");
    const task = await getProductProductionTask(id, mocks.user.id);
    return task ? { task, user: mocks.user } : null;
  },
}));
vi.mock("@/lib/product-production-worker", () => ({ wakeProductProductionWorker: vi.fn() }));
import { DELETE, PATCH } from "@/app/api/product-production/[id]/route";

describe("production task atomic editing", () => {
  beforeEach(() => {
    mocks.user.id = `production-route-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(mocks.user.id, crypto.randomUUID(), mocks.user.id, Date.now(), Date.now());
  });
  const patch = (id: string, body: unknown) => PATCH(new NextRequest("http://localhost/api/product-production/" + id, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const remove = (id: string) => DELETE(new NextRequest("http://localhost/api/product-production/" + id, { method: "DELETE" }), { params: Promise.resolve({ id }) });

  it("rejects stale revisions rather than replacing newer settings", async () => {
    const task = await createProductProductionTask(mocks.user.id);
    await updateProductProductionTask(task.id, mocks.user.id, (value) => { value.payload.videoChannelId = "new"; return value; });
    const result = await patch(task.id, { expectedRevision: 0, videoChannelId: "old" });
    expect(result.status).toBe(409);
    expect((await getProductProductionTask(task.id, mocks.user.id))?.payload.videoChannelId).toBe("new");
  });
  it("keeps active white-background generation running when renamed", async () => {
    const task = await createProductProductionTask(mocks.user.id);
    const active = await updateProductProductionTask(task.id, mocks.user.id, (value) => {
      value.payload.jobs.push({ id: "master-job", kind: "product_master", status: "submitting", channelId: "image" });
      return value;
    });
    const result = await patch(task.id, { expectedRevision: active.revision, name: "修改名称" });
    expect((await result.json()).task.status).toBe("running");
  });
  it("updates one source without replacing another source's settings", async () => {
    const task = await createProductProductionTask(mocks.user.id);
    const active = await updateProductProductionTask(task.id, mocks.user.id, (value) => {
      value.payload.assets = ["a", "b"].map((id) => ({ id, name: id, kind: "reference_video", bytes: 1, mimeType: "video/mp4", filePath: "test", publicUrl: "test", createdAt: new Date().toISOString() }));
      value.payload.videoSources = [{ id: "a", assetId: "a", copies: 1 }, { id: "b", assetId: "b", copies: 5 }];
      return value;
    });
    const result = await patch(task.id, { expectedRevision: active.revision, videoSourceUpdate: { id: "a", patch: { copies: 3 } } });
    const updated = (await result.json()).task;
    expect(updated.payload.videoSources.map((item: { copies: number }) => item.copies)).toEqual([3, 5]);
  });
  it("cannot edit another owner's task", async () => {
    const task = await createProductProductionTask(mocks.user.id);
    mocks.user.id = "another-owner";
    expect((await patch(task.id, { name: "bad" })).status).toBe(404);
  });
  it("deletes owned completed tasks but protects uncertain submissions", async () => {
    const task = await createProductProductionTask(mocks.user.id);
    const uncertain = await updateProductProductionTask(task.id, mocks.user.id, (value) => {
      value.payload.jobs.push({ id: "uncertain", kind: "video", status: "uncertain", channelId: "video" });
      return value;
    });
    const blocked = await remove(uncertain.id);
    expect(blocked.status).toBe(400);
    await updateProductProductionTask(task.id, mocks.user.id, (value) => { value.payload.jobs = []; return value; });
    const deleted = await remove(task.id);
    expect(deleted.status).toBe(200);
    expect(await getProductProductionTask(task.id, mocks.user.id)).toBeNull();
    expect((await remove(task.id)).status).toBe(404);
  });
});
