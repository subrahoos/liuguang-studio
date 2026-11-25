import type { BoardNodeKind, BoardWorkflowNode } from "@/lib/board-workflows";

const OUTPUT_HORIZONTAL_GAP = 40;
const OUTPUT_VERTICAL_GAP = 32;
const COLLISION_PADDING = 24;
const VIDEO_INPUT_LANE_OFFSET = 412;

export type GeneratedOutputSlot = "default" | "video_segment" | "video_final";

function roleOf(node: Pick<BoardWorkflowNode, "meta">) {
  return String(node.meta?.assetRole || "");
}

function estimatedNodeSize(node: Pick<BoardWorkflowNode, "kind" | "meta">) {
  const role = roleOf(node);
  if (node.kind === "control") return { width: 380, height: 204 };
  if (["action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(role)) return { width: 360, height: 520 };
  if (node.kind === "storyboard") return { width: 330, height: 470 };
  if (node.kind === "source_video" || node.kind === "image_asset") return { width: 270, height: 470 };
  if (node.kind === "analysis" || node.kind === "prompt") return { width: 270, height: 500 };
  if (node.kind === "video_clip") return { width: 270, height: 420 };
  if (node.kind === "audio") return { width: 270, height: 300 };
  return { width: 270, height: 340 };
}

function overlaps(
  left: number,
  top: number,
  width: number,
  height: number,
  node: BoardWorkflowNode,
) {
  const size = estimatedNodeSize(node);
  return left < node.x + size.width + COLLISION_PADDING
    && left + width + COLLISION_PADDING > node.x
    && top < node.y + size.height + COLLISION_PADDING
    && top + height + COLLISION_PADDING > node.y;
}

export function videoOutputRailPosition(anchor: BoardWorkflowNode, stackIndex = 0) {
  const anchorSize = estimatedNodeSize(anchor);
  const videoSize = estimatedNodeSize({ kind: "video_clip", meta: { assetRole: "generated_video" } });
  return {
    x: Math.round(anchor.x + anchorSize.width + OUTPUT_HORIZONTAL_GAP),
    y: Math.max(40, Math.round(anchor.y + Math.max(0, stackIndex) * (videoSize.height + OUTPUT_VERTICAL_GAP))),
  };
}

export function generatedOutputPosition(input: {
  nodes: BoardWorkflowNode[];
  anchor?: BoardWorkflowNode;
  outputKind: BoardNodeKind;
  outputRole?: string;
  outputSlot?: GeneratedOutputSlot;
  segmentIndex?: number;
  previousOutput?: BoardWorkflowNode;
  excludedNodeIds?: Iterable<string>;
}) {
  if (input.previousOutput) {
    return { x: input.previousOutput.x, y: input.previousOutput.y };
  }
  if (!input.anchor) return { x: 40, y: 1400 };

  const anchorSize = estimatedNodeSize(input.anchor);
  const outputSize = estimatedNodeSize({
    kind: input.outputKind,
    meta: input.outputRole ? { assetRole: input.outputRole } : undefined,
  });
  const excluded = new Set([input.anchor.id, ...(input.excludedNodeIds || [])]);
  const startX = Math.round(input.anchor.x + anchorSize.width + OUTPUT_HORIZONTAL_GAP);
  const startY = Math.max(40, Math.round(input.anchor.y));

  if (input.outputSlot === "video_final") {
    return videoOutputRailPosition(input.anchor);
  }

  if (input.outputSlot === "video_segment") {
    const finalExists = input.nodes.some((node) => (
      !excluded.has(node.id)
      && String(node.meta?.executorNodeId || "") === input.anchor?.id
      && roleOf(node) === "composed_video"
    ));
    const index = Math.max(1, Number(input.segmentIndex || 1));
    const stackIndex = index - 1 + (finalExists ? 1 : 0);
    return videoOutputRailPosition(input.anchor, stackIndex);
  }

  if (input.outputRole === "video_director_prompt") {
    const videoExecutor = input.nodes.find((node) => String(node.meta?.controlRole || "") === "video_generate");
    if (videoExecutor) {
      return {
        x: Math.max(40, Math.round(videoExecutor.x - VIDEO_INPUT_LANE_OFFSET)),
        y: Math.max(40, Math.round(videoExecutor.y)),
      };
    }
  }

  // Generated results stay beside their producer.  A global collision scan made
  // a result leap across unrelated stages whenever the board had accumulated
  // historical assets.  Only siblings produced by this same function may claim
  // its result rail; unrelated nodes are deliberately ignored here.
  const obstacles = input.nodes.filter((node) => (
    !excluded.has(node.id)
    && String(node.meta?.executorNodeId || "") === input.anchor?.id
  ));
  const verticalStep = outputSize.height + OUTPUT_VERTICAL_GAP;
  const verticalOffsets = [0];
  for (let distance = 1; distance <= 12; distance += 1) {
    verticalOffsets.push(distance * verticalStep, -distance * verticalStep);
  }

  for (let lane = 0; lane < 6; lane += 1) {
    const x = startX + lane * (outputSize.width + OUTPUT_HORIZONTAL_GAP);
    for (const offset of verticalOffsets) {
      const y = Math.max(40, startY + offset);
      if (!obstacles.some((node) => overlaps(x, y, outputSize.width, outputSize.height, node))) {
        return { x, y };
      }
    }
  }

  return { x: startX, y: startY };
}
