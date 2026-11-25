import { createReadStream, existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { basename, extname, join } from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import {
  boardFilePublicUrl,
  boardArtifactFileName,
  boardArtifactRelativePath,
  createEdge,
  createNode,
  deleteBoardFiles,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  manualUpstreamNodeIds,
  saveBoardUploadedFile,
  startNodeExecution,
  updateBoardWorkflow,
  type BoardWorkflow,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { currentReferenceVideoNode, markCurrentReferenceVideo, newAudioPosition, newReferenceVideoPosition } from "@/lib/board-input-assets";
import { extractBoardVideoAudio, probeBoardVideo } from "@/lib/board-video-audio";
import { synchronizeAutomaticAudioReferences } from "@/lib/board-video-audio-sync";
import { isReplaceableVideoEvidenceNode } from "@/lib/video-evidence";
import { isBoardTaskCancelled } from "@/lib/board-task-cancellations";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

type AudioExtractionRequest = {
  executorNodeId: string;
  clientTaskId: string;
  sourceNodeId: string;
  sourceVideoFile: File | null;
  sourceVideoPath: string;
};

type PreparedAudioSource = {
  filePath: string;
  displayName: string;
  sourceNode?: BoardWorkflowNode;
  createdFilePaths: string[];
  sourceSha256?: string;
  sourceBytes?: number;
  storageReused?: boolean;
};

function validateLocalVideoPath(value: string) {
  const cleaned = value.trim().replace(/^"|"$/g, "");
  const extension = extname(cleaned).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) throw new Error("只支持 mp4、webm、mov、m4v 视频。");
  if (!existsSync(cleaned)) throw new Error(`找不到本地视频：${cleaned}`);
  return cleaned;
}

async function readAudioExtractionRequest(req: NextRequest): Promise<AudioExtractionRequest> {
  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("sourceVideoFile");
    return {
      executorNodeId: String(form.get("executorNodeId") || ""),
      clientTaskId: String(form.get("clientTaskId") || ""),
      sourceNodeId: String(form.get("sourceNodeId") || ""),
      sourceVideoFile: file instanceof File && file.size > 0 ? file : null,
      sourceVideoPath: String(form.get("sourceVideoPath") || "").trim(),
    };
  }
  const body = await req.json().catch(() => ({}));
  return {
    executorNodeId: String(body.executorNodeId || ""),
    clientTaskId: String(body.clientTaskId || ""),
    sourceNodeId: String(body.sourceNodeId || ""),
    sourceVideoFile: null,
    sourceVideoPath: String(body.sourceVideoPath || "").trim(),
  };
}

function sourceVideoForAudioExtraction(
  workflow: BoardWorkflow,
  executorNodeId: string,
  sourceNodeId = "",
): BoardWorkflowNode | undefined {
  if (sourceNodeId) {
    const selected = workflow.nodes.find((node) => node.id === sourceNodeId);
    return selected?.kind === "source_video" && Boolean(selected.filePath) && existsSync(selected.filePath!)
      ? selected
      : undefined;
  }
  const upstream = executorNodeId
    ? manualUpstreamNodeIds(workflow, [executorNodeId])
      .map((nodeId) => workflow.nodes.find((node) => node.id === nodeId))
      : [];
  const candidates = [
    ...upstream.filter((node): node is BoardWorkflowNode => Boolean(node)),
    currentReferenceVideoNode(workflow),
  ].filter((node): node is BoardWorkflowNode => Boolean(node));
  return candidates.find((node) => node.kind === "source_video" && Boolean(node.filePath) && existsSync(node.filePath!));
}

async function prepareAudioSource(
  id: string,
  workflow: BoardWorkflow,
  request: AudioExtractionRequest,
): Promise<PreparedAudioSource> {
  const reusableFilePaths = [
    workflow.sourceVideoPath,
    ...workflow.nodes.map((node) => node.filePath),
  ].filter((filePath): filePath is string => Boolean(filePath));
  async function storeCurrentVideo(
    stream: ReadableStream<Uint8Array>,
    displayName: string,
    extension: string,
  ): Promise<PreparedAudioSource> {
    const stored = await saveBoardUploadedFile({
      id,
      relativeFileName: boardArtifactRelativePath(
        "source",
        boardArtifactFileName(workflow, "参考视频", extension, { suffix: crypto.randomUUID().slice(0, 8) }),
      ),
      stream,
      reusableFilePaths,
    });
    return {
      filePath: stored.filePath,
      displayName,
      sourceNode: workflow.nodes.find((node) => node.kind === "source_video" && node.filePath === stored.filePath),
      createdFilePaths: stored.reused ? [] : [stored.filePath],
      sourceSha256: stored.sha256,
      sourceBytes: stored.bytes,
      storageReused: stored.reused,
    };
  }
  if (request.sourceVideoFile) {
    const extension = extname(request.sourceVideoFile.name).toLowerCase() || ".mp4";
    if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) throw new Error("只支持 mp4、webm、mov、m4v 视频。");
    return storeCurrentVideo(request.sourceVideoFile.stream(), request.sourceVideoFile.name, extension);
  }
  if (request.sourceVideoPath) {
    const filePath = validateLocalVideoPath(request.sourceVideoPath);
    return storeCurrentVideo(
      Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
      basename(filePath),
      extname(filePath).toLowerCase() || ".mp4",
    );
  }
  if (request.sourceNodeId) {
    const sourceNode = sourceVideoForAudioExtraction(workflow, request.executorNodeId, request.sourceNodeId);
    if (!sourceNode?.filePath) throw new Error("所选参考视频已不存在，请重新选择文件。");
    return {
      filePath: sourceNode.filePath,
      displayName: sourceNode.title || basename(sourceNode.filePath),
      sourceNode,
      createdFilePaths: [],
    };
  }
  const sourceNode = sourceVideoForAudioExtraction(workflow, request.executorNodeId);
  if (!sourceNode?.filePath) throw new Error("请先选择视频文件，或把参考视频节点手动连到此节点。");
  return {
    filePath: sourceNode.filePath,
    displayName: sourceNode.title || basename(sourceNode.filePath),
    sourceNode,
    createdFilePaths: [],
  };
}

