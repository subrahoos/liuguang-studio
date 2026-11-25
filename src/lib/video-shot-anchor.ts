type AnchorNode = {
  id: string;
  meta?: Record<string, unknown>;
};

export type VideoShotAnchor = {
  sceneFrameNodeId: string;
  captureTime: number;
};

function roleOf(node?: AnchorNode) {
  return String(node?.meta?.assetRole || "");
}

export function referenceNodeIdsOf(node?: AnchorNode) {
  const value = node?.meta?.referenceNodeIds;
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0)));
}

/**
 * Returns the one manually captured reference frame used to make a composite
 * or repaired main image. Any ambiguous/missing lineage is deliberately
 * rejected: a video segment must not silently inherit the wrong shot anchor.
 */
export function resolveVideoShotAnchor(nodes: AnchorNode[], startNodeId: string): VideoShotAnchor | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const queue = [startNodeId];
  const visited = new Set<string>();
  const candidates = new Map<string, VideoShotAnchor>();

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) continue;

    if (roleOf(node) === "selected_scene_frame") {
      const captureTime = Number(node.meta?.captureTime);
      if (Number.isFinite(captureTime) && captureTime >= 0) {
        candidates.set(node.id, { sceneFrameNodeId: node.id, captureTime });
      }
      continue;
    }

    for (const referenceNodeId of referenceNodeIdsOf(node)) queue.push(referenceNodeId);
  }

  return candidates.size === 1 ? Array.from(candidates.values())[0] : null;
}

function clockSeconds(value: string) {
  const parts = value.split(":").map((part) => Number(part));
  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseDirectorSegmentRange(timeRange?: string) {
  if (!timeRange) return null;
  const values = Array.from(timeRange.matchAll(/\d+(?::\d{1,2}){0,2}(?:\.\d+)?/g), (match) => match[0]);
  if (values.length < 2) return null;
  const start = clockSeconds(values[0]);
  const end = clockSeconds(values[1]);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

export function isAnchorWithinSegment(anchor: VideoShotAnchor, timeRange?: string, toleranceSeconds = 0.25) {
  const range = parseDirectorSegmentRange(timeRange);
  if (!range) return true;
  return anchor.captureTime >= range.start - toleranceSeconds && anchor.captureTime <= range.end + toleranceSeconds;
}
