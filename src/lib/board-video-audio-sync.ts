import { createEdge, type BoardWorkflowEdge, type BoardWorkflowNode } from "@/lib/board-workflows";
import { isReplaceableVideoEvidenceNode } from "@/lib/video-evidence";

const DIRECT_VIDEO_AUDIO_SELECTION_KEY = "directVideoReplacementAudioNodeId";

function edgeKey(edge: Pick<BoardWorkflowEdge, "from" | "to" | "label">) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label || ""}`;
}

/**
 * Re-importing a reference video replaces automatic evidence nodes. Preserve
 * the user's direct-video audio wiring by remapping only selections that point
 * at an automatic audio node which no longer exists. A surviving manual audio
 * selection is intentionally left untouched.
 */
export function synchronizeAutomaticAudioReferences(input: {
  previousNodes: BoardWorkflowNode[];
  nextNodes: BoardWorkflowNode[];
  previousEdges: BoardWorkflowEdge[];
  nextEdges: BoardWorkflowEdge[];
  newAudioNode: BoardWorkflowNode | null;
}) {
  const previousAutomaticAudioIds = new Set(input.previousNodes
    .filter((node) => node.kind === "audio" && isReplaceableVideoEvidenceNode(node))
    .map((node) => node.id));
  const retainedAudioIds = new Set(input.nextNodes
    .filter((node) => node.kind === "audio")
    .map((node) => node.id));
  const staleSelectionTargetIds = new Set(input.nextNodes
    .filter((node) => {
      const selectedAudioId = String(node.meta?.[DIRECT_VIDEO_AUDIO_SELECTION_KEY] || "");
      return Boolean(selectedAudioId) && !retainedAudioIds.has(selectedAudioId);
    })
    .map((node) => node.id));

  const nodes = input.nextNodes.map((node) => {
    if (!staleSelectionTargetIds.has(node.id)) return node;
    const meta = { ...(node.meta || {}) };
    if (input.newAudioNode) {
      meta[DIRECT_VIDEO_AUDIO_SELECTION_KEY] = input.newAudioNode.id;
    } else {
      delete meta[DIRECT_VIDEO_AUDIO_SELECTION_KEY];
    }
    return { ...node, meta };
  });

  if (!input.newAudioNode) return { nodes, edges: input.nextEdges };

  const retainedNodeIds = new Set(nodes.map((node) => node.id));
  const connectionKeys = new Set(input.nextEdges.map(edgeKey));
  const edges = [...input.nextEdges];
  const addEdge = (to: string, label?: string) => {
    const candidate = { from: input.newAudioNode!.id, to, label };
    const key = edgeKey(candidate);
    if (!retainedNodeIds.has(to) || connectionKeys.has(key)) return;
    connectionKeys.add(key);
    edges.push(createEdge(candidate.from, candidate.to, candidate.label));
  };

  // Keep existing manual/audio downstream connections when the automatic
  // evidence asset is regenerated.
  for (const edge of input.previousEdges) {
    if (previousAutomaticAudioIds.has(edge.from)) addEdge(edge.to, edge.label);
  }
  // An older import may already have removed the old edge. The persisted
  // selection remains enough to restore this one direct manual connection.
  for (const targetId of staleSelectionTargetIds) addEdge(targetId, "手动连线");

  return { nodes, edges };
}
