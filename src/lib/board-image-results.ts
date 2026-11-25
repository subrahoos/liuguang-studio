import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BoardImageGenerationTiming {
  clientStartedAtMs?: number;
  serverReceivedAtMs?: number;
  upstreamRequestStartedAtMs?: number;
  responseHeadersAtMs?: number;
  firstResponseByteAtMs?: number;
  responseBodyCompletedAtMs?: number;
  upstreamProcessingMs?: number;
  resultTransferMs?: number;
  responseFirstByteWaitMs?: number;
  responseBodyTransferMs?: number;
  responseChunkCount?: number;
  responseMaxChunkGapMs?: number;
  responseAverageBytesPerSecond?: number;
  upstreamTotalMs?: number;
  responseBodyBytes?: number;
  clickToUpstreamHeadersMs?: number;
  clickToResponseCompleteMs?: number;
  localSaveMs?: number;
  localSaveCompletedAtMs?: number;
  clickToLocalSaveMs?: number;
  boardPersistedAtMs?: number;
  clickToBoardPersistedMs?: number;
  clientVisibleAtMs?: number;
  clickToClientVisibleMs?: number;
  totalMs?: number;
}

export interface BoardImagePendingResult {
  id: string;
  workflowId: string;
  ownerId: string;
  executorNodeId: string;
  role: string;
  title: string;
  description: string;
  promptEnglish: string;
  promptMetadata?: Record<string, unknown>;
  referenceNodeIds: string[];
  provider: string;
  model: string;
  taskId?: string;
  transport: "b64_json" | "url";
  payload: string;
  requestedWidth?: number;
  requestedHeight?: number;
  x: number;
  y: number;
  filePath?: string;
  fileExtension?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  generationTiming?: BoardImageGenerationTiming;
}

export type BoardImagePendingResultSummary = Omit<BoardImagePendingResult, "payload">;

function pendingDirectory(localDir: string) {
  return path.join(localDir, "pending-image-results");
}

function safePendingId(value: string) {
  if (!/^board-image-pending-[a-zA-Z0-9-]+$/.test(value)) {
    throw new Error("Invalid board pending image result id.");
  }
  return value;
}

function pendingFile(localDir: string, pendingId: string) {
  return path.join(pendingDirectory(localDir), `${safePendingId(pendingId)}.json`);
}

async function writePendingResult(localDir: string, result: BoardImagePendingResult) {
  const target = pendingFile(localDir, result.id);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(pendingDirectory(localDir), { recursive: true });
  await writeFile(temporary, JSON.stringify(result), "utf8");
  await rename(temporary, target);
}

export function summarizeBoardImagePendingResult(result: BoardImagePendingResult): BoardImagePendingResultSummary {
  const summary = { ...result } as Partial<BoardImagePendingResult>;
  delete summary.payload;
  return summary as BoardImagePendingResultSummary;
}

export async function saveBoardImagePendingResult(
  localDir: string,
  input: Omit<BoardImagePendingResult, "id" | "createdAt" | "updatedAt">
) {
  const now = new Date().toISOString();
  const result: BoardImagePendingResult = {
    ...input,
    id: `board-image-pending-${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  };
  await writePendingResult(localDir, result);
  return result;
}

export async function getBoardImagePendingResult(localDir: string, pendingId: string) {
  const file = pendingFile(localDir, pendingId);
  if (!existsSync(file)) return null;
  try {
    const result = JSON.parse(await readFile(file, "utf8")) as BoardImagePendingResult;
    return result?.id === pendingId && result?.workflowId ? result : null;
  } catch {
    return null;
  }
}

export async function listBoardImagePendingResults(localDir: string) {
  const directory = pendingDirectory(localDir);
  if (!existsSync(directory)) return [] as BoardImagePendingResultSummary[];
  const results: BoardImagePendingResultSummary[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const result = JSON.parse(await readFile(path.join(directory, name), "utf8")) as BoardImagePendingResult;
      if (result?.id && result.workflowId && result.executorNodeId) {
        results.push(summarizeBoardImagePendingResult(result));
      }
    } catch {
      // A half-written recovery record must not make the board unavailable.
    }
  }
  return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updateBoardImagePendingResult(
  localDir: string,
  pendingId: string,
  patch: Pick<BoardImagePendingResult, "lastError" | "generationTiming" | "filePath" | "fileExtension">
) {
  const current = await getBoardImagePendingResult(localDir, pendingId);
  if (!current) throw new Error("待恢复的画板图片结果不存在或已完成保存。");
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writePendingResult(localDir, next);
  return next;
}

export async function deleteBoardImagePendingResult(localDir: string, pendingId: string) {
  await unlink(pendingFile(localDir, pendingId)).catch(() => undefined);
}
