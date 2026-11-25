import { NextRequest, NextResponse } from "next/server";
import {
  BoardWorkflowRevisionConflictError,
  deleteBoardFiles,
  deleteBoardWorkflow,
  getBoardWorkflow,
  markNodeExecutionsInterruptedByRestart,
  mergeBoardNodesFromClientPatch,
  removeDeletedNodeReferences,
  updateBoardWorkflow,
  type BoardWorkflowEdge,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { boardNodeOutputRecoveryKey } from "@/lib/board-output-recovery";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

const MAX_DELETION_TOMBSTONES = 5_000;

function revisionNumber(value: unknown) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

function mergeTombstones(...groups: Array<Iterable<string>>) {
  return Array.from(new Set(groups.flatMap((group) => Array.from(group)))).slice(-MAX_DELETION_TOMBSTONES);
}

function mergeEdges(
  current: BoardWorkflowEdge[],
  incoming: BoardWorkflowEdge[] | undefined,
  finalNodes: BoardWorkflowNode[] | undefined,
  deletedNodeIds: Set<string>,
  deletedEdgeIds: Set<string>
) {
  if (!incoming) return undefined;
  const nodeIds = new Set((finalNodes || []).map((node) => node.id));
  const acceptedIncoming = incoming.filter((edge) => (
    !deletedEdgeIds.has(edge.id)
    && !deletedNodeIds.has(edge.from)
    && !deletedNodeIds.has(edge.to)
    && nodeIds.has(edge.from)
    && nodeIds.has(edge.to)
  ));
  const incomingEdgeIds = new Set(acceptedIncoming.map((edge) => edge.id));
  const preserved = current.filter((edge) => {
    if (incomingEdgeIds.has(edge.id) || deletedEdgeIds.has(edge.id)) return false;
    if (deletedNodeIds.has(edge.from) || deletedNodeIds.has(edge.to)) return false;
    return nodeIds.has(edge.from) && nodeIds.has(edge.to);
  });
  return [...acceptedIncoming, ...preserved];
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    let workflow = await getBoardWorkflow(id, user.id);
    if (!workflow) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });
    const reconciledNodes = markNodeExecutionsInterruptedByRestart(workflow.nodes);
    if (reconciledNodes !== workflow.nodes) {
      workflow = await updateBoardWorkflow(id, { nodes: reconciledNodes }, workflow.revision ?? 0);
    }
    return NextResponse.json({ workflow });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "读取画板工作流失败" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const current = await getBoardWorkflow(id, user.id);
    if (!current) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });
    const expectedRevision = revisionNumber(body.expectedRevision);

    const deleteNodeId = typeof body.deleteNodeId === "string" ? body.deleteNodeId.trim() : "";
    const deleteFilePaths = stringArray(body.deleteFilePaths);

    if (deleteNodeId) {
      const nodeToDelete = current.nodes.find((node) => node.id === deleteNodeId);
      if (!nodeToDelete) return NextResponse.json({ error: "节点不存在或已被移除" }, { status: 404 });

      const removedEdges = current.edges.filter((edge) => edge.from === deleteNodeId || edge.to === deleteNodeId);
      const removedEdgeCount = removedEdges.length;
      const deletedNodeIds = new Set(mergeTombstones(current.deletedNodeIds || [], [deleteNodeId]));
      const deletedEdgeIds = mergeTombstones(current.deletedEdgeIds || [], removedEdges.map((edge) => edge.id));
      const outputKey = boardNodeOutputRecoveryKey(nodeToDelete);
      const suppressedOutputKeys = mergeTombstones(
        current.suppressedOutputKeys || [],
        outputKey ? [outputKey] : [],
      );
      const workflow = await updateBoardWorkflow(id, {
        nodes: removeDeletedNodeReferences(current.nodes, deletedNodeIds),
        edges: current.edges.filter((edge) => edge.from !== deleteNodeId && edge.to !== deleteNodeId),
        deletedNodeIds: Array.from(deletedNodeIds),
        deletedEdgeIds,
        suppressedOutputKeys,
      }, expectedRevision ?? current.revision ?? 0);
      const fileDeletion = deleteFilePaths.length > 0
        ? await deleteBoardFiles(id, deleteFilePaths)
        : undefined;
      return NextResponse.json({ workflow, fileDeletion, removedEdgeCount });
    }

    const requestedDeletedNodeIds = stringArray(body.deletedNodeIds);
    const deletedNodeIds = new Set(mergeTombstones(current.deletedNodeIds || [], requestedDeletedNodeIds));
    const deletedEdgeIds = new Set(mergeTombstones(current.deletedEdgeIds || [], stringArray(body.deletedEdgeIds)));
    const requestedDeletedNodeIdSet = new Set(requestedDeletedNodeIds);
    const suppressedOutputKeys = mergeTombstones(
      current.suppressedOutputKeys || [],
      current.nodes
        .filter((node) => requestedDeletedNodeIdSet.has(node.id))
        .map(boardNodeOutputRecoveryKey)
        .filter(Boolean),
    );
    const incomingNodes = Array.isArray(body.nodes) ? body.nodes as BoardWorkflowNode[] : undefined;
    const incomingEdges = Array.isArray(body.edges) ? body.edges as BoardWorkflowEdge[] : undefined;
    const mergedNodes = removeDeletedNodeReferences(
      mergeBoardNodesFromClientPatch(current.nodes, incomingNodes, deletedNodeIds, current.localDir) || current.nodes,
      deletedNodeIds
    );
    const mergedEdges = mergeEdges(current.edges, incomingEdges, mergedNodes || current.nodes, deletedNodeIds, deletedEdgeIds);

    const workflow = await updateBoardWorkflow(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      status: body.status,
      nodes: mergedNodes,
      edges: mergedEdges,
      deletedNodeIds: Array.from(deletedNodeIds),
      deletedEdgeIds: Array.from(deletedEdgeIds),
      suppressedOutputKeys,
    }, expectedRevision ?? current.revision ?? 0);
    const fileDeletion = deleteFilePaths.length > 0
      ? await deleteBoardFiles(id, deleteFilePaths)
      : undefined;
    return NextResponse.json({ workflow, fileDeletion });
  } catch (error) {
    if (error instanceof BoardWorkflowRevisionConflictError) {
      return NextResponse.json({ error: error.message, workflow: error.workflow }, { status: 409 });
    }
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "更新画板工作流失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const workflow = await getBoardWorkflow(id, user.id);
    if (!workflow) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });
    return NextResponse.json(await deleteBoardWorkflow(id, workflow.revision ?? 0));
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "删除画板工作流失败" },
      { status: 500 }
    );
  }
}
