import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authUsers, modelApiCalls } from "@/lib/db/schema";

export type ModelApiCallType = "llm" | "image" | "video";
export type ModelApiCallStatus = "success" | "error";

export type ModelApiAuditContext = {
  userId: string;
  callType: ModelApiCallType;
  providerKey: string;
  channelId?: string;
  channelName?: string;
  model?: string;
  source: string;
  projectId?: string;
  boardWorkflowId?: string;
  boardNodeId?: string;
  quickCutTaskId?: string;
  productProductionTaskId?: string;
  productProductionJobId?: string;
};

export type ModelApiUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  values?: Record<string, number>;
};

export type RecordModelApiCallInput = ModelApiAuditContext & {
  id?: string;
  parentCallId?: string;
  attemptNumber?: number;
  status: ModelApiCallStatus;
  httpStatus?: number;
  remoteTaskId?: string;
  durationMs: number;
  usage?: ModelApiUsage;
  errorCode?: string;
  errorMessage?: string;
  createdAt?: Date;
  completedAt?: Date;
};

const MAX_TEXT_LENGTH = 240;
const MAX_ID_LENGTH = 180;

/** Knowledge of a provider task ID must not grant access to another user's result. */
export async function ownsModelApiTask(userId: string, channelId: string, providerKey: string, taskId: string) {
  const row = await getDb().select({ id: modelApiCalls.id }).from(modelApiCalls).where(and(
    eq(modelApiCalls.userId, userId), eq(modelApiCalls.channelId, channelId),
    eq(modelApiCalls.providerKey, providerKey), eq(modelApiCalls.remoteTaskId, taskId),
    eq(modelApiCalls.callType, "video"),
  )).limit(1);
  return row.length > 0;
}

