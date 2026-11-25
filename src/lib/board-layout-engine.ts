import type { BoardWorkflowEdge, BoardWorkflowNode } from "@/lib/board-workflows";
import { isManualBoardEdge } from "@/lib/board-manual-links";

export type BoardLayoutMode = "pipeline" | "connections";

export type BoardLayoutPreviewState = {
  mode: BoardLayoutMode;
  nodes: BoardWorkflowNode[];
  columnNodes: BoardWorkflowNode[][];
  canvasMinHeight: number;
  movedCount: number;
  manualEdgeCount: number;
  connectedNodeCount: number;
  unlinkedNodeCount: number;
};

export const BOARD_LAYOUT_LEFT = 40;
export const BOARD_LAYOUT_TOP = 112;
export const BOARD_LAYOUT_LANE_GAP = 32;
export const BOARD_LAYOUT_STAGE_GAP = 72;
export const BOARD_LAYOUT_LANE_WIDTH = 380;
export const BOARD_LAYOUT_STAGE_WIDTH = BOARD_LAYOUT_LANE_WIDTH * 2 + BOARD_LAYOUT_LANE_GAP;
export const BOARD_LAYOUT_STAGE_STEP = BOARD_LAYOUT_STAGE_WIDTH + BOARD_LAYOUT_STAGE_GAP;
export const BOARD_LAYOUT_HEADER_WIDTH = BOARD_LAYOUT_STAGE_WIDTH;
export const BOARD_LAYOUT_MIN_CANVAS_HEIGHT = 1800;
export const BOARD_LAYOUT_MIN_CANVAS_WIDTH = 2600;
export const BOARD_LAYOUT_COLUMNS = [
  { index: 0, label: "01 导入素材", description: "参考视频、完整音频与导入入口" },
  { index: 1, label: "02 证据与转写", description: "故事板、动作补证与口播" },
  { index: 2, label: "03 拆解与导演", description: "拆解报告和导演决策" },
  { index: 3, label: "04 图像准备", description: "商品、人物、场景与 image-2" },
  { index: 4, label: "05 视频输入与生成", description: "导演稿、镜头资产与视频节点" },
  { index: 5, label: "06 成片与归档", description: "分段视频、完整成片与说明" },
] as const;

const NODE_BASE_Z_INDEX = 80;
const CONTROL_HEIGHT = 204;
const ROW_GAP = 32;
const GROUP_GAP = 52;

function controlRoleOf(node: BoardWorkflowNode) {
  return String(node.meta?.controlRole || "");
}

function assetRoleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

