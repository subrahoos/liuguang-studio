import { createReadStream, createWriteStream, existsSync } from "fs";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { isManualBoardEdge, manualDirectInputNodeIds as collectManualDirectInputNodeIds } from "@/lib/board-manual-links";
import { sqlite } from "@/lib/db";
import { isPathInsideRoot, resolveSafeRelativePath, storagePaths } from "@/lib/storage-root";
import { createEdge, createNode } from "@/lib/board-workflow-graph";
import type { CloudinaryReferenceCleanup } from "@/lib/video-reference-hosting-types";

export { manualDirectGeneratedVideoNodes } from "@/lib/board-manual-links";
export { createEdge, createNode } from "@/lib/board-workflow-graph";

export type BoardWorkflowStatus = "draft" | "evidence" | "analyzed" | "assets" | "video" | "done";

export type BoardArtifactDirectory = "source" | "evidence" | "assets" | "video" | "deliverables" | "diagnostics";

export type BoardNodeKind =
  | "source_video"
  | "storyboard"
  | "keyframe"
  | "audio"
  | "analysis"
  | "prompt"
  | "image_asset"
  | "video_clip"
  | "control"
  | "note";

export interface BoardVideoJob {
  taskId: string;
  status: "submitted" | "queued" | "running" | "completed_pending_content" | "completed" | "failed" | "cancelled";
  channelId: string;
  channelName?: string;
  model: string;
  /** Resolution chosen on this task; legacy jobs fall back to their channel default. */
  resolution?: "720p" | "1080p";
  /** Director segments are the default workflow; multimedia channels can opt into direct reference-video replacement. */
  executionMode?: "director_segments" | "direct_video_replacement";
  capabilitySignature?: string;
  /** Fixed prompt revision used for this submitted task; legacy jobs are V1. */
  promptVersion?: "v1" | "v2";
  requestId?: string;
  upstreamRequestId?: string;
  directorNodeId: string;
  directorSchemaVersion: number;
  segmentIndex: number;
  segmentCount: number;
  segmentStart: number;
  generationDuration: number;
  /** Reference-video evidence represented by this task. */
  sourceDuration: number;
  sourceTimeRange: string;
  /** Full generated duration retained in the delivered timeline. */
  outputDuration: number;
  outputTimeRange: string;
  requestedTotalDuration: number;
  plannedOutputDuration: number;
  referenceNodeIds: string[];
  /** Optional manually selected audio source for a multimedia direct-replacement task. */
  audioReferenceNodeId?: string;
  promptEnglish: string;
  /** True when the segment's AUDIO AND TEXT section contains quoted dialogue. */
  requiresAudio?: boolean;
  resultTitle: string;
  resultDescription: string;
  x: number;
  y: number;
  hostedReferences: Array<{
    secureUrl: string;
    publicId: string;
    resourceType?: "image" | "video";
    /** Original local bytes verified against Cloudinary delivery before model submission. */
    sourceBytes?: number;
    sourceSha256?: string;
    verifiedAt?: string;
  }>;
  referenceTransport: "cloudinary_https" | "lingganya_file_id";
  /** Number of same-account temporary files accepted by Lingganya before task submission. */
  referenceUploadCount?: number;
  /** Earliest expiry returned by Lingganya /v1/files; file IDs themselves are never persisted. */
  referenceExpiresAt?: string;
  /** Actual Cloudinary delete responses for this task's temporary references. */
  referenceCleanup?: CloudinaryReferenceCleanup;
  submittedAt: string;
  lastPolledAt?: string;
  pollFailures?: number;
  contentFailures?: number;
  lastError?: string;
  outputNodeIds?: string[];
  outputValidation?: {
    valid: boolean;
    checkedAt: string;
    expected: {
      durationSeconds: number;
      aspectRatio: string;
      resolution: string;
      requiresAudio?: boolean;
    };
    actual: {
      durationSeconds: number;
      width?: number;
      height?: number;
      hasAudio?: boolean;
    };
    violations: string[];
    diagnosticFilePath?: string;
  };
}

export interface BoardWorkflowNode {
  id: string;
  kind: BoardNodeKind;
  title: string;
  description?: string;
  filePath?: string;
  publicUrl?: string;
  promptEnglish?: string;
  promptChinese?: string;
  text?: string;
  status?: "pending" | "running" | "done" | "failed";
  error?: string;
  execution?: {
    runId?: string;
    clientTaskId?: string;
    status: "pending" | "running" | "done" | "failed" | "cancelled";
    startedAt?: string;
    finishedAt?: string;
    inputNodeIds?: string[];
    outputNodeIds?: string[];
    summary?: string;
    error?: string;
    /** Real Cloudinary cleanup audit, including pre-submit failures without a remote task ID. */
    referenceCleanup?: CloudinaryReferenceCleanup;
    videoJob?: BoardVideoJob;
  };
  meta?: Record<string, unknown>;
  x: number;
  y: number;
  createdAt: string;
}

