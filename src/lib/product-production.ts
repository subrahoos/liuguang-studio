import { mkdir, copyFile, stat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { sqlite } from "@/lib/db";
import { storagePaths } from "@/lib/storage-root";
import { productionStatus } from "@/lib/product-production-state";
import type { VideoModelChannel, ImageModelChannel } from "@/lib/stores/settings-store";
import type { CloudinaryReferenceCleanup } from "@/lib/video-reference-hosting-types";

export type ProductProductionStatus = "draft" | "master_review" | "ready" | "queued" | "running" | "partial" | "done" | "failed" | "cancelled" | "uncertain";
export type ProductProductionAssetKind = "product_source" | "product_master" | "reference_video" | "detail_image" | "face_image" | "scene_image" | "audio" | "video_output" | "detail_output";
export type ProductProductionJobKind = "product_master" | "video" | "detail";
export type ProductProductionJobStatus = "waiting" | "queued" | "submitting" | "running" | "done" | "failed" | "cancelled" | "uncertain";
export type ProductProductionMode = "video" | "detail" | "both";

export function productProductionContentSelection(mode: ProductProductionMode, videoCount: number, detailCount: number) {
  return {
    video: mode !== "detail" && videoCount > 0,
    detail: mode !== "video" && detailCount > 0,
  };
}

export type ProductProductionAsset = {
  id: string;
  kind: ProductProductionAssetKind;
  name: string;
  filePath: string;
  publicUrl: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  createdAt: string;
};

export type ProductProductionVideoSource = {
  id: string;
  assetId: string;
  copies: number;
  channelId?: string;
  generationSeconds?: number;
  resolution?: "720p" | "1080p";
};

export type ProductProductionJob = {
  id: string;
  kind: ProductProductionJobKind;
  status: ProductProductionJobStatus;
  sourceAssetId?: string;
  productSourceAssetIds?: string[];
  variantIndex?: number;
  channelId: string;
  generationSeconds?: number;
  resolution?: "720p" | "1080p";
  remoteTaskId?: string;
  outputAssetId?: string;
  error?: string;
  startedAt?: string;
  submittedAt?: string;
  finishedAt?: string;
  promptVersion?: string;
  capabilitySignature?: string;
  hostedReferences?: Array<Record<string, unknown>>;
  referenceTransport?: "cloudinary_https" | "lingganya_file_id";
  referenceUploadCount?: number;
  referenceExpiresAt?: string;
  recoveredManually?: boolean;
  submissionAttemptedAt?: string;
  channelSnapshot?: Omit<VideoModelChannel, "apiKey">;
  imageChannelSnapshot?: Omit<ImageModelChannel, "apiKey">;
  cleanup?: CloudinaryReferenceCleanup;
};

export type ProductProductionPayload = {
  version: 2;
  productionMode: ProductProductionMode;
  assets: ProductProductionAsset[];
  productSourceAssetIds: string[];
  productMasterAssetId?: string;
  approvedProductMasterAssetId?: string;
  productMasterReviewStatus: "not_ready" | "pending" | "approved";
  productMasterApprovedAt?: string;
  videoSources: ProductProductionVideoSource[];
  detailAssetIds: string[];
  faceAssetId?: string;
  sceneAssetId?: string;
  audioAssetId?: string;
  imageChannelId?: string;
  videoChannelId?: string;
  defaultVideoSeconds?: number;
  defaultVideoResolution?: "720p" | "1080p";
  jobs: ProductProductionJob[];
  createdAt: string;
  updatedAt: string;
};

export type ProductProductionTask = {
  id: string;
  ownerId: string;
  outputDirectory: string;
  revision: number;
  name: string;
  status: ProductProductionStatus;
  payload: ProductProductionPayload;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type ProductProductionRow = {
  id: string;
  owner_id: string;
  revision: number;
  name: string;
  status: ProductProductionStatus;
  payload: string;
  created_at: number | string | null;
  updated_at: number | string | null;
  completed_at: number | string | null;
};

function iso(value: number | string | null | undefined) {
  if (!value) return new Date().toISOString();
  if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function safeId(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid product production id.");
  return value;
}

function safeName(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 96) || "未命名商品生产";
}

function normalizePayload(value: unknown, now = new Date().toISOString()): ProductProductionPayload {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<ProductProductionPayload> : {};
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  const productMasterAssetId = typeof raw.productMasterAssetId === "string" ? raw.productMasterAssetId : undefined;
  const explicitApprovedId = typeof raw.approvedProductMasterAssetId === "string" ? raw.approvedProductMasterAssetId : undefined;
  const legacyContentStarted = jobs.some((job) => job.kind === "video" || job.kind === "detail");
  const approvedProductMasterAssetId = explicitApprovedId || (legacyContentStarted ? productMasterAssetId : undefined);
  return {
    version: 2,
    productionMode: raw.productionMode === "video" || raw.productionMode === "detail" ? raw.productionMode : "both",
    assets,
    productSourceAssetIds: Array.isArray(raw.productSourceAssetIds) ? raw.productSourceAssetIds.filter((id): id is string => typeof id === "string") : [],
    productMasterAssetId,
    approvedProductMasterAssetId,
    productMasterReviewStatus: approvedProductMasterAssetId ? "approved" : productMasterAssetId ? "pending" : "not_ready",
    productMasterApprovedAt: approvedProductMasterAssetId
      ? (typeof raw.productMasterApprovedAt === "string" ? raw.productMasterApprovedAt : now)
      : undefined,
    videoSources: Array.isArray(raw.videoSources) ? raw.videoSources : [],
    detailAssetIds: Array.isArray(raw.detailAssetIds) ? raw.detailAssetIds.filter((id): id is string => typeof id === "string") : [],
    faceAssetId: typeof raw.faceAssetId === "string" ? raw.faceAssetId : undefined,
    sceneAssetId: typeof raw.sceneAssetId === "string" ? raw.sceneAssetId : undefined,
    audioAssetId: typeof raw.audioAssetId === "string" ? raw.audioAssetId : undefined,
    imageChannelId: typeof raw.imageChannelId === "string" ? raw.imageChannelId : undefined,
    videoChannelId: typeof raw.videoChannelId === "string" ? raw.videoChannelId : undefined,
    defaultVideoSeconds: typeof raw.defaultVideoSeconds === "number" ? raw.defaultVideoSeconds : undefined,
    defaultVideoResolution: raw.defaultVideoResolution === "720p" || raw.defaultVideoResolution === "1080p" ? raw.defaultVideoResolution : undefined,
    jobs,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function rowToTask(row: ProductProductionRow): ProductProductionTask {
  let payload: unknown = {};
  try { payload = JSON.parse(row.payload); } catch { throw new Error(`商品生产任务 ${row.id} 数据损坏，已停止读取。`); }
  const normalizedPayload = normalizePayload(payload, iso(row.created_at));
  const status = productionStatus(normalizedPayload);
  return {
    id: row.id,
    ownerId: row.owner_id,
    outputDirectory: productProductionOutputDirectory(row.owner_id, row.id),
    revision: Number(row.revision || 0),
    name: row.name,
    status,
    payload: normalizedPayload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
  };
}

export function productProductionTaskRoot(ownerId: string, taskId: string) {
  return storagePaths.productProduction(safeId(ownerId), safeId(taskId));
}

export function productProductionOutputDirectory(ownerId: string, taskId: string) {
  return path.join(productProductionTaskRoot(ownerId, taskId), "outputs");
}

export function productProductionFileUrl(taskId: string, assetId: string) {
  return `/api/product-production/${encodeURIComponent(taskId)}/file/${encodeURIComponent(assetId)}`;
}

export async function listProductProductionTasks(ownerId: string) {
  const rows = sqlite.prepare(`SELECT * FROM product_production_tasks WHERE owner_id = ? ORDER BY updated_at DESC`).all(ownerId) as ProductProductionRow[];
  return rows.map(rowToTask);
}

export async function deleteProductProductionTask(id: string, ownerId: string) {
  const task = await getProductProductionTask(id, ownerId);
  if (!task) throw new Error("商品生产任务不存在或无权删除。");
  const active = task.payload.jobs.some((job) => ["queued", "submitting", "running", "uncertain"].includes(job.status));
  if (active) throw new Error("任务仍在生产中或提交状态待核实，请先处理完成后再删除。");
  const deleted = sqlite.prepare("DELETE FROM product_production_tasks WHERE id = ? AND owner_id = ?").run(safeId(id), ownerId);
  if (deleted.changes !== 1) throw new Error("商品生产任务不存在或无权删除。");
  await rm(productProductionTaskRoot(ownerId, id), { recursive: true, force: true });
  return { id };
}

export async function getProductProductionTask(id: string, ownerId: string) {
  const row = sqlite.prepare(`SELECT * FROM product_production_tasks WHERE id = ? AND owner_id = ? LIMIT 1`).get(safeId(id), ownerId) as ProductProductionRow | undefined;
  return row ? rowToTask(row) : null;
}

export async function createProductProductionTask(ownerId: string, name?: string, productionMode: ProductProductionMode = "both") {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = normalizePayload({ productionMode, createdAt: now, updatedAt: now });
  await mkdir(productProductionTaskRoot(ownerId, id), { recursive: true });
  return insertProductProductionTask(ownerId, id, name, payload);
}

async function insertProductProductionTask(ownerId: string, id: string, name: string | undefined, payload: ProductProductionPayload) {
  sqlite.prepare(`INSERT INTO product_production_tasks (id, owner_id, revision, name, status, payload, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)`)
    .run(id, ownerId, safeName(name || `商品生产 · ${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}`), productionStatus(payload), JSON.stringify(payload), Date.now(), Date.now());
  return (await getProductProductionTask(id, ownerId))!;
}

export async function updateProductProductionTask(
  id: string,
  ownerId: string,
  updater: (task: ProductProductionTask) => ProductProductionTask,
) {
  return sqlite.transaction(() => {
    const row = sqlite.prepare(`SELECT * FROM product_production_tasks WHERE id = ? AND owner_id = ? LIMIT 1`).get(safeId(id), ownerId) as ProductProductionRow | undefined;
    if (!row) throw new Error("商品生产任务不存在。");
    const current = rowToTask(row);
    const next = updater(structuredClone(current));
    const now = new Date().toISOString();
    next.payload = normalizePayload({ ...next.payload, updatedAt: now }, current.createdAt);
    next.status = productionStatus(next.payload);
    next.updatedAt = now;
    next.revision = current.revision + 1;
    const completedAt = ["done", "failed", "cancelled"].includes(next.status) ? (next.completedAt || now) : undefined;
    sqlite.prepare(`UPDATE product_production_tasks SET revision = ?, name = ?, status = ?, payload = ?, updated_at = ?, completed_at = ? WHERE id = ? AND owner_id = ?`)
      .run(next.revision, safeName(next.name), next.status, JSON.stringify(next.payload), Date.now(), completedAt ? Date.parse(completedAt) : null, id, ownerId);
    return { ...next, completedAt };
  })();
}

export function productProductionAsset(task: ProductProductionTask, id?: string) {
  return id ? task.payload.assets.find((asset) => asset.id === id) : undefined;
}

export function summarizeProductProductionTask(task: ProductProductionTask) {
  const jobs = task.payload.jobs.filter((job) => job.kind === "video" || job.kind === "detail");
  const includesVideo = task.payload.productionMode !== "detail";
  const includesDetail = task.payload.productionMode !== "video";
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    updatedAt: task.updatedAt,
    productMasterUrl: productProductionAsset(task, task.payload.productMasterAssetId)?.publicUrl,
    productMasterReviewStatus: task.payload.productMasterReviewStatus,
    productionMode: task.payload.productionMode,
    videoSources: includesVideo ? task.payload.videoSources.length : 0,
    plannedVideos: includesVideo ? task.payload.videoSources.reduce((sum, item) => sum + Math.max(1, item.copies), 0) : 0,
    detailImages: includesDetail ? task.payload.detailAssetIds.length : 0,
    totalJobs: jobs.length,
    completedJobs: jobs.filter((job) => job.status === "done").length,
    failedJobs: jobs.filter((job) => job.status === "failed").length,
    runningJobs: jobs.filter((job) => ["submitting", "running"].includes(job.status)).length,
  };
}

export function prepareProductProductionRetry(
  task: ProductProductionTask,
  options: { includeUncertain?: boolean; includeProductMaster?: boolean; jobId?: string } = {},
) {
  task.payload.jobs.forEach((job) => {
    if (options.jobId && job.id !== options.jobId) return;
    if (job.kind === "product_master" && !(options.includeProductMaster === true && options.includeUncertain === true && job.status === "uncertain")) return;
    const retryableUncertain = options.includeUncertain === true
      && job.status === "uncertain"
      && !job.remoteTaskId;
    if (job.status === "failed" || retryableUncertain) {
      job.status = job.remoteTaskId ? "running" : "queued";
      job.error = undefined;
      job.finishedAt = undefined;
      job.submissionAttemptedAt = undefined;
    }
  });
  return task;
}

export async function duplicateProductProductionTask(ownerId: string, sourceId: string) {
  const source = await getProductProductionTask(sourceId, ownerId);
  if (!source) throw new Error("原任务不存在。");
  const master = productProductionAsset(source, source.payload.approvedProductMasterAssetId);
  if (!master || master.kind !== "product_master") throw new Error("请先验收白底图，再沿用新建一批。");
  const sourcePath = productProductionAssetPath(source, master.id);
  const info = await stat(sourcePath);
  if (!info.isFile() || !info.size) throw new Error("原白底图文件不可读，请重新准备。");
  // Stage in a newly and exclusively created task root; publish no DB row until ready.
  const taskId = crypto.randomUUID();
  const root = path.resolve(productProductionTaskRoot(ownerId, taskId));
  const ownerRoot = path.dirname(path.resolve(productProductionTaskRoot(ownerId, source.id)));
  if (path.dirname(root) !== ownerRoot || root === path.resolve(productProductionTaskRoot(ownerId, source.id))) throw new Error("新批次目录校验失败。");
  await mkdir(root); // EEXIST must fail outside the cleanup scope.
  try {
    const directory = path.join(root, "uploads");
    await mkdir(directory);
    const id = crypto.randomUUID();
    const filePath = path.join(directory, id + path.extname(sourcePath));
    await copyFile(sourcePath, filePath, constants.COPYFILE_EXCL);
    const copied = await stat(filePath);
    if (!copied.isFile() || copied.size !== info.size) throw new Error("白底图复制不完整，请重试。");
    const now = new Date().toISOString();
    const payload = normalizePayload({
      productionMode: "both", createdAt: now, updatedAt: now,
      assets: [{ ...master, id, filePath, bytes: copied.size, publicUrl: productProductionFileUrl(taskId, id), createdAt: now }],
      productMasterAssetId: id, approvedProductMasterAssetId: id,
      productMasterApprovedAt: source.payload.productMasterApprovedAt,
      imageChannelId: source.payload.imageChannelId,
      videoChannelId: source.payload.videoChannelId,
      defaultVideoSeconds: source.payload.defaultVideoSeconds,
      defaultVideoResolution: source.payload.defaultVideoResolution,
    });
    // Verify the source's approval was not concurrently revoked while copying.
    const current = await getProductProductionTask(source.id, ownerId);
    if (current?.payload.approvedProductMasterAssetId !== master.id) throw new Error("原白底图验收刚刚变化，请刷新后重试。");
    return await insertProductProductionTask(ownerId, taskId, source.name + " · 新批次", payload);
  } catch (error) {
    // Only this invocation's unpublished, freshly created UUID root is removable.
    const published = sqlite.prepare("SELECT id FROM product_production_tasks WHERE id = ?").get(taskId);
    if (!published && path.dirname(root) === ownerRoot) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function productProductionAssetPath(task: ProductProductionTask, assetId: string) {
  const asset = productProductionAsset(task, assetId);
  if (!asset) throw new Error("素材不存在。");
  const root = productProductionTaskRoot(task.ownerId, task.id);
  const resolved = path.resolve(asset.filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("素材路径超出任务目录。");
  return resolved;
}
