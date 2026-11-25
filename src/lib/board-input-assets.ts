import type { BoardWorkflow, BoardWorkflowNode } from "@/lib/board-workflows";

export const CURRENT_REFERENCE_VIDEO_META_KEY = "currentReferenceVideo";
export const CURRENT_PRODUCT_GROUP_ID_META_KEY = "currentProductGroupId";
export const CURRENT_PRODUCT_GROUP_NODE_IDS_META_KEY = "currentProductGroupNodeIds";

export function newReferenceVideoPosition(
  workflow: Pick<BoardWorkflow, "nodes">,
  executorNodeId: string,
) {
  const executor = workflow.nodes.find((node) => node.id === executorNodeId);
  return {
    x: (executor?.x ?? 40) + 420,
    y: executor?.y ?? 260,
  };
}

/** Place generated audio below its reference video, keeping both assets in the same board area. */
export function newAudioPosition(
  workflow: Pick<BoardWorkflow, "nodes">,
  sourceNodeId: string | undefined,
  executorNodeId: string,
) {
  const source = sourceNodeId
    ? workflow.nodes.find((node) => node.id === sourceNodeId)
    : undefined;
  if (source) return { x: source.x, y: source.y + 520 };
  const reference = newReferenceVideoPosition(workflow, executorNodeId);
  return { x: reference.x, y: reference.y + 520 };
}

function stringIds(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0)))
    : [];
}

export function currentReferenceVideoNode(workflow?: Pick<BoardWorkflow, "sourceVideoPath" | "nodes"> | null) {
  if (!workflow) return undefined;
  const sources = workflow.nodes.filter((node) => node.kind === "source_video" && Boolean(node.filePath));
  return sources.find((node) => node.filePath === workflow.sourceVideoPath)
    || sources.find((node) => node.meta?.[CURRENT_REFERENCE_VIDEO_META_KEY] === true)
    || [...sources].sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0];
}

export function markCurrentReferenceVideo(nodes: BoardWorkflowNode[], currentNodeId: string) {
  return nodes.map((node) => {
    if (node.kind !== "source_video") return node;
    const meta = { ...(node.meta || {}) };
    if (node.id === currentNodeId) meta[CURRENT_REFERENCE_VIDEO_META_KEY] = true;
    else delete meta[CURRENT_REFERENCE_VIDEO_META_KEY];
    return { ...node, meta };
  });
}

export function currentProductGroup(
  ownerNode: BoardWorkflowNode | undefined,
  nodes: BoardWorkflowNode[],
) {
  const groupId = String(ownerNode?.meta?.[CURRENT_PRODUCT_GROUP_ID_META_KEY] || "").trim();
  const requestedIds = stringIds(ownerNode?.meta?.[CURRENT_PRODUCT_GROUP_NODE_IDS_META_KEY]);
  const products = requestedIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is BoardWorkflowNode => Boolean(
      node
      && String(node.meta?.assetRole || "") === "product_image"
      && node.filePath,
    ))
    .slice(0, 4);
  return {
    groupId,
    nodeIds: products.map((node) => node.id),
    products,
  };
}

export function setCurrentProductGroup(
  nodes: BoardWorkflowNode[],
  ownerNodeId: string,
  groupId: string,
  productNodeIds: string[],
) {
  const allowedIds = new Set(nodes
    .filter((node) => String(node.meta?.assetRole || "") === "product_image" && Boolean(node.filePath))
    .map((node) => node.id));
  const cleanIds = Array.from(new Set(productNodeIds.filter((id) => allowedIds.has(id)))).slice(0, 4);
  return nodes.map((node) => node.id === ownerNodeId ? {
    ...node,
    meta: {
      ...(node.meta || {}),
      [CURRENT_PRODUCT_GROUP_ID_META_KEY]: groupId,
      [CURRENT_PRODUCT_GROUP_NODE_IDS_META_KEY]: cleanIds,
    },
  } : node);
}