export interface BoardWorkflowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface BoardWorkflow {
  id: string;
  ownerId?: string;
  revision?: number;
  deletedNodeIds?: string[];
  deletedEdgeIds?: string[];
  suppressedOutputKeys?: string[];
  name: string;
  description?: string;
  status: BoardWorkflowStatus;
  sourceVideoPath?: string;
  sourceVideoName?: string;
  localDir: string;
  nodes: BoardWorkflowNode[];
  edges: BoardWorkflowEdge[];
  analysisText?: string;
  transcriptText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoProbeMeta {
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: string;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  sizeBytes?: number;
}

const STORE_DIR = storagePaths.boards();
const LEGACY_STORE_PATH = storagePaths.system("board-workflows.json");
const LEGACY_IMPORT_KEY = "board-workflows-json-to-sqlite-v1";
let storeReady: Promise<void> | null = null;

export class BoardWorkflowRevisionConflictError extends Error {
  workflow: BoardWorkflow;

  constructor(workflow: BoardWorkflow) {
    super("画板已被其他页面或后台任务更新，请基于最新版本重试。");
    this.name = "BoardWorkflowRevisionConflictError";
    this.workflow = workflow;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function storedStringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0)))
    : [];
}

function safeSegment(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "未命名画板";
}

function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid board workflow id.");
  return id;
}

type BoardWorkflowRow = {
  id: string;
  owner_id: string;
  revision: number;
  payload: string;
  created_at: string;
  updated_at: string;
};

function normalizeStoredWorkflow(value: BoardWorkflow): BoardWorkflow {
  const workflow = { ownerId: "luma-admin", ...value };
  return {
    ...workflow,
    revision: Number.isSafeInteger(Number(workflow.revision)) ? Number(workflow.revision) : 0,
    deletedNodeIds: storedStringArray(workflow.deletedNodeIds),
    deletedEdgeIds: storedStringArray(workflow.deletedEdgeIds),
    suppressedOutputKeys: storedStringArray(workflow.suppressedOutputKeys),
  };
}

function rowToWorkflow(row: BoardWorkflowRow): BoardWorkflow {
  try {
    const parsed = JSON.parse(row.payload) as BoardWorkflow;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("payload must be an object");
    return normalizeStoredWorkflow({
      ...parsed,
      id: row.id,
      ownerId: row.owner_id || parsed.ownerId || "luma-admin",
      revision: row.revision,
      createdAt: row.created_at || parsed.createdAt,
      updatedAt: row.updated_at || parsed.updatedAt,
    });
  } catch (error) {
    throw new Error(`画板 ${row.id} 的 SQLite 数据无法解析，已停止读写以保护现有数据：${error instanceof Error ? error.message : String(error)}`);
  }
}

function workflowPayload(workflow: BoardWorkflow) {
  return JSON.stringify(workflow);
}

