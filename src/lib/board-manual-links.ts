import type { BoardWorkflow, BoardWorkflowEdge, BoardWorkflowNode } from "@/lib/board-workflows";

const MANUAL_BOARD_EDGE_LABELS = new Set([
  "手动连线",
  "\u93b5\u5b2a\u59e9\u677b\u70b5\u7eaa",
  "手动连接",
]);

/** True only for user-drawn input authorization links, including legacy labels. */
export function isManualBoardEdge(edge: Pick<BoardWorkflowEdge, "label">) {
  return MANUAL_BOARD_EDGE_LABELS.has(edge.label || "");
}

export function manualDirectInputNodeIds(workflow: Pick<BoardWorkflow, "edges">, targetId: string) {
  return Array.from(new Set(workflow.edges
    .filter((edge) => edge.to === targetId && isManualBoardEdge(edge))
    .map((edge) => edge.from)));
}

/** Video composition accepts only completed generated clips explicitly linked to its video node. */
export function manualDirectGeneratedVideoNodes(
  workflow: Pick<BoardWorkflow, "edges">,
  nodes: BoardWorkflowNode[],
  targetId: string,
) {
  const directInputIds = new Set(manualDirectInputNodeIds(workflow, targetId));
  return nodes.filter((node) =>
    directInputIds.has(node.id)
    && node.kind === "video_clip"
    && Boolean(node.filePath)
    && String(node.meta?.assetRole || "") === "generated_video"
  );
}
