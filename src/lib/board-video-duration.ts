import type { BoardWorkflowNode } from "@/lib/board-workflows";

export type BoardVideoDurationSource = "reference_video" | "manual";

function positiveDuration(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Resolves the duration of the evidence that produced the connected analysis.
 * The storyboard carries this value on new boards; older reports can still
 * resolve it through their stored storyboard/source-audio links.
 */
export function referenceEvidenceDurationForAnalysis(
  allNodes: BoardWorkflowNode[],
  analysisNode?: BoardWorkflowNode | null,
): number | null {
  if (!analysisNode) return null;
  const analysisMeta = analysisNode.meta || {};
  const linkedIds = [
    String(analysisMeta.storyboardNodeId || ""),
    String(analysisMeta.sourceAudioNodeId || ""),
  ].filter(Boolean);
  const linkedNodes = linkedIds
    .map((id) => allNodes.find((node) => node.id === id))
    .filter((node): node is BoardWorkflowNode => Boolean(node));
  const candidates = [
    analysisMeta.evidenceDurationSeconds,
    analysisMeta.sourceDurationSeconds,
    ...linkedNodes.flatMap((node) => [
      node.meta?.evidenceDurationSeconds,
      node.meta?.sourceDurationSeconds,
    ]),
  ];
  for (const candidate of candidates) {
    const duration = positiveDuration(candidate);
    if (duration !== null) return duration;
  }
  return null;
}

export function referenceTargetDurationSeconds(duration: number): number {
  return Math.ceil(Math.max(0, duration));
}

