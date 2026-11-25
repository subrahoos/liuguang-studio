import type { BoardWorkflow, BoardWorkflowNode } from "@/lib/board-workflows";

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

/**
 * A client may render "已完成" only when the matching run points to image
 * nodes that have both a persisted local file and a board URL.
 */
export function completedImageExecutionOutputNodes(
  workflow: Pick<BoardWorkflow, "nodes">,
  nodeId: string,
  clientTaskId = ""
) {
  const executor = workflow.nodes.find((node) => node.id === nodeId);
  const execution = executor?.execution;
  if (!execution || execution.status !== "done") return null;
  if (clientTaskId && execution.clientTaskId !== clientTaskId) return null;
  const outputIds = uniqueIds(execution.outputNodeIds || []);
  if (outputIds.length === 0) return null;
  const outputs = outputIds
    .map((outputId) => workflow.nodes.find((node) => node.id === outputId))
    .filter((node): node is BoardWorkflowNode => Boolean(node));
  if (
    outputs.length !== outputIds.length ||
    outputs.some((node) => node.kind !== "image_asset" || !node.filePath || !node.publicUrl)
  ) {
    return null;
  }
  return outputs;
}

/**
 * A 5xx without a matching terminal workflow can be a broken browser/proxy
 * response while the local image route keeps running. Keep polling in that
 * case. Validation/auth errors and an explicit failed/cancelled execution are
 * definitive and should stop immediately.
 */
export function shouldKeepPollingImageTaskAfterHttpError(
  status: number,
  workflow: Pick<BoardWorkflow, "nodes"> | undefined,
  nodeId: string,
  clientTaskId: string
) {
  if (status < 500) return false;
  const execution = workflow?.nodes.find((node) => node.id === nodeId)?.execution;
  if (
    execution?.clientTaskId === clientTaskId &&
    (execution.status === "failed" || execution.status === "cancelled")
  ) {
    return false;
  }
  return true;
}
