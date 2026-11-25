const cancelledTasks = new Set<string>();

function taskKey(workflowId: string, clientTaskId?: string) {
  if (!workflowId || !clientTaskId) return "";
  return `${workflowId}:${clientTaskId}`;
}

export function markBoardTaskCancelled(workflowId: string, clientTaskId?: string) {
  const key = taskKey(workflowId, clientTaskId);
  if (key) cancelledTasks.add(key);
}

export function isBoardTaskCancelled(workflowId: string, clientTaskId?: string) {
  const key = taskKey(workflowId, clientTaskId);
  return Boolean(key && cancelledTasks.has(key));
}

export function clearBoardTaskCancellation(workflowId: string, clientTaskId?: string) {
  const key = taskKey(workflowId, clientTaskId);
  if (key) cancelledTasks.delete(key);
}
