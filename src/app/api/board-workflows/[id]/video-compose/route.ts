import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { copyFile, mkdir } from "fs/promises";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  boardFilePublicUrl,
  boardArtifactFileName,
  boardArtifactRelativePath,
  createEdge,
  createNode,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  manualDirectGeneratedVideoNodes,
  manualDirectInputNodeIds,
  startNodeExecution,
  updateBoardWorkflow,
  type BoardWorkflowEdge,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import { composeVideo, type ClipInput } from "@/lib/video-composer/composer";
import { probeVideoMedia } from "@/lib/video-media-probe";
import { VIDEO_DIRECTOR_SCHEMA_VERSION } from "@/lib/video-director-contract";
import { readStoredVideoShotSegmentPlan } from "@/lib/video-shot-segments";
import { getBoardVideoProfile } from "@/lib/board-video-protocol";
import { videoOutputRailPosition } from "@/lib/board-node-placement";
import { resolveVideoChannel } from "@/lib/server-model-settings";
import type { VideoModelChannel } from "@/lib/stores/settings-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

class VideoComposeValidationError extends Error {}

function sortedVideoNodes(nodes: BoardWorkflowNode[], nodeIds: string[]) {
  const idSet = new Set(nodeIds);
  return nodes
    .filter((node) => idSet.has(node.id) && node.kind === "video_clip" && node.filePath)
    .sort((a, b) => Number(a.meta?.segmentIndex || 0) - Number(b.meta?.segmentIndex || 0));
}

