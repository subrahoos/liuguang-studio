import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { sqlite } from "@/lib/db";
import { createProductProductionTask, getProductProductionTask, productProductionTaskRoot, updateProductProductionTask } from "@/lib/product-production";
import { ProviderError } from "@/lib/providers/base";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), image: vi.fn(), submit: vi.fn(), status: vi.fn(), channel: vi.fn(), prepare: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/product-production-scheduler", () => ({ createBoundedOwnerScheduler: (_limit: number, _select: unknown, execute: (owner: string, job: unknown) => Promise<void>) => { mocks.execute.mockImplementation(execute); return { wake: vi.fn() }; } }));
vi.mock("@/lib/providers", () => ({ createProvider: () => ({ generateImage: mocks.image }) }));
vi.mock("@/lib/model-pool", () => ({
  resolveGlobalImageChannel: async (_owner: string, id: string) => ({ id, apiKey: "unit-only", baseUrl: "https://example.test/v1", model: "image-test" }),
  resolveGlobalVideoChannel: (...args: unknown[]) => mocks.channel(...args),
  resolveGlobalVideoReferenceHosting: async () => null,
  resolveGlobalVideoReferenceHostingCredentials: async () => null,
}));
vi.mock("@/lib/video-media-probe", () => ({ probeVideoMedia: async () => ({ durationSeconds: 5, width: 720, height: 1280 }), probeStillImageMedia: async () => ({ ext: ".png", mimeType: "image/png", width: 2160, height: 2160 }) }));
vi.mock("@/lib/video-reference-images", () => ({ encodeImageFileForVideoReference: async () => ({}), encodeVideoFileForVideoReference: async () => ({}), encodeAudioFileForVideoReference: async () => ({}) }));
vi.mock("@/lib/video-reference-transport", () => ({ isLingganyaTemporaryFileReferenceChannel: () => true, prepareVideoReferencesForChannel: (...args: unknown[]) => mocks.prepare(...args) }));
vi.mock("@/lib/model-api-audit", () => ({ auditModelApiCall: async (_context: unknown, submit: () => Promise<unknown>) => submit() }));
vi.mock("@/lib/rjmus-grok-video", async (original) => ({ ...await original<typeof import("@/lib/rjmus-grok-video")>(), verifyRjmusGrokVideoChannel: async () => ({ modelVisible: true }), submitRjmusGrokVideo: (...args: unknown[]) => mocks.submit(...args), getRjmusGrokVideoStatus: (...args: unknown[]) => mocks.status(...args) }));
import { approveProductMaster, enqueueProductMaster, enqueueProductProduction } from "@/lib/product-production-worker";

