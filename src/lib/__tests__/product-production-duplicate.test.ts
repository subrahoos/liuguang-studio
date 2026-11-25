import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sqlite } from "@/lib/db";
import { createProductProductionTask, duplicateProductProductionTask, listProductProductionTasks, productProductionTaskRoot, updateProductProductionTask } from "@/lib/product-production";

const mocks = vi.hoisted(() => ({ failCopy: false, revoke: false, owner: "", sourceId: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const copyFile = async (...args: Parameters<typeof fs.copyFile>) => {
    if (mocks.failCopy) { await fs.writeFile(args[1], "partial"); throw new Error("模拟磁盘写入失败"); }
    await fs.copyFile(...args);
    if (mocks.revoke) {
      const { updateProductProductionTask } = await import("@/lib/product-production");
      await updateProductProductionTask(mocks.sourceId, mocks.owner, (value) => { value.payload.approvedProductMasterAssetId = undefined; return value; });
    }
  };
  return { ...fs, copyFile, default: { ...fs, copyFile } };
});

describe("production duplicate failure boundary", () => {
  let filePath = "";
  beforeEach(async () => {
    mocks.failCopy = false; mocks.revoke = false;
    mocks.owner = `duplicate-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(mocks.owner, crypto.randomUUID(), mocks.owner, Date.now(), Date.now());
    const task = await createProductProductionTask(mocks.owner);
    mocks.sourceId = task.id;
    const directory = path.join(productProductionTaskRoot(mocks.owner, task.id), "uploads");
    await mkdir(directory);
    filePath = path.join(directory, "master.png");
    await writeFile(filePath, "approved master");
    await updateProductProductionTask(task.id, mocks.owner, (value) => {
      value.payload.assets.push({ id: "master", kind: "product_master", name: "验收白底图", filePath, publicUrl: "unit", bytes: 15, mimeType: "image/png", createdAt: new Date().toISOString() });
      value.payload.productMasterAssetId = "master"; value.payload.approvedProductMasterAssetId = "master";
      return value;
    });
  });
  it("leaves no empty task or partial directory when copying fails", async () => {
    mocks.failCopy = true;
    await expect(duplicateProductProductionTask(mocks.owner, mocks.sourceId)).rejects.toThrow("磁盘写入失败");
    expect(await listProductProductionTasks(mocks.owner)).toHaveLength(1);
    const root = productProductionTaskRoot(mocks.owner, mocks.sourceId);
    expect(await readdir(path.dirname(root))).toEqual([mocks.sourceId]);
    expect((await readFile(filePath)).toString()).toBe("approved master");
  });
  it("does not publish a batch if source approval was revoked during the copy", async () => {
    mocks.revoke = true;
    await expect(duplicateProductProductionTask(mocks.owner, mocks.sourceId)).rejects.toThrow("验收刚刚变化");
    expect(await listProductProductionTasks(mocks.owner)).toHaveLength(1);
    expect(await readdir(path.dirname(productProductionTaskRoot(mocks.owner, mocks.sourceId)))).toEqual([mocks.sourceId]);
  });
});