function exactStringArray(value: unknown, length: number) {
  return Array.isArray(value)
    && value.length === length
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function sameNodeIdSet(left: string[], right: string[]) {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((nodeId) => right.includes(nodeId));
}

function assertCurrentSegmentSet(
  workflowNodes: BoardWorkflowNode[],
  workflowEdges: BoardWorkflowEdge[],
  executorNodeId: string,
  requestedNodeIds: string[],
  currentChannel: VideoModelChannel,
) {
  if (new Set(requestedNodeIds).size !== requestedNodeIds.length) {
    throw new VideoComposeValidationError("视频分段列表包含重复节点。");
  }
  const executorNode = workflowNodes.find((node) => node.id === executorNodeId);
  if (!executorNode || String(executorNode.meta?.controlRole || "") !== "video_generate") {
    throw new VideoComposeValidationError("请从画板中的视频生成节点执行合成。");
  }
  const connectedVideoNodeIds = manualDirectGeneratedVideoNodes(
    { edges: workflowEdges },
    workflowNodes,
    executorNodeId,
  ).map((node) => node.id);
  if (!sameNodeIdSet(requestedNodeIds, connectedVideoNodeIds)) {
    throw new VideoComposeValidationError("合成只读取手动连入当前视频节点的生成视频分段；请连接任务 1/2 后重试。");
  }
  const videoNodes = sortedVideoNodes(workflowNodes, connectedVideoNodeIds);
  if (videoNodes.length !== connectedVideoNodeIds.length || videoNodes.length < 2) {
    throw new VideoComposeValidationError("至少需要手动连入 2 个已完成的分段视频才能合成完整成片。");
  }

  const first = videoNodes[0];
  const directorNodeId = String(first.meta?.directorNodeId || "");
  const directorSchemaVersion = Number(first.meta?.directorSchemaVersion || 0);
  const requestedTotalDuration = Number(first.meta?.requestedTotalDuration || 0);
  const channelId = String(first.meta?.channelId || "");
  const model = String(first.meta?.model || "");
  if (currentChannel.id !== channelId || currentChannel.model !== model) {
    throw new VideoComposeValidationError("当前模型通道或模型名已变化，请重新生成完整导演稿和全部分段视频后再合成。");
  }
  let profile = getBoardVideoProfile(currentChannel);
  if (!profile) throw new VideoComposeValidationError("视频分段使用了未配置的视频模型。");
  if (!directorNodeId || directorSchemaVersion !== VIDEO_DIRECTOR_SCHEMA_VERSION) {
    throw new VideoComposeValidationError("视频分段不是由最新完整视频导演稿生成，请重新生成。");
  }
  const directorNode = workflowNodes.find((node) => node.id === directorNodeId);
  if (!directorNode || Number(directorNode.meta?.directorSchemaVersion || 0) !== VIDEO_DIRECTOR_SCHEMA_VERSION) {
    throw new VideoComposeValidationError("对应的最新完整视频导演稿已不存在。");
  }
  const plannedProfile = profile;
  if (!plannedProfile || String(directorNode.meta?.videoCapabilitySignature || "") !== plannedProfile.capabilitySignature) {
    throw new VideoComposeValidationError("完整导演稿对应的模型时长能力已经变化，请重新生成导演稿和分段视频。");
  }
  profile = plannedProfile;
  const connectedDirectorIds = manualDirectInputNodeIds({ edges: workflowEdges }, executorNodeId)
    .filter((nodeId) => String(workflowNodes.find((node) => node.id === nodeId)?.meta?.assetRole || "") === "video_director_prompt");
  if (connectedDirectorIds.length !== 1 || connectedDirectorIds[0] !== directorNodeId) {
    throw new VideoComposeValidationError("当前视频节点连接的完整导演稿已变化，请按新导演稿重新生成全部任务。");
  }
  const expected = readStoredVideoShotSegmentPlan(directorNode.meta?.segmentPlan, profile.generationSeconds);
  if (!expected) {
    throw new VideoComposeValidationError("完整视频导演稿缺少当前镜头切点分段计划，请重新生成导演稿。");
  }
  if (expected.length < 2 || videoNodes.length !== expected.length) {
    throw new VideoComposeValidationError("分段数量与当前成片总时长不一致，请按最新任务计划重新生成。");
  }

  videoNodes.forEach((node, index) => {
    const plan = expected[index];
    if (
      String(node.meta?.assetRole || "") !== "generated_video"
      || String(node.meta?.model || "") !== model
      || String(node.meta?.capabilitySignature || "") !== profile.capabilitySignature
      || String(node.meta?.channelId || "") !== channelId
      || String(node.meta?.directorNodeId || "") !== directorNodeId
      || Number(node.meta?.directorSchemaVersion || 0) !== directorSchemaVersion
      || Number(node.meta?.segmentIndex || 0) !== plan.index
      || Number(node.meta?.segmentCount || 0) !== expected.length
      || Number(node.meta?.generationDuration || 0) !== profile.generationSeconds
      || Number(node.meta?.sourceDuration || 0) !== plan.sourceDuration
      || String(node.meta?.sourceTimeRange || "") !== plan.sourceTimeRange
      || Number(node.meta?.outputDuration || 0) !== plan.outputDuration
      || String(node.meta?.outputTimeRange || "") !== plan.outputTimeRange
      || Number(node.meta?.requestedTotalDuration || 0) !== requestedTotalDuration
      || Number(node.meta?.plannedOutputDuration || 0) !== plan.plannedOutputDuration
      || String(node.meta?.aspectRatio || "") !== profile.aspectRatio
      || String(node.meta?.resolution || "") !== profile.resolution
      || !exactStringArray(node.meta?.referenceNodeIds, profile.referenceImageCount)
    ) {
      throw new VideoComposeValidationError(`任务 ${plan.index} 与当前视频模型的分段计划不一致，请重新生成该任务。`);
    }
  });

  const plannedOutputDuration = expected.reduce((sum, segment) => sum + segment.outputDuration, 0);
  if (plannedOutputDuration !== expected[0]?.plannedOutputDuration) {
    throw new VideoComposeValidationError("分段输出时长之和与当前完整任务计划不一致。");
  }
  return {
    executorNode,
    videoNodes,
    expected,
    directorNodeId,
    directorSchemaVersion,
    requestedTotalDuration,
    plannedOutputDuration,
    channelId,
    profile,
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let inputNodeIds: string[] = [];

  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    workflowId = id;
    const workflow = access.workflow;
    const body = await req.json().catch(() => ({}));
    const clientTaskId = String(body.clientTaskId || "");
    executorNodeId = String(body.executorNodeId || "");
    const requestedChannelId = String(body.channelId || "");
    const requestedNodeIds = Array.isArray(body.videoNodeIds) ? body.videoNodeIds.map(String) : [];
    const currentChannel = await resolveVideoChannel(req, undefined, requestedChannelId, "full_video");
    if (!currentChannel) throw new VideoComposeValidationError("找不到当前视频模型通道。");
    const validated = assertCurrentSegmentSet(
      workflow.nodes,
      workflow.edges,
      executorNodeId,
      requestedNodeIds,
      currentChannel,
    );
    const currentProfile = getBoardVideoProfile(currentChannel);
    if (!currentProfile || currentProfile.capabilitySignature !== validated.profile.capabilitySignature) {
      throw new VideoComposeValidationError("当前模型通道或可用时长已变化，请重新生成完整导演稿和全部分段视频后再合成。");
    }
    inputNodeIds = validated.videoNodes.map((node) => node.id);
    await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);

    const media = await Promise.all(validated.videoNodes.map((node) => probeVideoMedia(node.filePath as string)));
    const clips: ClipInput[] = validated.videoNodes.map((node, index) => {
      const duration = validated.expected[index].outputDuration;
      if (!(duration > 0 && duration <= validated.profile.generationSeconds)) {
        throw new VideoComposeValidationError(`任务 ${index + 1} 的保留时长无效。`);
      }
      if (media[index].durationSeconds + 0.25 < duration) {
        throw new VideoComposeValidationError(`任务 ${index + 1} 的本地视频长度不足 ${duration} 秒，不能安全合成。`);
      }
      return {
        type: "video",
        filePath: node.filePath as string,
        duration,
        transition: "direct_concat",
        hasAudio: media[index].hasAudio,
      };
    });

    const outputPath = await composeVideo({
      projectId: `board-${id}`,
      clips,
      output: { aspectRatio: validated.profile.aspectRatio, resolution: validated.profile.resolution },
    });
    if (!outputPath) throw new Error("FFmpeg 合成没有返回输出文件。");

    const workflowAfterCompose = await getBoardWorkflow(id, access.user.id) || workflow;
    if (isBoardTaskCancelled(id, clientTaskId) || isNodeExecutionCancelled(workflowAfterCompose, executorNodeId)) {
      return NextResponse.json({ workflow: workflowAfterCompose, cancelled: true });
    }

    const targetFileName = boardArtifactFileName(workflow, "完整成片", ".mp4");
    const targetPath = join(workflow.localDir, boardArtifactRelativePath("deliverables", targetFileName));
    await mkdir(join(workflow.localDir, "deliverables"), { recursive: true });
    await copyFile(outputPath, targetPath);
    const outputMedia = await probeVideoMedia(targetPath);
    const latestWorkflow = await getBoardWorkflow(id, access.user.id) || workflow;
    if (isBoardTaskCancelled(id, clientTaskId) || isNodeExecutionCancelled(latestWorkflow, executorNodeId)) {
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }
    const latestExecutorNode = latestWorkflow.nodes.find((item) => item.id === executorNodeId) || validated.executorNode;
    const finalPosition = videoOutputRailPosition(latestExecutorNode);
    const node = createNode({
      kind: "video_clip",
      title: String(body.resultTitle || "画板合成完整成片"),
      description: String(body.resultDescription || `已按时间顺序合成 ${validated.videoNodes.length} 个视频任务。`),
      filePath: targetPath,
      publicUrl: boardFilePublicUrl(id, targetPath),
      meta: {
        assetRole: "composed_video",
        provider: "rjmus-video",
        model: validated.profile.model,
        channelId: validated.channelId,
        capabilitySignature: validated.profile.capabilitySignature,
        directorNodeId: validated.directorNodeId,
        directorSchemaVersion: validated.directorSchemaVersion,
        requestedTotalDuration: validated.requestedTotalDuration,
        plannedOutputDuration: validated.plannedOutputDuration,
        sourceVideoNodeIds: inputNodeIds,
        referenceNodeIdsBySegment: validated.videoNodes.map((videoNode) => videoNode.meta?.referenceNodeIds),
        segmentCount: validated.videoNodes.length,
        duration: validated.plannedOutputDuration,
        aspectRatio: validated.profile.aspectRatio,
        resolution: validated.profile.resolution,
        hasAudio: outputMedia.hasAudio,
        actualDuration: outputMedia.durationSeconds,
        width: outputMedia.width,
        height: outputMedia.height,
        fps: outputMedia.fps,
        executorNodeId,
      },
      x: finalPosition.x,
      y: finalPosition.y,
    });

    // The completed film owns the first slot beside video generation.  Its
    // source segments remain immediately below in order, so both the result
    // and the manual segment-to-video wiring stay in one compact local rail.
    const segmentPositions = new Map(inputNodeIds.map((nodeId, index) => [
      nodeId,
      videoOutputRailPosition(latestExecutorNode, index + 1),
    ]));
    const positionedNodes = latestWorkflow.nodes.map((item) => {
      const position = segmentPositions.get(item.id);
      return position ? { ...item, x: position.x, y: position.y } : item;
    });
    const next = await updateBoardWorkflow(id, {
      status: "done",
      nodes: [...positionedNodes, node],
      edges: [
        ...latestWorkflow.edges,
        createEdge(executorNodeId, node.id, "节点执行输出"),
        ...inputNodeIds.map((nodeId) => createEdge(nodeId, node.id, "视频分段")),
      ],
    }, latestWorkflow.revision ?? 0);
    const finalWorkflow = await finishNodeExecution(
      id,
      executorNodeId,
      inputNodeIds,
      [node.id],
      "视频合成完成",
    ) || next;
    clearBoardTaskCancellation(id, clientTaskId);
    return NextResponse.json({ workflow: finalWorkflow, node });
  } catch (error) {
    console.error("board video compose failed:", error);
    const message = error instanceof Error ? error.message : "视频合成失败";
    if (workflowId && executorNodeId) {
      await failNodeExecution(workflowId, executorNodeId, inputNodeIds, message).catch(() => null);
    }
    return NextResponse.json(
      { error: message },
      { status: error instanceof VideoComposeValidationError ? 400 : 500 },
    );
  }
}
