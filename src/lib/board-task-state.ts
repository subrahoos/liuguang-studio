import type { BoardVideoJob, BoardWorkflow, BoardWorkflowNode } from "@/lib/board-workflows";

export type BoardExecutionStatus = NonNullable<BoardWorkflowNode["execution"]>["status"];

const TERMINAL_STATUSES = new Set<BoardExecutionStatus>(["done", "failed", "cancelled"]);

export function boardNodeExecutionStatus(node: BoardWorkflowNode): BoardExecutionStatus {
  if (node.execution?.status) return node.execution.status;
  if (node.status === "running" || node.status === "done" || node.status === "failed") return node.status;
  return "pending";
}

export function isBoardExecutionTerminal(status: BoardExecutionStatus) {
  return TERMINAL_STATUSES.has(status);
}

export function boardExecutionOutputNodes(
  workflow: Pick<BoardWorkflow, "nodes">,
  node: BoardWorkflowNode,
) {
  const outputIds = Array.from(new Set(node.execution?.outputNodeIds || [])).filter(Boolean);
  if (outputIds.length === 0) return [];
  const nodeById = new Map(workflow.nodes.map((item) => [item.id, item]));
  return outputIds.map((id) => nodeById.get(id)).filter((item): item is BoardWorkflowNode => Boolean(item));
}

export function boardExecutionHasPersistedOutputs(
  workflow: Pick<BoardWorkflow, "nodes">,
  node: BoardWorkflowNode,
) {
  const outputIds = Array.from(new Set(node.execution?.outputNodeIds || [])).filter(Boolean);
  if (outputIds.length === 0) return false;
  const outputs = boardExecutionOutputNodes(workflow, node);
  if (outputs.length !== outputIds.length) return false;
  return outputs.every((output) => {
    if (output.kind === "image_asset" || output.kind === "video_clip" || output.kind === "audio") {
      return Boolean(output.filePath && output.publicUrl);
    }
    if (output.kind === "analysis") return Boolean(output.text?.trim());
    if (output.kind === "prompt") return Boolean(output.promptEnglish?.trim() || output.text?.trim());
    return true;
  });
}

export function boardNodeVisibleExecutionStatus(
  workflow: Pick<BoardWorkflow, "nodes">,
  node: BoardWorkflowNode,
): BoardExecutionStatus | "syncing" {
  const status = boardNodeExecutionStatus(node);
  if (status === "done" && !boardExecutionHasPersistedOutputs(workflow, node)) return "syncing";
  return status;
}

export function runningBoardExecutionNodes(workflow: Pick<BoardWorkflow, "nodes">) {
  return workflow.nodes.filter((node) => boardNodeExecutionStatus(node) === "running");
}

/**
 * Builds the browser's immediate execution snapshot. The API response may not
 * arrive until after uploads and upstream task creation, so this snapshot must
 * never display inputs, outputs, task details, or cleanup receipts from the
 * preceding run while the new one is still being prepared.
 */
export function beginBoardClientExecution(
  node: BoardWorkflowNode,
  input: {
    clientTaskId: string;
    startedAt: string;
    summary: string;
    inputNodeIds?: string[];
  },
): BoardWorkflowNode {
  const inputNodeIds = Array.from(new Set((input.inputNodeIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  return {
    ...node,
    status: "running",
    error: "",
    execution: {
      ...node.execution,
      runId: undefined,
      clientTaskId: input.clientTaskId,
      status: "running",
      startedAt: input.startedAt,
      finishedAt: undefined,
      inputNodeIds,
      outputNodeIds: [],
      summary: input.summary,
      error: "",
      videoJob: undefined,
      referenceCleanup: undefined,
    },
  };
}

/**
 * A local execution may be running while media is uploading or before the
 * upstream submit response arrives. It is not a recoverable remote task until
 * the server has actually persisted the returned task ID.
 */
export function boardVideoRemoteTaskId(job?: Pick<BoardVideoJob, "taskId"> | null) {
  return String(job?.taskId || "").trim();
}