export function boardNodeWidth(node: Pick<BoardWorkflowNode, "kind" | "meta">) {
  if (node.kind === "control") return 380;
  if (["action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(assetRoleOf(node as BoardWorkflowNode))) return 360;
  if (node.kind === "storyboard") return 330;
  return 270;
}

export function estimatedBoardNodeHeight(node: Pick<BoardWorkflowNode, "kind" | "meta">) {
  const role = assetRoleOf(node as BoardWorkflowNode);
  if (node.kind === "control") return CONTROL_HEIGHT;
  if (["action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(role)) return 500;
  if (node.kind === "storyboard" || node.kind === "source_video" || node.kind === "image_asset") return 470;
  if (node.kind === "analysis" || node.kind === "prompt") return 500;
  if (node.kind === "video_clip") return 420;
  if (node.kind === "audio") return 300;
  return 340;
}

export function boardLayoutStageForNode(node: BoardWorkflowNode) {
  const controlRole = controlRoleOf(node);
  const assetRole = assetRoleOf(node);
  if (controlRole === "input_assets") return 0;
  if (controlRole === "select_frame") return 1;
  if (controlRole === "gpt_analyze" || controlRole === "gpt_director") return 2;
  if (controlRole === "image_pipeline") return 3;
  if (controlRole === "video_generate") return 4;
  if (node.kind === "source_video") return 0;
  if (
    node.kind === "storyboard"
    || ["voiceover_transcript", "action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(assetRole)
  ) return 1;
  if (node.kind === "audio") return 0;
  if (node.kind === "analysis") return 2;
  if (node.kind === "prompt") return assetRole === "video_director_prompt" ? 4 : 2;
  if (["product_image", "identity_image", "identity_auxiliary_asset", "selected_scene_frame", "product_evidence_board"].includes(assetRole)) return 3;
  if (node.kind === "image_asset") return 4;
  if (node.kind === "video_clip" || ["generated_video", "composed_video"].includes(assetRole)) return 5;
  return 5;
}

export function boardLayoutStageLeft(stage: number) {
  return BOARD_LAYOUT_LEFT + stage * BOARD_LAYOUT_STAGE_STEP;
}

function stagePriority(node: BoardWorkflowNode) {
  const role = assetRoleOf(node);
  const controlRole = controlRoleOf(node);
  if (controlRole === "input_assets" || node.kind === "source_video") return 0;
  if (controlRole === "select_frame") return 0;
  if (node.kind === "storyboard") return 10;
  if (["action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(role)) return 20;
  if (node.kind === "audio") return 30;
  if (role === "voiceover_transcript") return 40;
  if (controlRole === "gpt_analyze") return 0;
  if (role === "reference_method_analysis") return 10;
  if (controlRole === "gpt_director") return 20;
  if (role === "product_image") return 0;
  if (role === "product_white_background") return 5;
  if (role === "identity_image") return 10;
  if (role === "identity_auxiliary_asset") return 20;
  if (role === "selected_scene_frame" || role === "product_evidence_board") return 30;
  if (controlRole === "image_pipeline") return 40;
  if (role === "video_director_prompt") return 0;
  if (role === "clean_scene") return 10;
  if (["outfit_turnaround", "outfit_front", "outfit_side", "outfit_back"].includes(role)) return 20;
  if (role === "composite_image") return 30;
  if (role === "repaired_image") return 40;
  if (controlRole === "video_generate") return 50;
  if (role === "composed_video") return 0;
  if (role === "generated_video") return 10;
  return 100;
}

function productionLane(stage: number, node: BoardWorkflowNode, laneBottoms: number[]) {
  const role = assetRoleOf(node);
  const controlRole = controlRoleOf(node);
  if (stage === 2) return role === "reference_method_analysis" ? 1 : 0;
  if (stage === 3 && controlRole === "image_pipeline") return 1;
  if (stage === 4 && controlRole === "video_generate") return 1;
  if (stage === 4 && role === "video_director_prompt") return 0;
  // Segment nodes must remain in one short rail immediately right of video
  // generation so they can be manually connected without crossing the board.
  if (stage === 5) return 0;
  return laneBottoms[0] <= laneBottoms[1] ? 0 : 1;
}

function compareCreated(a: BoardWorkflowNode, b: BoardWorkflowNode) {
  const timeA = Date.parse(a.createdAt || "");
  const timeB = Date.parse(b.createdAt || "");
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
  return a.id.localeCompare(b.id);
}

function segmentIndex(node: BoardWorkflowNode) {
  const value = Number(node.meta?.segmentIndex);
  return Number.isFinite(value) ? value : 0;
}

function nodeHeight(node: BoardWorkflowNode, measuredHeights: Map<string, number>) {
  const estimate = estimatedBoardNodeHeight(node);
  return Math.max(estimate, measuredHeights.get(node.id) || 0);
}

function withZIndex(node: BoardWorkflowNode, zIndex: number): BoardWorkflowNode {
  return { ...node, meta: { ...(node.meta || {}), zIndex } };
}

function producerRanks(
  stageNodes: BoardWorkflowNode[],
  incoming: Map<string, string[]>,
  nodeById: Map<string, BoardWorkflowNode>,
) {
  const controls = stageNodes.filter((node) => node.kind === "control").sort((a, b) => stagePriority(a) - stagePriority(b) || compareCreated(a, b));
  const controlRank = new Map(controls.map((node, index) => [node.id, index]));
  const ranks = new Map<string, number>();
  for (const node of stageNodes) {
    const rank = (incoming.get(node.id) || [])
      .map((id) => nodeById.get(id))
      .filter((parent): parent is BoardWorkflowNode => Boolean(parent && parent.kind === "control" && boardLayoutStageForNode(parent) === boardLayoutStageForNode(node)))
      .map((parent) => controlRank.get(parent.id))
      .find((value): value is number => typeof value === "number");
    ranks.set(node.id, rank ?? controls.length);
  }
  return ranks;
}

function connectionComponentRanks(
  nodes: BoardWorkflowNode[],
  edges: BoardWorkflowEdge[],
) {
  const adjacent = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    adjacent.get(edge.from)?.push(edge.to);
    adjacent.get(edge.to)?.push(edge.from);
  }

  const compareNodes = (a: BoardWorkflowNode, b: BoardWorkflowNode) =>
    boardLayoutStageForNode(a) - boardLayoutStageForNode(b)
    || stagePriority(a) - stagePriority(b)
    || compareCreated(a, b);
  const visited = new Set<string>();
  const components: BoardWorkflowNode[][] = [];
  for (const root of [...nodes].sort(compareNodes)) {
    if (visited.has(root.id)) continue;
    const component: BoardWorkflowNode[] = [];
    const stack = [root.id];
    visited.add(root.id);
    while (stack.length > 0) {
      const nodeId = stack.pop();
      const node = nodeId ? nodes.find((candidate) => candidate.id === nodeId) : undefined;
      if (!node) continue;
      component.push(node);
      for (const neighborId of adjacent.get(node.id) || []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        stack.push(neighborId);
      }
    }
    components.push(component);
  }

  const ranks = new Map<string, number>();
  components
    .sort((left, right) => compareNodes([...left].sort(compareNodes)[0], [...right].sort(compareNodes)[0]))
    .forEach((component, rank) => component.forEach((node) => ranks.set(node.id, rank)));
  return ranks;
}

export function buildBoardLayoutPreview(
  nodes: BoardWorkflowNode[],
  edges: BoardWorkflowEdge[],
  mode: BoardLayoutMode,
  measuredHeights = new Map<string, number>(),
): BoardLayoutPreviewState {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const manualEdges = edges.filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to) && isManualBoardEdge(edge));
  const incoming = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of manualEdges) incoming.get(edge.to)?.push(edge.from);
  const connectedIds = new Set(manualEdges.flatMap((edge) => [edge.from, edge.to]));
  const branchRanks = connectionComponentRanks(nodes, manualEdges);
  const placed = new Map<string, { x: number; y: number; height: number; zIndex: number }>();
  let nextZIndex = NODE_BASE_Z_INDEX;

  for (const stage of BOARD_LAYOUT_COLUMNS) {
    const stageNodes = nodes.filter((node) => boardLayoutStageForNode(node) === stage.index);
    const producerRank = producerRanks(stageNodes, incoming, nodeById);
    const compare = (a: BoardWorkflowNode, b: BoardWorkflowNode) => {
      if (mode === "connections") {
        const branchDifference = (branchRanks.get(a.id) || 0) - (branchRanks.get(b.id) || 0);
        if (branchDifference !== 0) return branchDifference;
      }
      const producerDifference = (producerRank.get(a.id) || 0) - (producerRank.get(b.id) || 0);
      if (producerDifference !== 0) return producerDifference;
      const priorityDifference = stagePriority(a) - stagePriority(b);
      if (priorityDifference !== 0) return priorityDifference;
      const segmentDifference = segmentIndex(a) - segmentIndex(b);
      if (segmentDifference !== 0) return segmentDifference;
      return compareCreated(a, b);
    };

    if (mode === "pipeline") {
      const laneBottoms = [BOARD_LAYOUT_TOP, BOARD_LAYOUT_TOP];
      const place = (node: BoardWorkflowNode) => {
        const height = nodeHeight(node, measuredHeights);
        const lane = productionLane(stage.index, node, laneBottoms);
        const y = Math.round(laneBottoms[lane]);
        placed.set(node.id, {
          x: boardLayoutStageLeft(stage.index) + lane * (BOARD_LAYOUT_LANE_WIDTH + BOARD_LAYOUT_LANE_GAP),
          y,
          height,
          zIndex: nextZIndex++,
        });
        laneBottoms[lane] = y + height + ROW_GAP;
      };

      // This mode is deliberately based on the production role, not whether a
      // user has already drawn every optional line.  A new board therefore
      // places evidence beside analysis, image inputs beside image-2, and video
      // references beside video generation before any manual wiring exists.
      [...stageNodes]
        .sort((a, b) => {
          const priorityDifference = stagePriority(a) - stagePriority(b);
          if (priorityDifference !== 0) return priorityDifference;
          const segmentDifference = segmentIndex(a) - segmentIndex(b);
          if (segmentDifference !== 0) return segmentDifference;
          return compareCreated(a, b);
        })
        .forEach(place);
      continue;
    }

    const controls = stageNodes.filter((node) => node.kind === "control").sort(compare);
    const linkedOutputs = stageNodes.filter((node) => node.kind !== "control" && connectedIds.has(node.id)).sort(compare);
    const unlinked = stageNodes.filter((node) => node.kind !== "control" && !connectedIds.has(node.id)).sort(compare);
    const laneBottoms = [BOARD_LAYOUT_TOP, BOARD_LAYOUT_TOP];
    const place = (node: BoardWorkflowNode, forceLane?: number) => {
      const height = nodeHeight(node, measuredHeights);
      const lane = forceLane ?? (laneBottoms[0] <= laneBottoms[1] ? 0 : 1);
      const y = Math.round(laneBottoms[lane]);
      placed.set(node.id, {
        x: boardLayoutStageLeft(stage.index) + lane * (BOARD_LAYOUT_LANE_WIDTH + BOARD_LAYOUT_LANE_GAP),
        y,
        height,
        zIndex: nextZIndex++,
      });
      laneBottoms[lane] = y + height + ROW_GAP;
    };

    controls.forEach((node, index) => place(node, index % 2));
    if (controls.length > 0 && (linkedOutputs.length > 0 || unlinked.length > 0)) {
      const outputTop = Math.max(...laneBottoms) + GROUP_GAP - ROW_GAP;
      laneBottoms[0] = outputTop;
      laneBottoms[1] = outputTop;
    }
    linkedOutputs.forEach((node) => place(node, stage.index === 5 ? 0 : undefined));
    if (linkedOutputs.length > 0 && unlinked.length > 0) {
      const unlinkedTop = Math.max(...laneBottoms) + GROUP_GAP - ROW_GAP;
      laneBottoms[0] = unlinkedTop;
      laneBottoms[1] = unlinkedTop;
    }
    unlinked.forEach((node) => place(node, stage.index === 5 ? 0 : undefined));
  }

  const nextNodes = nodes.map((node) => {
    const position = placed.get(node.id);
    if (!position) return node;
    return withZIndex({ ...node, x: position.x, y: position.y }, position.zIndex);
  });
  return {
    mode,
    nodes: nextNodes,
    columnNodes: BOARD_LAYOUT_COLUMNS.map((stage) => nextNodes.filter((node) => boardLayoutStageForNode(node) === stage.index)),
    canvasMinHeight: Math.max(
      BOARD_LAYOUT_MIN_CANVAS_HEIGHT,
      ...Array.from(placed.values()).map((position) => position.y + position.height + 120),
    ),
    movedCount: nextNodes.filter((node, index) => node.x !== nodes[index]?.x || node.y !== nodes[index]?.y).length,
    manualEdgeCount: manualEdges.length,
    connectedNodeCount: connectedIds.size,
    unlinkedNodeCount: nodes.length - connectedIds.size,
  };
}