describe("production worker submission safety (no real API)", () => {
  let owner = "";
  const channel = { id: "video", name: "冻结模型", apiKey: "unit-only", baseUrl: "https://api.lingganyaapi.com/v1", model: "sd-2.0-g", submitPath: "/videos", statusPath: "/videos/{id}", contentPath: "/videos/{id}/content", maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3, durationOptions: [10, 15], directVideoReplacementFaceOptional: true, directVideoReplacementSceneOptional: true, directVideoReplacementReferenceContract: "product_front_face" as const };
  beforeEach(() => {
    mocks.image.mockReset(); mocks.submit.mockReset(); mocks.status.mockReset(); mocks.channel.mockReset();
    mocks.prepare.mockReset();
    mocks.prepare.mockImplementation(async (input: { onLingganyaFileUploaded: (file: { expiresAt: string; fileId: string }) => Promise<void> }) => {
      await input.onLingganyaFileUploaded({ expiresAt: "2030-01-01T00:00:00.000Z", fileId: "unit-private-file-id" });
      return { urls: ["unit-file"], assets: [], transport: "lingganya_file_id", uploadCount: 1 };
    });
    mocks.channel.mockResolvedValue(channel);
    mocks.status.mockResolvedValue({ status: "failed", error: "模拟上游终态" });
    owner = `worker-test-${crypto.randomUUID()}`;
    sqlite.prepare(`INSERT INTO auth_users (id, account_id, username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'test', 'user', 0, ?, ?)`)
      .run(owner, crypto.randomUUID(), owner, Date.now(), Date.now());
  });
  async function fixture(video = false) {
    const task = await createProductProductionTask(owner);
    const directory = path.join(productProductionTaskRoot(owner, task.id), "uploads");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "fixture.png");
    await writeFile(filePath, "unit fixture only");
    await updateProductProductionTask(task.id, owner, (value) => {
      value.payload.assets.push({ id: "product", kind: video ? "product_master" : "product_source", name: "商品", bytes: 17, mimeType: "image/png", filePath, publicUrl: "unit", createdAt: new Date().toISOString() });
      value.payload.imageChannelId = "image";
      if (video) {
        value.payload.productMasterAssetId = "product";
        value.payload.approvedProductMasterAssetId = "product";
        value.payload.productMasterReviewStatus = "approved";
        value.payload.videoChannelId = "video";
        value.payload.assets.push({ id: "reference", kind: "reference_video", name: "参考", bytes: 17, mimeType: "video/mp4", filePath, publicUrl: "unit", createdAt: new Date().toISOString() });
        value.payload.videoSources.push({ id: "reference", assetId: "reference", copies: 1, generationSeconds: 10, resolution: "720p" });
      } else value.payload.productSourceAssetIds = ["product"];
      return value;
    });
    return video ? enqueueProductProduction(task.id, owner) : enqueueProductMaster(task.id, owner);
  }
  it("marks lost image submission responses uncertain and never retries them automatically", async () => {
    mocks.image.mockRejectedValue(new TypeError("fetch failed"));
    const task = await fixture();
    const job = task.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task, job });
    expect((await getProductProductionTask(task.id, owner))?.payload.jobs.at(-1)?.status).toBe("uncertain");
    expect(mocks.image).toHaveBeenCalledTimes(1);
  });
  it("keeps explicit image rejection as an ordinary failure", async () => {
    mocks.image.mockRejectedValue(new ProviderError("模拟拒绝", "API_ERROR", "test", 400));
    const task = await fixture();
    const job = task.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task, job });
    expect((await getProductProductionTask(task.id, owner))?.payload.jobs.at(-1)?.status).toBe("failed");
  });
  it("marks a lost video submit response uncertain without a second call", async () => {
    mocks.submit.mockRejectedValue(new TypeError("terminated"));
    const task = await fixture(true);
    const job = task.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task, job });
    const current = (await getProductProductionTask(task.id, owner))!;
    expect(current.status).toBe("uncertain");
    expect(current.payload.jobs.at(-1)?.submissionAttemptedAt).toBeTruthy();
    expect(current.payload.jobs.at(-1)?.channelSnapshot).not.toHaveProperty("apiKey");
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it("uses the frozen model rather than a subsequently edited definition", async () => {
    mocks.submit.mockResolvedValue({ taskId: "existing-upstream-id" });
    const task = await fixture(true);
    mocks.channel.mockResolvedValue({ ...channel, model: "sd-2.0-mini" });
    const job = task.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task, job });
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ model: "sd-2.0-g" }));
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ taskId: "existing-upstream-id", model: "sd-2.0-g" }));
  });
  it("never sends current credentials to a different frozen host", async () => {
    const task = await fixture(true);
    mocks.channel.mockResolvedValue({ ...channel, baseUrl: "https://different.test/v1" });
    const job = task.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task, job });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect((await getProductProductionTask(task.id, owner))?.payload.jobs.at(-1)?.status).toBe("failed");
  });
  it("recovers an existing remote task without submitting another paid task", async () => {
    const task = await fixture(true);
    const current = await updateProductProductionTask(task.id, owner, (value) => {
      value.payload.jobs.at(-1)!.remoteTaskId = "already-paid";
      value.payload.jobs.at(-1)!.status = "running";
      return value;
    });
    const job = current.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task: current, job });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ taskId: "already-paid" }));
  });
  it("restores a durably saved image without a new generation call", async () => {
    const task = await fixture();
    const job = task.payload.jobs.at(-1)!;
    const directory = path.join(productProductionTaskRoot(owner, task.id), "outputs");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${job.id}.png`), "unit image result");
    await mocks.execute(owner, { id: job.id, task, job });
    const current = (await getProductProductionTask(task.id, owner))!;
    expect(mocks.image).not.toHaveBeenCalled();
    expect(current.status).toBe("master_review");
    expect(current.payload.jobs.at(-1)?.status).toBe("done");
    expect(current.payload.jobs.filter((item) => item.kind !== "product_master")).toHaveLength(0);
  });
  it("requires human approval even after the white-background result is available", async () => {
    const task = await fixture(true);
    await updateProductProductionTask(task.id, owner, (value) => {
      value.payload.jobs = [];
      value.payload.approvedProductMasterAssetId = undefined;
      value.payload.productMasterApprovedAt = undefined;
      return value;
    });
    await expect(enqueueProductProduction(task.id, owner)).rejects.toThrow("请先验收通过");
    const approved = await approveProductMaster(task.id, owner);
    expect(approved.status).toBe("ready");
    expect(approved.payload.jobs).toHaveLength(0);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("preserves partial reference receipts when a later upload fails, without a paid submit", async () => {
    mocks.prepare.mockImplementationOnce(async (input: { onLingganyaFileUploaded: (file: { expiresAt: string; fileId: string }) => Promise<void> }) => {
      await input.onLingganyaFileUploaded({ expiresAt: "2030-01-02T00:00:00.000Z", fileId: "private-first" });
      return { urls: ["private-first"], assets: [], transport: "lingganya_file_id", uploadCount: 1 };
    }).mockImplementationOnce(async (input: { onLingganyaFileUploaded: (file: { expiresAt: string; fileId: string }) => Promise<void> }) => {
      await input.onLingganyaFileUploaded({ expiresAt: "2030-01-01T00:00:00.000Z", fileId: "private-second" });
      throw new Error("模拟第三个文件失败");
    });
    const task = await fixture(true);
    const job = task.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task, job });
    const saved = (await getProductProductionTask(task.id, owner))!;
    expect(saved.payload.jobs.at(-1)).toMatchObject({ status: "failed", referenceUploadCount: 2, referenceTransport: "lingganya_file_id", referenceExpiresAt: "2030-01-01T00:00:00.000Z" });
    expect(JSON.stringify(saved.payload)).not.toContain("private-first");
    expect(JSON.stringify(saved.payload)).not.toContain("private-second");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("keeps cumulative reference audit and the earliest expiry across manual retries", async () => {
    const task = await fixture(true);
    const current = await updateProductProductionTask(task.id, owner, (value) => {
      value.payload.jobs.at(-1)!.referenceUploadCount = 3;
      value.payload.jobs.at(-1)!.referenceExpiresAt = "2029-12-31T00:00:00.000Z";
      return value;
    });
    mocks.submit.mockResolvedValue({ taskId: "unit-task" });
    const job = current.payload.jobs.at(-1)!;
    await mocks.execute(owner, { id: job.id, task: current, job });
    expect((await getProductProductionTask(task.id, owner))?.payload.jobs.at(-1)).toMatchObject({ referenceUploadCount: 5, referenceExpiresAt: "2029-12-31T00:00:00.000Z" });
  });
});
