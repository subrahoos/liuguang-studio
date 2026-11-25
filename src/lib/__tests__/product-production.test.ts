import { describe, expect, it } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { sqlite } from "@/lib/db";
import {
  createProductProductionTask,
  duplicateProductProductionTask,
  productProductionTaskRoot,
  getProductProductionTask,
  listProductProductionTasks,
  prepareProductProductionRetry,
  productProductionContentSelection,
  productProductionOutputDirectory,
  summarizeProductProductionTask,
  updateProductProductionTask,
} from "@/lib/product-production";

describe("product production persistence", () => {
  it("retries only the selected failed job and preserves remote task identity", async () => {
    const owner = `retry-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(owner, crypto.randomUUID(), owner, Date.now(), Date.now());
    const task = await createProductProductionTask(owner);
    task.payload.jobs = [
      { id: "a", kind: "video", status: "failed", channelId: "video", remoteTaskId: "paid-task", submissionAttemptedAt: "old" },
      { id: "b", kind: "detail", status: "failed", channelId: "image" },
      { id: "c", kind: "video", status: "uncertain", channelId: "video" },
    ];
    const next = prepareProductProductionRetry(task, { jobId: "a" });
    expect(next.payload.jobs[0]).toMatchObject({ status: "running", remoteTaskId: "paid-task", submissionAttemptedAt: undefined });
    expect(next.payload.jobs[1].status).toBe("failed");
    expect(next.payload.jobs[2].status).toBe("uncertain");
  });
  it("reuses only the approved master in a new owner-scoped batch", async () => {
    const owner = `clone-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(owner, crypto.randomUUID(), owner, Date.now(), Date.now());
    const task = await createProductProductionTask(owner);
    const directory = path.join(productProductionTaskRoot(owner, task.id), "uploads");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "master.png");
    await writeFile(filePath, "test-master");
    await updateProductProductionTask(task.id, owner, (value) => {
      value.payload.assets.push({ id: "master", kind: "product_master", name: "白底图", filePath, publicUrl: "unit", mimeType: "image/png", bytes: 11, createdAt: new Date().toISOString() });
      value.payload.productMasterAssetId = "master";
      value.payload.approvedProductMasterAssetId = "master";
      value.payload.videoChannelId = "default-video";
      value.payload.jobs.push({ id: "old-result", kind: "video", status: "done", channelId: "video" });
      return value;
    });
    const next = await duplicateProductProductionTask(owner, task.id);
    expect(next.id).not.toBe(task.id);
    expect(next.status).toBe("ready");
    expect(next.payload.jobs).toEqual([]);
    expect(next.payload.videoSources).toEqual([]);
    expect(next.payload.assets).toHaveLength(1);
    expect(next.payload.assets[0].filePath).not.toBe(filePath);
    expect((await readFile(next.payload.assets[0].filePath)).toString()).toBe("test-master");
    await expect(duplicateProductProductionTask("different-owner", task.id)).rejects.toThrow("原任务不存在");
    expect((await getProductProductionTask(task.id, owner))?.payload.jobs).toHaveLength(1);
  });
  it("plans only the uploaded content for an integrated production task", () => {
    expect(productProductionContentSelection("both", 1, 0)).toEqual({ video: true, detail: false });
    expect(productProductionContentSelection("both", 0, 2)).toEqual({ video: false, detail: true });
    expect(productProductionContentSelection("both", 1, 2)).toEqual({ video: true, detail: true });
    expect(productProductionContentSelection("both", 0, 0)).toEqual({ video: false, detail: false });
    expect(productProductionContentSelection("video", 1, 2)).toEqual({ video: true, detail: false });
    expect(productProductionContentSelection("detail", 1, 2)).toEqual({ video: false, detail: true });
  });
  it("keeps a production task owner-scoped and preserves per-video model overrides", async () => {
    const ownerId = `production-test-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(ownerId, `LUMA-${crypto.randomUUID()}`, ownerId, Date.now(), Date.now());

    const created = await createProductProductionTask(ownerId, "秋季上衣生产", "video");
    expect(created.payload.productionMode).toBe("video");
    expect(created.payload.version).toBe(2);
    expect(created.payload.productMasterReviewStatus).toBe("not_ready");
    expect(created.payload.approvedProductMasterAssetId).toBeUndefined();
    expect(created.outputDirectory).toBe(productProductionOutputDirectory(ownerId, created.id));
    expect(created.outputDirectory).toMatch(/[\\/]outputs$/);
    const updated = await updateProductProductionTask(created.id, ownerId, (task) => {
      task.payload.imageChannelId = "image-2";
      task.payload.videoChannelId = "video-default";
      task.payload.videoSources.push({
        id: "source-config",
        assetId: "reference-video",
        copies: 3,
        channelId: "video-override",
        generationSeconds: 10,
        resolution: "1080p",
      });
      return task;
    });

    expect(updated.revision).toBe(1);
    expect(updated.payload.productionMode).toBe("video");
    expect(updated.payload.videoSources[0]).toMatchObject({ copies: 3, channelId: "video-override", resolution: "1080p" });
    expect(await getProductProductionTask(created.id, "another-owner")).toBeNull();
    expect((await listProductProductionTasks(ownerId)).map((task) => task.id)).toContain(created.id);
    expect(summarizeProductProductionTask(updated).plannedVideos).toBe(3);
    expect(summarizeProductProductionTask(updated).detailImages).toBe(0);
  });

  it("requires an explicit human confirmation before retrying an uncertain submission", async () => {
    const ownerId = `production-test-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(ownerId, `LUMA-${crypto.randomUUID()}`, ownerId, Date.now(), Date.now());

    const created = await createProductProductionTask(ownerId, "待核实任务", "video");
    await updateProductProductionTask(created.id, ownerId, (task) => {
      task.status = "failed";
      task.payload.jobs.push({
        id: "failed-master-job",
        kind: "product_master",
        status: "failed",
        channelId: "image-default",
        error: "白底图生成失败。",
      });
      task.payload.jobs.push({
        id: "uncertain-job",
        kind: "video",
        status: "uncertain",
        sourceAssetId: "reference-video",
        variantIndex: 1,
        channelId: "video-default",
        error: "提交状态待核实。",
      });
      return task;
    });

    const current = (await getProductProductionTask(created.id, ownerId))!;
    const unchanged = prepareProductProductionRetry(structuredClone(current));
    expect(unchanged.payload.jobs.find((job) => job.id === "failed-master-job")?.status).toBe("failed");
    expect(unchanged.payload.jobs.find((job) => job.id === "uncertain-job")?.status).toBe("uncertain");

    const confirmed = prepareProductProductionRetry(structuredClone(current), { includeUncertain: true });
    expect(confirmed.payload.jobs.find((job) => job.id === "failed-master-job")?.status).toBe("failed");
    expect(confirmed.payload.jobs.find((job) => job.id === "uncertain-job")).toMatchObject({ status: "queued", error: undefined });
  });

  it("keeps uncertain white-background jobs separate from content retries", async () => {
    const ownerId = `production-test-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(ownerId, `LUMA-${crypto.randomUUID()}`, ownerId, Date.now(), Date.now());
    const task = await createProductProductionTask(ownerId, "白底图待核实", "both");
    task.payload.jobs.push({ id: "uncertain-master", kind: "product_master", status: "uncertain", channelId: "image-channel" });
    expect(prepareProductProductionRetry(structuredClone(task), { includeUncertain: true }).payload.jobs[0].status).toBe("uncertain");
    expect(prepareProductProductionRetry(structuredClone(task), { includeUncertain: true, includeProductMaster: true }).payload.jobs[0].status).toBe("queued");
  });

  it("migrates a legacy master-only draft into mandatory review instead of treating it as approved", async () => {
    const ownerId = `production-test-${crypto.randomUUID()}`;
    const taskId = crypto.randomUUID();
    const now = Date.now();
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(ownerId, `LUMA-${crypto.randomUUID()}`, ownerId, now, now);
    sqlite.prepare(`INSERT INTO product_production_tasks (id, owner_id, revision, name, status, payload, created_at, updated_at) VALUES (?, ?, 0, ?, 'ready', ?, ?, ?)`)
      .run(taskId, ownerId, "旧版白底图任务", JSON.stringify({
        version: 1,
        productionMode: "video",
        assets: [{ id: "legacy-master", kind: "product_master", name: "旧白底图", filePath: "legacy.png", publicUrl: "/legacy.png", mimeType: "image/png", bytes: 1, createdAt: new Date(now).toISOString() }],
        productSourceAssetIds: [],
        productMasterAssetId: "legacy-master",
        videoSources: [],
        detailAssetIds: [],
        jobs: [],
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }), now, now);

    const migrated = (await getProductProductionTask(taskId, ownerId))!;
    expect(migrated.status).toBe("master_review");
    expect(migrated.payload.version).toBe(2);
    expect(migrated.payload.productMasterReviewStatus).toBe("pending");
    expect(migrated.payload.approvedProductMasterAssetId).toBeUndefined();
  });
});
