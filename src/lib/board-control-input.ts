import type { BoardWorkflowNode } from "@/lib/board-workflows";
import { getBoardVideoProfile } from "@/lib/board-video-protocol";
import {
  directVideoReplacementPackageFromNodes,
  isVideoVisualBase,
  resolveDirectVideoReplacementReferenceIds,
  usesVideoReferenceRolePackage,
  videoReferenceRole,
} from "@/lib/video-reference-contract";
import type { BoardVideoChannelCapabilities } from "@/lib/board-video-protocol";

export type BoardControlRole =
  | "input_assets"
  | "select_frame"
  | "gpt_analyze"
  | "gpt_director"
  | "image_pipeline"
  | "video_generate";

export type BoardControlInputHealth = {
  missing: string[];
  invalid: string[];
  notices?: string[];
  readyText: string;
};

function controlRoleOf(node: BoardWorkflowNode) {
  return String(node.meta?.controlRole || "") as BoardControlRole | "";
}

function assetRoleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

export function boardControlInputHealth(
  node: BoardWorkflowNode,
  inputs: BoardWorkflowNode[],
  videoChannel?: BoardVideoChannelCapabilities | string | null,
  sourceHasAudio?: boolean,
): BoardControlInputHealth {
  const role = controlRoleOf(node);
  const countRole = (assetRole: string) => inputs.filter((item) => assetRoleOf(item) === assetRole).length;
  const invalid: string[] = [];
  const missing: string[] = [];

  if (role === "input_assets") {
    return { missing, invalid, readyText: "无需输入连线，从此节点导入素材" };
  }

  if (role === "select_frame") {
    const videoCount = inputs.filter((item) => item.kind === "source_video").length;
    if (videoCount === 0) missing.push("参考视频 1 份");
    if (videoCount > 1) invalid.push("参考视频只能保留 1 份");
  }

  if (role === "gpt_analyze") {
    const storyboards = inputs.filter((item) => item.kind === "storyboard");
    const actionSupplements = inputs.filter((item) => assetRoleOf(item) === "action_supplement_storyboard_collection");
    const transcripts = inputs.filter((item) => assetRoleOf(item) === "voiceover_transcript");
    const storyboardCount = storyboards.length;
    const actionSupplementCount = actionSupplements.length;
    const transcriptCount = transcripts.length;
    if (actionSupplementCount > 1) invalid.push("0.5 秒动作补证只能够保留 1 份");
    if (sourceHasAudio && transcriptCount === 0) missing.push("中文口播转写 1 份（参考视频含音频）");
    if (storyboardCount === 0) missing.push("故事板总览 1 份");
    if (storyboardCount > 1) invalid.push("故事板只能保留 1 份");
    if (transcriptCount > 1) invalid.push("中文口播转写最多 1 份");
    if (storyboards[0] && actionSupplements[0]) {
      const storyboardEvidenceSetId = String(storyboards[0].meta?.evidenceSetId || "");
      const actionEvidenceSetId = String(actionSupplements[0].meta?.evidenceSetId || "");
      if (!storyboardEvidenceSetId || storyboardEvidenceSetId !== actionEvidenceSetId) {
        invalid.push("0.5 秒动作补证不是当前故事板同一批次，请重新连接对应证据");
      }
    }
    if (storyboards[0] && transcripts[0]) {
      const storyboardEvidenceSetId = String(storyboards[0].meta?.evidenceSetId || "");
      const transcriptEvidenceSetId = String(transcripts[0].meta?.evidenceSetId || "");
      if (storyboardEvidenceSetId && storyboardEvidenceSetId !== transcriptEvidenceSetId) {
        invalid.push("中文口播转写不是当前故事板同一批证据，请从最新完整音频重新转写");
      }
    }
    return {
      missing,
      invalid,
      notices: [sourceHasAudio === true
        ? "参考视频含音频：请将“中文音频转写”节点手动连入。"
        : sourceHasAudio === false
          ? "参考视频无音频：无需连接中文口播转写。"
          : "尚未读取参考视频的音频状态；登记视频后将自动判断是否需要中文转写。",
        "故事板总览是默认主证据；0.5 秒动作补证只在你手动直连后发送，用于精拆接触、动作与切点两侧状态。"],
      readyText: missing.length === 0 && invalid.length === 0
        ? `直连输入已就绪（${inputs.length} 项）`
        : "输入尚未就绪",
    };
  }

  if (role === "gpt_director") {
    const reportCount = countRole("reference_method_analysis");
    const transcriptCount = countRole("voiceover_transcript");
    const productVoiceoverCount = countRole("product_voiceover_script");
    if (reportCount === 0) missing.push("参考视频拆解报告 1 份");
    if (reportCount > 1) invalid.push("拆解报告只能保留 1 份");
    if (transcriptCount > 0) invalid.push("中文口播转写已封装进拆解报告，无需再连接到完整导演稿");
    if (productVoiceoverCount > 1) invalid.push("当前商品口播最多保留 1 份");
    return {
      missing,
      invalid,
      notices: ["只连接拆解报告即可自动仿写中文口播；如连接“当前商品口播”，则逐句原样使用。"],
      readyText: missing.length === 0 && invalid.length === 0
        ? `直连输入已就绪（${inputs.length} 项）`
        : "输入尚未就绪",
    };
  }

  if (role === "image_pipeline" && inputs.length === 0) {
    missing.push("按所选图片任务连接对应参考图");
  }

  if (role === "video_generate") {
    const videoProfile = getBoardVideoProfile(videoChannel);
    if (videoProfile?.directVideoReplacement) {
      const selectedIds = resolveDirectVideoReplacementReferenceIds(
        inputs,
        node.meta?.directVideoReplacementReferenceIds,
        { referenceContract: videoProfile.directVideoReplacementReferenceContract },
      );
      const selectedNodes = selectedIds
        .map((nodeId) => inputs.find((item) => item.id === nodeId))
        .filter((item): item is BoardWorkflowNode => Boolean(item));
      const directPackage = directVideoReplacementPackageFromNodes(selectedNodes, {
        sceneOptional: videoProfile.directVideoReplacementSceneOptional,
        faceOptional: videoProfile.directVideoReplacementFaceOptional,
        referenceContract: videoProfile.directVideoReplacementReferenceContract,
      });
      return {
        missing: directPackage.missing,
        invalid: directPackage.invalid,
        readyText: directPackage.error ? "输入尚未就绪" : "输入已就绪",
      };
    }
    const directorCount = countRole("video_director_prompt");
    if (directorCount === 0) missing.push("最新完整视频导演稿 1 份");
    if (directorCount > 1) invalid.push("完整视频导演稿只能保留 1 份");
    const references = inputs.filter((item) => assetRoleOf(item) !== "video_director_prompt");
    if (videoProfile && usesVideoReferenceRolePackage(videoChannel)) {
      const roles = ["visual_base", "product", "face", "model", "scene"] as const;
      const labels: Record<(typeof roles)[number], string> = {
        visual_base: "合成主图或修复图",
        product: "商品图",
        face: "人脸正面定型图",
        model: "当前镜头模特图",
        scene: "场景空镜图",
      };
      for (const roleName of roles) {
        if (!references.some((item) => videoReferenceRole(item) === roleName)) missing.push(`${labels[roleName]} 1 张`);
      }
      const unsupported = references.filter((item) => !videoReferenceRole(item));
      if (unsupported.length > 0) {
        invalid.push(`视频节点不接受的直连素材：${unsupported.map((item) => item.title || item.id).join("、")}`);
      }
      return {
        missing,
        invalid,
        readyText: missing.length === 0 && invalid.length === 0
          ? `直连输入已就绪（${inputs.length} 项）`
          : "输入尚未就绪",
      };
    }
    const visualBases = references.filter(isVideoVisualBase);
    if (visualBases.length === 0) missing.push("合成主图或修复图 1 张");
  }

  return {
    missing,
    invalid,
    readyText: missing.length === 0 && invalid.length === 0
      ? `直连输入已就绪（${inputs.length} 项）`
      : "输入尚未就绪",
  };
}
