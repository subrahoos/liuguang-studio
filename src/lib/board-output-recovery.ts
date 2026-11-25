type BoardOutputMeta = Record<string, unknown> | undefined;

type BoardOutputNode = {
  meta?: BoardOutputMeta;
};

type BoardOutputSuppressionState = {
  suppressedOutputKeys?: string[];
};

export function boardOutputRecoveryKey(assetRole: unknown, taskId: unknown, executorNodeId?: unknown) {
  const role = String(assetRole || "").trim();
  const task = String(taskId || "").trim();
  const executor = String(executorNodeId || "").trim();
  if (!role || !task) return "";
  return JSON.stringify([role, task, executor]);
}

export function boardNodeOutputRecoveryKey(node: BoardOutputNode | null | undefined) {
  return boardOutputRecoveryKey(
    node?.meta?.assetRole,
    node?.meta?.taskId,
    node?.meta?.executorNodeId,
  );
}

export function isBoardOutputRecoverySuppressed(
  workflow: BoardOutputSuppressionState | null | undefined,
  assetRole: unknown,
  taskId: unknown,
  executorNodeId?: unknown,
) {
  const keys = new Set(workflow?.suppressedOutputKeys || []);
  const exact = boardOutputRecoveryKey(assetRole, taskId, executorNodeId);
  if (!exact) return false;
  if (keys.has(exact)) return true;
  const taskWide = boardOutputRecoveryKey(assetRole, taskId);
  return Boolean(taskWide && keys.has(taskWide));
}
