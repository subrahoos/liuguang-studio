import type { BoardWorkflowEdge, BoardWorkflowNode } from "@/lib/board-workflows";

export function createNode(
  input: Omit<BoardWorkflowNode, "id" | "createdAt" | "status"> & { status?: BoardWorkflowNode["status"] }
) {
  return {
    id: crypto.randomUUID(),
    status: "done",
    createdAt: new Date().toISOString(),
    ...input,
  } satisfies BoardWorkflowNode;
}

export function createEdge(from: string, to: string, label?: string) {
  return {
    id: crypto.randomUUID(),
    from,
    to,
    label,
  } satisfies BoardWorkflowEdge;
}