async function registerCurrentReferenceVideo(
  id: string,
  workflow: BoardWorkflow,
  executorNodeId: string,
  source: PreparedAudioSource,
  meta: Awaited<ReturnType<typeof probeBoardVideo>>,
) {
  const existing = source.sourceNode
    || workflow.nodes.find((node) => node.kind === "source_video" && node.filePath === source.filePath);
  const sourceNode: BoardWorkflowNode = existing ? {
    ...existing,
    title: "参考视频",
    description: `${source.displayName}，${meta.durationSeconds.toFixed(1)} 秒，${meta.width || "-"}x${meta.height || "-"}${existing.meta?.evidenceSetId ? "" : "；已登记，尚未生成视频证据"}`,
    filePath: source.filePath,
    publicUrl: boardFilePublicUrl(id, source.filePath),
    meta: {
      ...(existing.meta || {}),
      ...(meta as unknown as Record<string, unknown>),
      source: "user-upload",
      ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
      ...(source.sourceBytes ? { sourceBytes: source.sourceBytes } : {}),
      storageReused: source.storageReused ?? true,
      evidenceGenerated: Boolean(existing.meta?.evidenceSetId),
    } as Record<string, unknown>,
  } : createNode({
    kind: "source_video",
    title: "参考视频",
    description: `${source.displayName}，${meta.durationSeconds.toFixed(1)} 秒，${meta.width || "-"}x${meta.height || "-"}；已登记，尚未生成视频证据`,
    filePath: source.filePath,
    publicUrl: boardFilePublicUrl(id, source.filePath),
    meta: {
      ...(meta as unknown as Record<string, unknown>),
      source: "user-upload",
      ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
      ...(source.sourceBytes ? { sourceBytes: source.sourceBytes } : {}),
      storageReused: source.storageReused ?? false,
      evidenceGenerated: false,
    },
    ...newReferenceVideoPosition(workflow, executorNodeId),
  });
  const baseNodes = existing
    ? workflow.nodes.map((node) => node.id === existing.id ? sourceNode : node)
    : [...workflow.nodes, sourceNode];
  const edgeExists = workflow.edges.some((edge) => edge.from === executorNodeId && edge.to === sourceNode.id);
  const next = await updateBoardWorkflow(id, {
    sourceVideoPath: source.filePath,
    sourceVideoName: source.displayName,
    nodes: markCurrentReferenceVideo(baseNodes, sourceNode.id),
    edges: edgeExists
      ? workflow.edges
      : [...workflow.edges, createEdge(executorNodeId, sourceNode.id, "节点执行输出")],
  }, workflow.revision ?? 0);
  return {
    workflow: next,
    sourceNode: currentReferenceVideoNode(next) || sourceNode,
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let clientTaskId = "";
  let inputNodeIds: string[] = [];
  let outputPath = "";
  let createdSourcePaths: string[] = [];
  let sourceCommitted = false;
  let graphSaved = false;
  try {
    const { id } = await params;
    workflowId = id;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const workflow = access.workflow;
    if (!workflow) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });

    const request = await readAudioExtractionRequest(req);
    executorNodeId = request.executorNodeId;
    clientTaskId = request.clientTaskId;
    if (!executorNodeId) return NextResponse.json({ error: "缺少执行节点" }, { status: 400 });

    const source = await prepareAudioSource(id, workflow, request);
    createdSourcePaths = source.createdFilePaths;
    const meta = await probeBoardVideo(source.filePath);
    const registration = await registerCurrentReferenceVideo(id, workflow, executorNodeId, source, meta);
    sourceCommitted = true;
    const sourceNode = registration.sourceNode;
    inputNodeIds = [sourceNode.id];
    await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);
    if (!meta.hasAudio) {
      const failedWorkflow = await failNodeExecution(id, executorNodeId, inputNodeIds, "该参考视频不含音轨，未生成完整音频。");
      return NextResponse.json({ error: "该参考视频不含音轨，未生成完整音频。", workflow: failedWorkflow }, { status: 422 });
    }

    const evidenceSetId = String(sourceNode?.meta?.evidenceSetId || crypto.randomUUID());
    const audioDir = join(workflow.localDir, "evidence", evidenceSetId);
    await mkdir(audioDir, { recursive: true });
    // Write a fresh file first. A failed re-extraction must not corrupt the
    // previously usable audio file or leave it pointing at a half-written file.
    outputPath = join(audioDir, `audio_full-${crypto.randomUUID().slice(0, 8)}.mp3`);
    await extractBoardVideoAudio(source.filePath, outputPath);

    const latestWorkflow = await getBoardWorkflow(id, access.user.id) || workflow;
    if (isBoardTaskCancelled(id, clientTaskId) || isNodeExecutionCancelled(latestWorkflow, executorNodeId)) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }

    const latestSourceNode = sourceNode
      ? latestWorkflow.nodes.find((node) => node.id === sourceNode.id) || sourceNode
      : undefined;
    const audioNode = createNode({
      kind: "audio",
      title: "完整音频",
      description: `已从“${latestSourceNode?.title || source.displayName}”完整剥离 ${meta.durationSeconds.toFixed(1)} 秒音频；格式 MP3，单声道 16000Hz、48kbps。需要时请点击“中文音频转写”。`,
      filePath: outputPath,
      publicUrl: boardFilePublicUrl(id, outputPath),
      meta: {
        assetRole: "audio_evidence",
        ...(latestSourceNode ? { evidenceSetId } : {}),
        evidenceBoundarySource: String(latestSourceNode?.meta?.evidenceBoundarySource || "full-video"),
        evidenceDurationSeconds: Number(latestSourceNode?.meta?.evidenceDurationSeconds || meta.durationSeconds),
        sourceDurationSeconds: meta.durationSeconds,
        audioCodec: "mp3",
        channels: 1,
        sampleRate: 16000,
        bitrate: "48k",
        ...(latestSourceNode ? { sourceNodeId: latestSourceNode.id } : {}),
        sourceFileName: source.displayName,
        ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
        ...(source.sourceBytes ? { sourceBytes: source.sourceBytes } : {}),
        extraction: "on-demand",
      },
      ...newAudioPosition(latestWorkflow, latestSourceNode?.id, executorNodeId),
    });
    const replacedAudioNodes = latestWorkflow.nodes.filter((node) => node.kind === "audio" && isReplaceableVideoEvidenceNode(node));
    const replacedAudioIds = new Set(replacedAudioNodes.map((node) => node.id));
    const retainedNodes = latestWorkflow.nodes.filter((node) => !replacedAudioIds.has(node.id));
    const retainedEdges = latestWorkflow.edges.filter((edge) => !replacedAudioIds.has(edge.from) && !replacedAudioIds.has(edge.to));
    const synchronized = synchronizeAutomaticAudioReferences({
      previousNodes: latestWorkflow.nodes,
      nextNodes: retainedNodes,
      previousEdges: latestWorkflow.edges,
      nextEdges: retainedEdges,
      newAudioNode: audioNode,
    });
    const next = await updateBoardWorkflow(id, {
      nodes: [...synchronized.nodes, audioNode],
      edges: [
        ...synchronized.edges,
        ...(latestSourceNode ? [createEdge(latestSourceNode.id, audioNode.id, "剥离音频")] : []),
        createEdge(executorNodeId, audioNode.id, "节点执行输出"),
      ],
    }, latestWorkflow.revision ?? 0);
    graphSaved = true;
    const finalWorkflow = await finishNodeExecution(
      id,
      executorNodeId,
      inputNodeIds,
      [audioNode.id],
      "完整音频剥离完成",
    ) || next;
    const retiredPaths = replacedAudioNodes
      .map((node) => node.filePath)
      .filter((filePath): filePath is string => Boolean(filePath) && filePath !== outputPath);
    if (retiredPaths.length > 0) await deleteBoardFiles(id, retiredPaths).catch(() => undefined);
    return NextResponse.json({ workflow: finalWorkflow, node: audioNode });
  } catch (error) {
    if (outputPath && !graphSaved) await rm(outputPath, { force: true }).catch(() => undefined);
    if (!sourceCommitted && createdSourcePaths.length > 0) {
      await deleteBoardFiles(workflowId, createdSourcePaths).catch(() => undefined);
    }
    if (workflowId && executorNodeId) {
      await failNodeExecution(workflowId, executorNodeId, inputNodeIds, error instanceof Error ? error.message : "完整音频剥离失败").catch(() => null);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "完整音频剥离失败" },
      { status: 500 },
    );
  }
}