function ensureBoardWorkflowTables() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS board_workflows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS board_workflows_owner_updated_idx
      ON board_workflows(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS board_workflow_store_migrations (
      migration_key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );
  `);
}

async function initializeStore() {
  await Promise.all([
    mkdir(STORE_DIR, { recursive: true }),
    mkdir(storagePaths.system(), { recursive: true }),
  ]);
  ensureBoardWorkflowTables();

  const migrated = sqlite.prepare(
    "SELECT migration_key FROM board_workflow_store_migrations WHERE migration_key = ?",
  ).get(LEGACY_IMPORT_KEY);
  if (migrated) return;

  let legacyWorkflows: BoardWorkflow[] = [];
  if (existsSync(LEGACY_STORE_PATH)) {
    const legacyText = await readFile(LEGACY_STORE_PATH, "utf8");
    try {
      const parsed = JSON.parse(legacyText);
      if (!Array.isArray(parsed)) throw new Error("根节点不是画板数组");
      legacyWorkflows = parsed.map((item) => normalizeStoredWorkflow(item as BoardWorkflow));
    } catch (error) {
      throw new Error(`旧画板 JSON 无法安全迁移，已保留原文件且未写入 SQLite：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const importLegacy = sqlite.transaction((items: BoardWorkflow[]) => {
    const insert = sqlite.prepare(`
      INSERT OR IGNORE INTO board_workflows (id, owner_id, revision, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const workflow of items) {
      insert.run(
        workflow.id,
        workflow.ownerId || "luma-admin",
        workflow.revision || 0,
        workflowPayload(workflow),
        workflow.createdAt || nowIso(),
        workflow.updatedAt || nowIso(),
      );
    }
    sqlite.prepare(`
      INSERT OR IGNORE INTO board_workflow_store_migrations (migration_key, completed_at)
      VALUES (?, ?)
    `).run(LEGACY_IMPORT_KEY, nowIso());
  });
  importLegacy(legacyWorkflows);
}

async function ensureStore() {
  if (!storeReady) {
    storeReady = initializeStore().catch((error) => {
      storeReady = null;
      throw error;
    });
  }
  await storeReady;
}

async function readAll(): Promise<BoardWorkflow[]> {
  await ensureStore();
  const rows = sqlite.prepare(`
    SELECT id, owner_id, revision, payload, created_at, updated_at
    FROM board_workflows
  `).all() as BoardWorkflowRow[];
  return rows.map(rowToWorkflow);
}

export async function listBoardWorkflows(ownerId?: string) {
  const items = await readAll();
  return items
    .filter((item) => !ownerId || item.ownerId === ownerId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getBoardWorkflow(id: string, ownerId?: string) {
  safeId(id);
  await ensureStore();
  const row = sqlite.prepare(`
    SELECT id, owner_id, revision, payload, created_at, updated_at
    FROM board_workflows
    WHERE id = ?${ownerId ? " AND owner_id = ?" : ""}
  `).get(...(ownerId ? [id, ownerId] : [id])) as BoardWorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export async function createBoardWorkflow(input: { name: string; description?: string; ownerId?: string }) {
  const id = crypto.randomUUID();
  const name = safeSegment(input.name || "画板工作流");
  const localDir = storagePaths.boards(`${name}_${id.slice(0, 8)}`);
  await mkdir(localDir, { recursive: true });
  const item: BoardWorkflow = {
    id,
    ownerId: input.ownerId || "luma-admin",
    revision: 0,
    deletedNodeIds: [],
    deletedEdgeIds: [],
    suppressedOutputKeys: [],
    name,
    description: input.description?.trim() || "",
    status: "draft",
    localDir,
    nodes: [
      createNode({
        kind: "note",
        title: "画板工作流说明",
        description: "上传参考视频后，系统会抽帧生成证据板；每个节点可以拖动，位置会自动保存。",
        x: 40,
        y: 40,
      }),
    ],
    edges: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await ensureStore();
  sqlite.prepare(`
    INSERT INTO board_workflows (id, owner_id, revision, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(item.id, item.ownerId || "luma-admin", item.revision || 0, workflowPayload(item), item.createdAt, item.updatedAt);
  return item;
}

export async function updateBoardWorkflow(id: string, patch: Partial<BoardWorkflow>, expectedRevision: number) {
  safeId(id);
  const current = await getBoardWorkflow(id);
  if (!current) throw new Error("Board workflow not found.");
  const currentRevision = Number.isSafeInteger(Number(current.revision)) ? Number(current.revision) : 0;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new BoardWorkflowRevisionConflictError(current);
  }
  const nameChanged = typeof patch.name === "string" && patch.name.trim() && patch.name !== current.name;
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<BoardWorkflow>;
  const deletedNodeIds = storedStringArray([
    ...(current.deletedNodeIds || []),
    ...(cleanPatch.deletedNodeIds || []),
  ]);
  const deletedEdgeIds = storedStringArray([
    ...(current.deletedEdgeIds || []),
    ...(cleanPatch.deletedEdgeIds || []),
  ]);
  const suppressedOutputKeys = storedStringArray([
    ...(current.suppressedOutputKeys || []),
    ...(cleanPatch.suppressedOutputKeys || []),
  ]);
  const deletedNodeIdSet = new Set(deletedNodeIds);
  const deletedEdgeIdSet = new Set(deletedEdgeIds);
  if (cleanPatch.nodes) {
    cleanPatch.nodes = removeDeletedNodeReferences(cleanPatch.nodes, deletedNodeIdSet);
  }
  if (cleanPatch.edges) {
    cleanPatch.edges = cleanPatch.edges.filter((edge) =>
      !deletedEdgeIdSet.has(edge.id)
        && !deletedNodeIdSet.has(edge.from)
        && !deletedNodeIdSet.has(edge.to)
    );
  }
  const next: BoardWorkflow = {
    ...current,
    ...cleanPatch,
    id: current.id,
    revision: currentRevision + 1,
    deletedNodeIds,
    deletedEdgeIds,
    suppressedOutputKeys,
    name: nameChanged ? safeSegment(patch.name || current.name) : current.name,
    localDir: current.localDir,
    updatedAt: nowIso(),
  };
  await ensureStore();
  const result = sqlite.prepare(`
    UPDATE board_workflows
    SET owner_id = ?, revision = ?, payload = ?, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(next.ownerId || "luma-admin", next.revision || 0, workflowPayload(next), next.updatedAt, id, currentRevision);
  if (result.changes !== 1) {
    throw new BoardWorkflowRevisionConflictError((await getBoardWorkflow(id)) || current);
  }
  return next;
}

export async function deleteBoardWorkflow(id: string, expectedRevision: number) {
  safeId(id);
  const item = await getBoardWorkflow(id);
  if (item) {
    if (expectedRevision !== (item.revision ?? 0)) {
      throw new BoardWorkflowRevisionConflictError(item);
    }
    const result = sqlite.prepare("DELETE FROM board_workflows WHERE id = ? AND revision = ?")
      .run(id, item.revision || 0);
    if (result.changes !== 1) throw new BoardWorkflowRevisionConflictError((await getBoardWorkflow(id)) || item);
  }
  if (item?.localDir && isPathInsideRoot(item.localDir, STORE_DIR)) {
    await rm(item.localDir, { recursive: true, force: true }).catch(() => null);
  }
  return { ok: true };
}

function isPathInside(child: string, parent: string) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

export async function deleteBoardFiles(id: string, filePaths: string[] = []) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  if (!isPathInsideRoot(workflow.localDir, STORE_DIR)) throw new Error("Board workflow storage directory is invalid.");
  const allowedRoots = [workflow.localDir].map((item) => path.resolve(item));
  const referencedFilePaths = new Set(workflow.nodes
    .map((node) => node.filePath)
    .filter((filePath): filePath is string => Boolean(filePath))
    .map((filePath) => path.resolve(filePath)));
  const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)));
  const deleted: string[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];

  for (const filePath of uniquePaths) {
    const resolved = path.resolve(filePath);
    const allowed = allowedRoots.some((root) => isPathInside(resolved, root));
    if (!allowed) {
      skipped.push({ filePath, reason: "不在当前画板托管目录内，已跳过" });
      continue;
    }
    if (referencedFilePaths.has(resolved)) {
      skipped.push({ filePath, reason: "仍被当前画板节点引用，已保留" });
      continue;
    }
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        skipped.push({ filePath, reason: "不是文件，已跳过" });
        continue;
      }
      await rm(resolved, { force: true });
      deleted.push(resolved);
    } catch {
      skipped.push({ filePath, reason: "文件不存在或无法删除" });
    }
  }

  return { deleted, skipped };
}

export interface BoardUploadedFile {
  filePath: string;
  sha256: string;
  bytes: number;
  reused: boolean;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Persists a browser upload through a short-lived staging file. Existing
 * byte-identical board files are reused, so a repeat upload never creates a
 * second permanent copy.
 */
export async function saveBoardUploadedFile(input: {
  id: string;
  relativeFileName: string;
  stream: ReadableStream<Uint8Array>;
  reusableFilePaths?: string[];
}): Promise<BoardUploadedFile> {
  const workflow = await getBoardWorkflow(input.id);
  if (!workflow) throw new Error("Board workflow not found.");

  const stagingDir = storagePaths.tmp("board-upload-staging");
  await mkdir(stagingDir, { recursive: true });
  const stagingPath = path.join(stagingDir, `${crypto.randomUUID()}.upload`);
  const hash = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(input.stream as unknown as import("node:stream/web").ReadableStream),
      hashingStream,
      createWriteStream(stagingPath, { flags: "wx" }),
    );
    const bytes = (await stat(stagingPath)).size;
    const sha256 = hash.digest("hex");
    const reusablePaths = Array.from(new Set(input.reusableFilePaths || []));

    for (const candidatePath of reusablePaths) {
      const resolvedCandidate = path.resolve(candidatePath);
      if (!isPathInside(resolvedCandidate, workflow.localDir)) continue;
      const candidateInfo = await stat(resolvedCandidate).catch(() => null);
      if (!candidateInfo?.isFile() || candidateInfo.size !== bytes) continue;
      const candidateSha256 = await sha256File(resolvedCandidate).catch(() => null);
      if (candidateSha256 !== sha256) continue;
      await rm(stagingPath, { force: true });
      return { filePath: resolvedCandidate, sha256, bytes, reused: true };
    }

    const target = resolveSafeRelativePath(workflow.localDir, input.relativeFileName);
    await mkdir(path.dirname(target), { recursive: true });
    // A hard link reserves the target without allowing a same-second name collision to overwrite another upload.
    await link(stagingPath, target);
    await unlink(stagingPath);
    return { filePath: target, sha256, bytes, reused: false };
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const MANUAL_BOARD_EDGE_LABEL = "手动连线";
export const LEGACY_MANUAL_BOARD_EDGE_LABEL = "\u93b5\u5b2a\u59e9\u677b\u70b5\u7eaa";
export const ALT_MANUAL_BOARD_EDGE_LABEL = "手动连接";
const PERSON_REFERENCE_ASSET_ROLES = new Set([
  "identity_image",
  "identity_auxiliary_asset",
  "face_front",
  "face_left",
  "face_right",
  "face_turnaround",
]);

export function uniqueNodeIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

function isTerminalExecutionStatus(status: NonNullable<BoardWorkflowNode["execution"]>["status"] | undefined) {
  return status === "done" || status === "failed" || status === "cancelled";
}

function executionTimestamp(execution: BoardWorkflowNode["execution"] | undefined) {
  const value = execution?.finishedAt || execution?.startedAt || "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Browser PATCH requests contain a full visual snapshot and can arrive after a
 * task route has already recorded a newer terminal state. Keep that server-owned
 * execution state rather than letting an old running snapshot revive the task.
 */
function serverExecutionIsNewer(current: BoardWorkflowNode, incoming: BoardWorkflowNode) {
  const saved = current.execution;
  const proposed = incoming.execution;
  if (!saved) return false;
  if (!proposed) return saved.status === "running" || isTerminalExecutionStatus(saved.status);

  // A video task ID is a server-owned, billable-task checkpoint. A browser can
  // still hold the earlier "running, no task ID yet" snapshot while the submit
  // route has already persisted the upstream task. The two snapshots share the
  // same runId and startedAt, so timestamp-only conflict checks would let that
  // stale visual PATCH erase the only recovery handle for the remote task.
  // Starting a genuinely new run never goes through this browser merge path;
  // startNodeExecution writes the server state directly after clearing the old
  // run. Therefore a saved task ID must always win over a client snapshot that
  // omits it or names a different task.
  if (saved.videoJob?.taskId && saved.videoJob.taskId !== proposed.videoJob?.taskId) return true;

  if (saved.runId && saved.runId !== proposed.runId) return true;
  if (
    saved.clientTaskId &&
    proposed.clientTaskId &&
    saved.clientTaskId !== proposed.clientTaskId &&
    saved.status !== "pending"
  ) return true;
  if (isTerminalExecutionStatus(saved.status) && !isTerminalExecutionStatus(proposed.status)) return true;

  const savedAt = executionTimestamp(saved);
  const proposedAt = executionTimestamp(proposed);
  return savedAt > proposedAt && saved.status !== proposed.status;
}

/** Merges visual client edits without allowing stale snapshots to overwrite task lifecycle state. */
export function mergeBoardNodesFromClientPatch(
  current: BoardWorkflowNode[],
  incoming: BoardWorkflowNode[] | undefined,
  deletedNodeIds: Set<string>,
  allowedRoot?: string,
) {
  if (!incoming) return undefined;
  const currentById = new Map(current.map((node) => [node.id, node]));
  const sanitizeFilePath = (filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath.trim() || !allowedRoot) return undefined;
    const candidate = path.resolve(filePath.trim());
    return isPathInside(candidate, allowedRoot) ? candidate : undefined;
  };
  const acceptedIncoming = incoming
    .filter((node) => !deletedNodeIds.has(node.id))
    .map((node) => ({
      ...node,
      ...(node.filePath !== undefined ? {
        // Server imports may legitimately reference this owner's identity pack
        // outside the board directory. Preserve only an identical saved path.
        filePath: node.filePath === currentById.get(node.id)?.filePath
          ? currentById.get(node.id)?.filePath : sanitizeFilePath(node.filePath),
      } : {}),
    }));
  const incomingIds = new Set(acceptedIncoming.map((node) => node.id));
  const mergedIncoming = acceptedIncoming.map((node) => {
    const saved = currentById.get(node.id);
    return {
      ...node,
      ...(saved && serverExecutionIsNewer(saved, node) ? { status: saved.status, error: saved.error } : {}),
      // Task IDs, provider checkpoints and cleanup credentials are server-owned.
      // Even a newly added browser node must not inject an upstream task handle.
      execution: saved?.execution,
    };
  });
  const preserved = current.filter((node) => !incomingIds.has(node.id) && !deletedNodeIds.has(node.id));
  return [...mergedIncoming, ...preserved];
}

export function removeDeletedNodeReferences(
  nodes: BoardWorkflowNode[],
  deletedNodeIds: Set<string>
) {
  if (deletedNodeIds.size === 0) return nodes;
  const filterIds = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !deletedNodeIds.has(item))
    : value;

  return nodes
    .filter((node) => !deletedNodeIds.has(node.id))
    .map((node) => {
      const execution = node.execution ? {
        ...node.execution,
        inputNodeIds: filterIds(node.execution.inputNodeIds) as string[] | undefined,
        outputNodeIds: filterIds(node.execution.outputNodeIds) as string[] | undefined,
        videoJob: node.execution.videoJob ? {
          ...node.execution.videoJob,
          directorNodeId: deletedNodeIds.has(node.execution.videoJob.directorNodeId)
            ? ""
            : node.execution.videoJob.directorNodeId,
          referenceNodeIds: filterIds(node.execution.videoJob.referenceNodeIds) as string[],
          outputNodeIds: filterIds(node.execution.videoJob.outputNodeIds) as string[] | undefined,
        } : undefined,
      } : undefined;
      const meta = node.meta ? { ...node.meta } : undefined;
      if (meta && Array.isArray(meta.referenceNodeIds)) meta.referenceNodeIds = filterIds(meta.referenceNodeIds);
      if (meta && meta.videoTaskReferenceIds && typeof meta.videoTaskReferenceIds === "object" && !Array.isArray(meta.videoTaskReferenceIds)) {
        meta.videoTaskReferenceIds = Object.fromEntries(
          Object.entries(meta.videoTaskReferenceIds as Record<string, unknown>)
            .map(([key, value]) => [key, filterIds(value)])
        );
      }
      return { ...node, execution, meta };
    });
}

/** Person-reference inputs are opt-in and require a manual board connection. */
export function isBoardPersonReferenceNode(node?: Pick<BoardWorkflowNode, "meta"> | null) {
  return PERSON_REFERENCE_ASSET_ROLES.has(String(node?.meta?.assetRole || ""));
}

/** Direct manual inputs are the explicit asset-selection contract for an execution node. */
export function manualDirectInputNodeIds(workflow: Pick<BoardWorkflow, "edges">, targetId: string) {
  return collectManualDirectInputNodeIds(workflow, targetId);
}

export function manualUpstreamNodeIds(workflow: Pick<BoardWorkflow, "edges">, targetIds: string[]) {
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [...targetIds];
  while (stack.length > 0) {
    const targetId = stack.pop();
    if (!targetId || visited.has(targetId)) continue;
    visited.add(targetId);
    const upstreamEdges = workflow.edges.filter((edge) => edge.to === targetId && isManualBoardEdge(edge));
    for (const edge of upstreamEdges) {
      if (!result.includes(edge.from)) result.push(edge.from);
      stack.push(edge.from);
    }
  }
  return result;
}

export function downstreamNodeIds(workflow: Pick<BoardWorkflow, "edges">, sourceIds: string[]) {
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [...sourceIds];
  while (stack.length > 0) {
    const sourceId = stack.pop();
    if (!sourceId || visited.has(sourceId)) continue;
    visited.add(sourceId);
    const downstreamEdges = workflow.edges.filter((edge) => edge.from === sourceId);
    for (const edge of downstreamEdges) {
      if (!result.includes(edge.to)) result.push(edge.to);
      stack.push(edge.to);
    }
  }
  return result;
}

export function markNodeExecution(
  nodes: BoardWorkflowNode[],
  nodeId: string,
  patch: NonNullable<BoardWorkflowNode["execution"]>,
  status?: BoardWorkflowNode["status"]
) {
  if (!nodeId) return nodes;
  return nodes.map((node) => {
    if (node.id !== nodeId) return node;
    return {
      ...node,
      status: status ?? node.status,
      error: patch.error !== undefined ? patch.error : (status === "running" ? "" : node.error),
      execution: {
        ...node.execution,
        ...patch,
      },
    };
  });
}

export function markNodeExecutionsInterruptedByRestart(
  nodes: BoardWorkflowNode[],
  processStartedAtMs = Date.now() - process.uptime() * 1000
) {
  const cutoff = processStartedAtMs - 1000;
  const finishedAt = nowIso();
  let changed = false;
  const next = nodes.map((node) => {
    if (node.execution?.status !== "running") return node;
    if (node.execution.videoJob?.taskId && ["submitted", "queued", "running", "completed_pending_content"].includes(node.execution.videoJob.status)) {
      return node;
    }
    const startedAt = Date.parse(node.execution.startedAt || "");
    if (Number.isFinite(startedAt) && startedAt >= cutoff) return node;
    changed = true;
    const error = "3100 服务重启，先前运行中的任务已经中断。若存在已保全结果，请使用“继续保存结果”；否则请重新执行。";
    return {
      ...node,
      status: "failed" as const,
      error,
      execution: {
        ...node.execution,
        status: "failed" as const,
        finishedAt,
        summary: "服务重启后已结束遗留任务",
        error,
      },
    };
  });
  return changed ? next : nodes;
}

export async function updateNodeExecution(
  id: string,
  nodeId: string,
  patch: NonNullable<BoardWorkflowNode["execution"]>,
  status?: BoardWorkflowNode["status"],
) {
  if (!nodeId) return null;
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  // Cancellation is a terminal user decision for this execution. Long-running
  // requests can finish after the cancel route has persisted its state; those
  // late progress or completion writes must never revive the cancelled node.
  // A cancellation follow-up is still allowed so it can record the real
  // temporary-reference cleanup receipt.
  if (
    isNodeExecutionCancelled(workflow, nodeId)
    && patch.status !== "cancelled"
  ) {
    return workflow;
  }
  return updateBoardWorkflow(id, {
    nodes: markNodeExecution(workflow.nodes, nodeId, patch, status),
  }, workflow.revision ?? 0);
}

export async function startNodeExecution(
  id: string,
  nodeId: string,
  inputNodeIds: string[] = [],
  clientTaskId = ""
) {
  if (!nodeId) return null;
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  const runId = crypto.randomUUID();
  const nodes = markNodeExecution(workflow.nodes, nodeId, {
    runId,
    clientTaskId: clientTaskId || undefined,
    status: "running",
    startedAt: nowIso(),
    finishedAt: undefined,
    inputNodeIds: uniqueNodeIds(inputNodeIds),
    outputNodeIds: [],
    summary: "",
    error: "",
    // A new execution cannot inherit a previous video task or its temporary
    // reference cleanup audit. Keeping either would make the node show the
    // prior task's Cloudinary counts while this run is still submitting.
    videoJob: undefined,
    referenceCleanup: undefined,
  }, "running");
  return updateBoardWorkflow(id, { nodes }, workflow.revision ?? 0);
}

export async function finishNodeExecution(
  id: string,
  nodeId: string,
  inputNodeIds: string[],
  outputNodeIds: string[],
  summary?: string
) {
  if (!nodeId) return null;
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  if (isNodeExecutionCancelled(workflow, nodeId)) return workflow;
  const nodes = markNodeExecution(workflow.nodes, nodeId, {
    status: "done",
    finishedAt: nowIso(),
    inputNodeIds: uniqueNodeIds(inputNodeIds),
    outputNodeIds: uniqueNodeIds(outputNodeIds),
    summary,
    error: "",
  }, "done");
  return updateBoardWorkflow(id, { nodes }, workflow.revision ?? 0);
}

export async function deferNodeExecution(id: string, nodeId: string, inputNodeIds: string[], summary: string) {
  if (!nodeId) return null;
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  if (isNodeExecutionCancelled(workflow, nodeId)) return workflow;
  const nodes = markNodeExecution(workflow.nodes, nodeId, {
    status: "pending",
    finishedAt: undefined,
    inputNodeIds: uniqueNodeIds(inputNodeIds),
    outputNodeIds: [],
    summary,
    error: "",
  }, "pending");
  return updateBoardWorkflow(id, { nodes }, workflow.revision ?? 0);
}

export async function failNodeExecution(id: string, nodeId: string, inputNodeIds: string[], error: string) {
  if (!nodeId) return null;
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  if (isNodeExecutionCancelled(workflow, nodeId)) return workflow;
  const nodes = markNodeExecution(workflow.nodes, nodeId, {
    status: "failed",
    finishedAt: nowIso(),
    inputNodeIds: uniqueNodeIds(inputNodeIds),
    outputNodeIds: [],
    summary: "执行失败",
    error,
  }, "failed");
  return updateBoardWorkflow(id, { nodes }, workflow.revision ?? 0);
}

export function isNodeExecutionCancelled(workflow: Pick<BoardWorkflow, "nodes">, nodeId: string) {
  if (!nodeId) return false;
  return workflow.nodes.find((node) => node.id === nodeId)?.execution?.status === "cancelled";
}

export async function cancelNodeExecution(id: string, nodeId: string, reason = "用户取消，未保留本次输出") {
  if (!nodeId) return null;
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  const nodes = markNodeExecution(workflow.nodes, nodeId, {
    status: "cancelled",
    finishedAt: nowIso(),
    inputNodeIds: [],
    outputNodeIds: [],
    summary: reason,
    error: "",
  }, "pending");
  return updateBoardWorkflow(id, { nodes }, workflow.revision ?? 0);
}

export async function appendBoardNodes(id: string, nodes: BoardWorkflowNode[], edges: BoardWorkflowEdge[] = [], status?: BoardWorkflowStatus) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  return updateBoardWorkflow(id, {
    nodes: [...workflow.nodes, ...nodes],
    edges: [...workflow.edges, ...edges],
    status: status ?? workflow.status,
  }, workflow.revision ?? 0);
}

function safeArtifactPart(value: string, fallback: string) {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function boardArtifactTimestamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

/** Names new board artifacts by their business role; upstream ids stay in node metadata. */
export function boardArtifactFileName(
  workflow: Pick<BoardWorkflow, "name">,
  label: string,
  extension: string,
  options: { version?: number; timestamp?: Date; suffix?: string } = {},
) {
  const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  const boardName = safeArtifactPart(workflow.name, "画板");
  const businessLabel = safeArtifactPart(label, "资产");
  const version = options.version && options.version > 1 ? `-v${String(options.version).padStart(2, "0")}` : "";
  const suffix = options.suffix ? `-${safeArtifactPart(options.suffix, "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}` : "";
  return `${boardName}-${businessLabel}${version}-${boardArtifactTimestamp(options.timestamp)}${suffix}${ext}`;
}

export function boardArtifactRelativePath(directory: BoardArtifactDirectory, fileName: string) {
  return `${directory}/${path.basename(fileName)}`;
}

function relativeBoardFilePath(filePath: string) {
  const relative = path.relative(STORE_DIR, filePath).replace(/\\/g, "/");
  const [, ...fileParts] = relative.split("/").filter(Boolean);
  if (fileParts.length === 0 || fileParts.some((part) => part === "." || part === "..")) {
    throw new Error("Board file path is outside board storage.");
  }
  return fileParts.join("/");
}

export function boardFilePublicUrl(id: string, filePath: string) {
  const workflowId = safeId(id);
  return `/api/board-workflows/${workflowId}/file/${encodeURIComponent(relativeBoardFilePath(filePath))}`;
}

export async function boardFilePath(id: string, fileName: string, ownerId?: string) {
  const workflow = await getBoardWorkflow(id, ownerId);
  if (!workflow) throw new Error("Board workflow not found.");
  return resolveSafeRelativePath(workflow.localDir, fileName);
}

export async function copyIntoBoard(id: string, sourcePath: string, relativeFileName: string) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  const ext = path.extname(sourcePath) || ".mp4";
  const normalizedName = relativeFileName.replace(/\\/g, "/");
  const relativePath = path.extname(normalizedName) ? normalizedName : `${normalizedName}${ext}`;
  const target = resolveSafeRelativePath(workflow.localDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
  return target;
}

export async function writeBoardBuffer(id: string, fileName: string, buffer: Buffer) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  const target = resolveSafeRelativePath(workflow.localDir, fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return target;
}

export async function writeUniqueBoardBuffer(id: string, baseName: string, extension: string, buffer: Buffer) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  const normalizedBaseName = baseName.replace(/\\/g, "/");
  const pathParts = normalizedBaseName.split("/").filter(Boolean);
  const safeBaseName = path.basename(pathParts.pop() || "图片资产") || "图片资产";
  const relativeDirectory = pathParts.join("/");
  const normalizedExtension = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;

  for (let sequence = 1; sequence <= 999; sequence++) {
    const suffix = sequence === 1 ? "" : `-${String(sequence).padStart(2, "0")}`;
    const relativePath = [relativeDirectory, `${safeBaseName}${suffix}${normalizedExtension}`].filter(Boolean).join("/");
    const target = resolveSafeRelativePath(workflow.localDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, buffer, { flag: "wx" });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  throw new Error("图片文件名冲突过多，无法安全保存新图片。");
}

export async function readBoardFile(id: string, fileName: string) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  if (!isPathInsideRoot(workflow.localDir, STORE_DIR)) throw new Error("Board workflow storage directory is invalid.");
  const target = resolveSafeRelativePath(workflow.localDir, fileName);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Board file not found.");
  return readFile(target);
}

export async function listBoardFiles(id: string, filter?: RegExp) {
  const workflow = await getBoardWorkflow(id);
  if (!workflow) throw new Error("Board workflow not found.");
  if (!existsSync(workflow.localDir)) return [];
  const files = await readdir(workflow.localDir);
  return files.filter((name) => !filter || filter.test(name)).map((name) => path.join(workflow.localDir, name));
}

export function mimeFromFileName(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mp3") return "audio/mpeg";
  return "application/octet-stream";
}

export function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error("Unsupported data URL.");
  const mimeType = match[1];
  const bytes = Buffer.from(match[2], "base64");
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("webm") ? "webm" : mimeType.includes("jpeg") ? "jpg" : "png";
  return { mimeType, bytes, ext };
}