function boundedText(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedId(value: unknown) {
  return boundedText(value, MAX_ID_LENGTH) || undefined;
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

/** Persist only numeric provider usage fields. Never persist a raw provider payload. */
export function normalizeModelApiUsage(payload: unknown): ModelApiUsage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const usage = payload as Record<string, unknown>;
  const promptTokens = positiveInteger(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens);
  const completionTokens = positiveInteger(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens);
  const totalTokens = positiveInteger(usage.total_tokens ?? usage.totalTokens);
  const values = Object.fromEntries([
    ["prompt_tokens", promptTokens],
    ["completion_tokens", completionTokens],
    ["total_tokens", totalTokens],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  if (!Object.keys(values).length) return undefined;
  return { promptTokens, completionTokens, totalTokens, values };
}

function safeErrorMessage(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? boundedText((error as { code?: unknown }).code, 80)
    : "";
  if (code === "TIMEOUT" || code === "POLL_TIMEOUT") return "模型服务请求超时。";
  if (code === "NETWORK_ERROR") return "模型服务网络连接失败。";
  if (code === "API_ERROR") return "模型服务返回请求错误。";
  return "模型服务请求失败。";
}

export function modelApiErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return boundedText((error as { code?: unknown }).code, 80) || undefined;
}

export async function recordModelApiCall(input: RecordModelApiCallInput) {
  const id = input.id || crypto.randomUUID();
  const createdAt = input.createdAt ?? new Date();
  const completedAt = input.completedAt ?? new Date();
  const usage = input.usage;
  await getDb().insert(modelApiCalls).values({
    id,
    userId: input.userId,
    callType: input.callType,
    providerKey: boundedText(input.providerKey, 100) || "unknown",
    channelId: boundedId(input.channelId),
    channelName: boundedText(input.channelName) || null,
    model: boundedText(input.model) || null,
    source: boundedText(input.source, 120) || "unknown",
    projectId: boundedId(input.projectId),
    boardWorkflowId: boundedId(input.boardWorkflowId),
    boardNodeId: boundedId(input.boardNodeId),
    quickCutTaskId: boundedId(input.quickCutTaskId),
    productProductionTaskId: boundedId(input.productProductionTaskId),
    productProductionJobId: boundedId(input.productProductionJobId),
    parentCallId: boundedId(input.parentCallId),
    attemptNumber: Math.max(1, positiveInteger(input.attemptNumber) ?? 1),
    status: input.status,
    httpStatus: positiveInteger(input.httpStatus),
    remoteTaskId: boundedId(input.remoteTaskId),
    durationMs: Math.max(0, positiveInteger(input.durationMs) ?? 0),
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
    totalTokens: usage?.totalTokens,
    usageJson: usage?.values,
    errorCode: boundedText(input.errorCode, 80) || null,
    errorMessage: input.status === "error" ? boundedText(input.errorMessage) || "模型服务请求失败。" : null,
    createdAt,
    completedAt,
  });
  return id;
}

async function recordWithoutBlocking(input: RecordModelApiCallInput) {
  try {
    return await recordModelApiCall(input);
  } catch {
    return input.id || "";
  }
}

export async function auditModelApiCall<T>(
  context: ModelApiAuditContext,
  execute: () => Promise<T>,
  options: {
    parentCallId?: string;
    attemptNumber?: number;
    toResult?: (result: T) => { httpStatus?: number; remoteTaskId?: string; usage?: ModelApiUsage };
    toError?: (result: T) => { errorCode?: string; errorMessage?: string } | undefined;
  } = {},
) {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const startedAt = Date.now();
  try {
    const result = await execute();
    const detail = options.toResult?.(result) ?? {};
    const failure = options.toError?.(result);
    await recordWithoutBlocking({
      ...context,
      id,
      parentCallId: options.parentCallId,
      attemptNumber: options.attemptNumber,
      status: failure ? "error" : "success",
      durationMs: Date.now() - startedAt,
      httpStatus: detail.httpStatus,
      remoteTaskId: detail.remoteTaskId,
      usage: detail.usage,
      errorCode: failure?.errorCode,
      errorMessage: failure?.errorMessage,
      createdAt,
      completedAt: new Date(),
    });
    return result;
  } catch (error) {
    await recordWithoutBlocking({
      ...context,
      id,
      parentCallId: options.parentCallId,
      attemptNumber: options.attemptNumber,
      status: "error",
      durationMs: Date.now() - startedAt,
      httpStatus: error && typeof error === "object"
        ? positiveInteger((error as { statusCode?: unknown; status?: unknown }).statusCode
          ?? (error as { status?: unknown }).status)
        : undefined,
      errorCode: modelApiErrorCode(error),
      errorMessage: safeErrorMessage(error),
      createdAt,
      completedAt: new Date(),
    });
    throw error;
  }
}

export type ModelApiCallQuery = {
  userId?: string;
  callType?: ModelApiCallType;
  status?: ModelApiCallStatus;
  channelId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

export async function listModelApiCalls(query: ModelApiCallQuery = {}) {
  const conditions = [];
  if (query.userId) conditions.push(eq(modelApiCalls.userId, query.userId));
  if (query.callType) conditions.push(eq(modelApiCalls.callType, query.callType));
  if (query.status) conditions.push(eq(modelApiCalls.status, query.status));
  if (query.channelId) conditions.push(eq(modelApiCalls.channelId, query.channelId));
  if (query.from) conditions.push(gte(modelApiCalls.createdAt, query.from));
  if (query.to) conditions.push(lte(modelApiCalls.createdAt, query.to));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  return getDb()
    .select({
      id: modelApiCalls.id,
      userId: modelApiCalls.userId,
      username: authUsers.username,
      accountId: authUsers.accountId,
      callType: modelApiCalls.callType,
      providerKey: modelApiCalls.providerKey,
      channelId: modelApiCalls.channelId,
      channelName: modelApiCalls.channelName,
      model: modelApiCalls.model,
      source: modelApiCalls.source,
      projectId: modelApiCalls.projectId,
      boardWorkflowId: modelApiCalls.boardWorkflowId,
      boardNodeId: modelApiCalls.boardNodeId,
      quickCutTaskId: modelApiCalls.quickCutTaskId,
      parentCallId: modelApiCalls.parentCallId,
      attemptNumber: modelApiCalls.attemptNumber,
      status: modelApiCalls.status,
      httpStatus: modelApiCalls.httpStatus,
      remoteTaskId: modelApiCalls.remoteTaskId,
      durationMs: modelApiCalls.durationMs,
      promptTokens: modelApiCalls.promptTokens,
      completionTokens: modelApiCalls.completionTokens,
      totalTokens: modelApiCalls.totalTokens,
      usageJson: modelApiCalls.usageJson,
      errorCode: modelApiCalls.errorCode,
      errorMessage: modelApiCalls.errorMessage,
      createdAt: modelApiCalls.createdAt,
      completedAt: modelApiCalls.completedAt,
    })
    .from(modelApiCalls)
    .innerJoin(authUsers, eq(modelApiCalls.userId, authUsers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(modelApiCalls.createdAt), desc(modelApiCalls.id))
    .limit(limit)
    .offset(offset);
}
