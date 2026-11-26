import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import type { AuthUser } from "@/lib/auth";
import { authorizeLocalVideoPath } from "@/lib/server/local-file-access";
import { createReadStream, existsSync } from "fs";
import { mkdir, readdir, rm } from "fs/promises";
import { basename, extname, join } from "path";
import { execFile } from "child_process";
import { Readable } from "stream";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
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
  type VideoProbeMeta,
} from "@/lib/board-workflows";
import { synchronizeAutomaticAudioReferences } from "@/lib/board-video-audio-sync";
import { currentReferenceVideoNode, markCurrentReferenceVideo, newReferenceVideoPosition } from "@/lib/board-input-assets";
import { boardMediaTool, probeBoardVideo } from "@/lib/board-video-audio";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import {
  actionSupplementBoardFilter,
  actionSupplementCells,
  isReplaceableVideoEvidenceNode,
  resolveEvidenceBoundary,
  storyboardCells,
  storyboardOverviewFilter,
} from "@/lib/video-evidence";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const DEFAULT_STORYBOARD_INTERVAL = 1;
const ACTION_SUPPLEMENT_INTERVAL_SECONDS = 0.5;

type Params = { params: Promise<{ id: string }> };

interface ExtractionOptions {
  storyboardInterval: number;
  sceneThreshold: number;
}

interface PreparedVideo {
  videoPath: string;
  sourceVideoName: string;
  options: ExtractionOptions;
  executorNodeId: string;
  clientTaskId: string;
  createdFilePaths: string[];
  sourceSha256?: string;
  sourceBytes?: number;
  storageReused: boolean;
}

function readNumber(form: FormData, key: string, fallback: number, min: number, max: number) {
  const raw = Number(form.get(key) || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function readExtractionOptions(form: FormData): ExtractionOptions {
  return {
    storyboardInterval: DEFAULT_STORYBOARD_INTERVAL,
    sceneThreshold: readNumber(form, "sceneThreshold", 0.18, 0.05, 0.6),
  };
}

function trimVideoFilter(durationSeconds: number, nextFilter: string) {
  return `trim=start=0:end=${durationSeconds.toFixed(3)},setpts=PTS-STARTPTS,${nextFilter}`;
}

async function detectSceneCutTimes(videoPath: string, threshold: number) {
  try {
    const { stderr } = await execFileAsync(boardMediaTool("ffmpeg"), [
      "-i", videoPath,
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-an",
      "-f", "null",
      "NUL",
    ], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    return Array.from(stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g))
      .map((match) => Number(match[1]))
      .filter((time) => Number.isFinite(time) && time > 0)
      .filter((time, index, values) => index === 0 || Math.abs(time - values[index - 1]) > 0.01);
  } catch {
    return [];
  }
}

async function prepareVideo(req: NextRequest, id: string, workflow: BoardWorkflow, user: AuthUser): Promise<PreparedVideo> {
  const form = await req.formData();
  const file = form.get("sourceVideoFile");
  const localPath = String(form.get("sourceVideoPath") || "").trim();
  const sourceNodeId = String(form.get("sourceNodeId") || "").trim();
  const executorNodeId = String(form.get("executorNodeId") || "");
  const clientTaskId = String(form.get("clientTaskId") || "");
  const options = readExtractionOptions(form);
  const reusableFilePaths = [
    workflow.sourceVideoPath,
    ...workflow.nodes.map((node) => node.filePath),
  ].filter((filePath): filePath is string => Boolean(filePath));

  async function saveSourceVideo(stream: ReadableStream<Uint8Array>, originalName: string, extension: string) {
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
      videoPath: stored.filePath,
      sourceVideoName: originalName,
      options,
      executorNodeId,
      clientTaskId,
      createdFilePaths: stored.reused ? [] : [stored.filePath],
      sourceSha256: stored.sha256,
      sourceBytes: stored.bytes,
      storageReused: stored.reused,
    };
  }

  if (file instanceof File && file.size > 0) {
    const ext = extname(file.name).toLowerCase() || ".mp4";
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error("只支持 mp4、webm、mov、m4v 视频。");
    return saveSourceVideo(file.stream(), file.name, ext);
  }

  if (localPath) {
    const validated = await authorizeLocalVideoPath(localPath, user, workflow.localDir);
    return saveSourceVideo(
      Readable.toWeb(createReadStream(validated)) as ReadableStream<Uint8Array>,
      basename(validated),
      extname(validated) || ".mp4",
    );
  }

  if (sourceNodeId) {
    const selected = workflow.nodes.find((node) => node.id === sourceNodeId && node.kind === "source_video");
    if (!selected?.filePath || !existsSync(selected.filePath)) {
      throw new Error("所选当前参考视频已不存在，请重新选择文件。");
    }
    return {
      videoPath: selected.filePath,
      sourceVideoName: String(selected.meta?.originalName || workflow.sourceVideoName || selected.title || basename(selected.filePath)),
      options,
      executorNodeId,
      clientTaskId,
      createdFilePaths: [],
      sourceSha256: typeof selected.meta?.sourceSha256 === "string" ? selected.meta.sourceSha256 : undefined,
      sourceBytes: typeof selected.meta?.sourceBytes === "number" ? selected.meta.sourceBytes : undefined,
      storageReused: true,
    };
  }

  const currentSource = currentReferenceVideoNode(workflow);
  if (currentSource?.filePath && existsSync(currentSource.filePath)) {
    return {
      videoPath: currentSource.filePath,
      sourceVideoName: String(currentSource.meta?.originalName || workflow.sourceVideoName || currentSource.title || basename(currentSource.filePath)),
      options,
      executorNodeId,
      clientTaskId,
      createdFilePaths: [],
      sourceSha256: typeof currentSource.meta?.sourceSha256 === "string" ? currentSource.meta.sourceSha256 : undefined,
      sourceBytes: typeof currentSource.meta?.sourceBytes === "number" ? currentSource.meta.sourceBytes : undefined,
      storageReused: true,
    };
  }

  if (executorNodeId) {
    const upstreamSource = manualUpstreamNodeIds(workflow, [executorNodeId])
      .map((nodeId) => workflow.nodes.find((node) => node.id === nodeId))
      .find((node) => node?.kind === "source_video" && node.filePath && existsSync(node.filePath));
    if (upstreamSource?.filePath) {
      return {
        videoPath: upstreamSource.filePath,
        sourceVideoName: workflow.sourceVideoName || basename(upstreamSource.filePath),
        options,
        executorNodeId,
        clientTaskId,
        createdFilePaths: [],
        storageReused: true,
      };
    }
  }

  throw new Error("请上传视频文件、填写本地视频路径，或把已有参考视频节点手动连线到本节点。");
}

async function cleanupEvidenceFiles(outputDir: string) {
  if (!existsSync(outputDir)) return;
  const files = await readdir(outputDir);
  await Promise.all(files
    .filter((name) => /^storyboard_(overview|\d+)\.(jpg|jpeg|png)$/i.test(name) || /^(keyframe|scene|action_detail)_\d+\.(jpg|jpeg|png)$/i.test(name) || name === "action_supplement.jpg")
    .map((name) => rm(join(outputDir, name), { force: true }).catch(() => null)));
}

async function extractEvidence(videoPath: string, outputDir: string, sourceDurationSeconds: number, options: ExtractionOptions) {
  await mkdir(outputDir, { recursive: true });
  await cleanupEvidenceFiles(outputDir);
  const detectedSceneCutTimes = await detectSceneCutTimes(videoPath, options.sceneThreshold);
  const boundary = resolveEvidenceBoundary({
    sourceDurationSeconds,
  });
  const evidenceDuration = boundary.durationSeconds;
  const orderedStoryboardCells = storyboardCells(evidenceDuration, options.storyboardInterval);
  const contentSceneCutTimes = detectedSceneCutTimes.filter((time) => time < evidenceDuration - 0.05);
  const supplementCells = actionSupplementCells(evidenceDuration, contentSceneCutTimes, {
    overviewIntervalSeconds: options.storyboardInterval,
    interstitialIntervalSeconds: ACTION_SUPPLEMENT_INTERVAL_SECONDS,
  });
  await execFileAsync(boardMediaTool("ffmpeg"), [
    "-y",
    "-i", videoPath,
    "-vf", trimVideoFilter(evidenceDuration, storyboardOverviewFilter(evidenceDuration, options.storyboardInterval)),
    "-frames:v", "1",
    "-q:v", "8",
    join(outputDir, "storyboard_overview.jpg"),
  ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });

  if (supplementCells.length > 0) {
    await execFileAsync(boardMediaTool("ffmpeg"), [
      "-y",
      "-i", videoPath,
      "-filter_complex", actionSupplementBoardFilter(supplementCells),
      "-frames:v", "1",
      "-q:v", "8",
      "-update", "1",
      join(outputDir, "action_supplement.jpg"),
    ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
  }

  const files = await readdir(outputDir);
  return {
    storyboards: files.filter((name) => /^storyboard_(overview|\d+)\.jpg$/i.test(name)).sort((a, b) => a === "storyboard_overview.jpg" ? -1 : b === "storyboard_overview.jpg" ? 1 : a.localeCompare(b)).slice(0, 1).map((name) => join(outputDir, name)),
    actionSupplementBoards: files.filter((name) => name === "action_supplement.jpg").map((name) => join(outputDir, name)),
    storyboardCells: orderedStoryboardCells,
    actionSupplementCells: supplementCells,
    sceneCutTimes: contentSceneCutTimes,
    detectedSceneCutTimes,
    boundary,
  };
}

function videoAspect(meta: VideoProbeMeta) {
  return meta.width && meta.height ? meta.width / meta.height : undefined;
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let inputNodeIds: string[] = [];
  let clientTaskId = "";
  let createdFilePaths: string[] = [];
  let generatedEvidenceDir = "";
  let graphSaved = false;
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const user = access.user;
    workflowId = id;
    const workflow = access.workflow;
    if (!workflow) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });

    const prepared = await prepareVideo(req, id, workflow, access.user);
    executorNodeId = prepared.executorNodeId;
    clientTaskId = prepared.clientTaskId;
    createdFilePaths = prepared.createdFilePaths;
    if (executorNodeId) await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);
    const meta = await probeBoardVideo(prepared.videoPath);
    const evidenceSetId = crypto.randomUUID();
    generatedEvidenceDir = join(workflow.localDir, "evidence", evidenceSetId);
    const evidence = await extractEvidence(prepared.videoPath, generatedEvidenceDir, meta.durationSeconds, prepared.options);
    const aspectRatio = videoAspect(meta);
    const existingSourceNode = workflow.nodes.find((node) => node.kind === "source_video" && node.filePath === prepared.videoPath);

    const sourceNode = createNode({
      kind: "source_video",
      title: "参考视频",
      description: `${prepared.sourceVideoName}，${Math.round(meta.durationSeconds)} 秒，${meta.width || "-"}x${meta.height || "-"}`,
      filePath: prepared.videoPath,
      publicUrl: boardFilePublicUrl(id, prepared.videoPath),
      meta: {
        ...(meta as unknown as Record<string, unknown>),
        aspectRatio,
        extractionOptions: prepared.options,
        evidenceSetId,
        source: "user-upload",
        ...(prepared.sourceSha256 ? { sourceSha256: prepared.sourceSha256 } : {}),
        ...(prepared.sourceBytes ? { sourceBytes: prepared.sourceBytes } : {}),
        storageReused: prepared.storageReused,
        evidenceDurationSeconds: evidence.boundary.durationSeconds,
        evidenceBoundarySource: evidence.boundary.source,
        detectedSceneCutTimes: evidence.detectedSceneCutTimes,
        evidenceGenerated: true,
        currentReferenceVideo: true,
      },
      ...(existingSourceNode
        ? { x: existingSourceNode.x, y: existingSourceNode.y }
        : newReferenceVideoPosition(workflow, executorNodeId)),
    });

    const evidenceDurationSeconds = evidence.boundary.durationSeconds;
    const storyboardNodes = evidence.storyboards.slice(0, 1).map((filePath) => createNode({
      kind: "storyboard",
      title: "故事板总览",
      description: `1 秒一格的全片总览，完整覆盖源视频 ${evidenceDurationSeconds.toFixed(2)} 秒；切镜时间由原视频检测。`,
      filePath,
      publicUrl: boardFilePublicUrl(id, filePath),
      meta: {
        index: 1,
        total: 1,
        aspectRatio: 1.5,
        assetRole: "storyboard_overview",
        evidenceSetId,
        storyboardInterval: prepared.options.storyboardInterval,
        evidenceBoundarySource: evidence.boundary.source,
        evidenceDurationSeconds,
        sceneCutTimes: evidence.sceneCutTimes,
        storyboardCells: evidence.storyboardCells,
      },
      x: 380,
      y: 80,
    }));

    const actionSupplementItems = evidence.actionSupplementBoards.map((filePath, index) => ({
      index: index + 1,
      total: evidence.actionSupplementBoards.length,
      title: "0.5 秒动作补证与切点两侧关键帧",
      filePath,
      publicUrl: boardFilePublicUrl(id, filePath),
    }));
    const actionSupplementNodes = actionSupplementItems.length > 0 ? [createNode({
      kind: "keyframe",
      title: "0.5 秒动作补证",
      description: "仅含故事板遗漏的 0.5 秒补差帧，以及每个程序切点的切前/切后关键帧。默认不送入 LLM；需要精拆动作时请手动直连。",
      filePath: actionSupplementItems[0].filePath,
      publicUrl: actionSupplementItems[0].publicUrl,
      meta: {
        index: 1,
        total: actionSupplementItems.length,
        displayed: actionSupplementItems.length,
        aspectRatio: 1.5,
        assetRole: "action_supplement_storyboard_collection",
        evidenceSetId,
        supplementIntervalSeconds: ACTION_SUPPLEMENT_INTERVAL_SECONDS,
        evidenceDurationSeconds,
        supplementCells: evidence.actionSupplementCells,
        items: actionSupplementItems,
      },
      x: 760,
      y: 80,
    })] : [];

    const allNodes = [sourceNode, ...storyboardNodes, ...actionSupplementNodes];
    inputNodeIds = [];
    const edges = allNodes
      .filter((node) => node.id !== sourceNode.id)
      .map((node) => createEdge(sourceNode.id, node.id, "抽帧/提取"));
    const executorEdges = executorNodeId
      ? allNodes.map((node) => createEdge(executorNodeId, node.id, "节点执行输出"))
      : [];
    const latestWorkflow = await getBoardWorkflow(id, user.id) || workflow;
    if (
      isBoardTaskCancelled(id, clientTaskId) ||
      (executorNodeId && isNodeExecutionCancelled(latestWorkflow, executorNodeId))
    ) {
      if (createdFilePaths.length > 0) await deleteBoardFiles(id, createdFilePaths).catch(() => undefined);
      await rm(generatedEvidenceDir, { recursive: true, force: true }).catch(() => undefined);
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }

    const previousCurrentSource = currentReferenceVideoNode(latestWorkflow);
    const matchingAudio = [...latestWorkflow.nodes].reverse().find((node) => {
      if (node.kind !== "audio" || String(node.meta?.assetRole || "") !== "audio_evidence") return false;
      const audioSourceNodeId = String(node.meta?.sourceNodeId || "");
      const audioSha256 = String(node.meta?.sourceSha256 || "");
      return Boolean(
        (previousCurrentSource && audioSourceNodeId === previousCurrentSource.id)
        || (prepared.sourceSha256 && audioSha256 === prepared.sourceSha256),
      );
    });
    const replacedNodeIds = new Set(latestWorkflow.nodes
      .filter(isReplaceableVideoEvidenceNode)
      .filter((node) => node.id !== matchingAudio?.id)
      .map((node) => node.id));
    const retainedNodes = latestWorkflow.nodes
      .filter((node) => !replacedNodeIds.has(node.id))
      .map((node) => node.id === matchingAudio?.id ? {
        ...node,
        meta: {
          ...(node.meta || {}),
          evidenceSetId,
          evidenceBoundarySource: evidence.boundary.source,
          evidenceDurationSeconds,
          sourceNodeId: sourceNode.id,
          sourceFileName: prepared.sourceVideoName,
          ...(prepared.sourceSha256 ? { sourceSha256: prepared.sourceSha256 } : {}),
          ...(prepared.sourceBytes ? { sourceBytes: prepared.sourceBytes } : {}),
        },
      } : node);
    const retainedEdges = latestWorkflow.edges.filter((edge) => !replacedNodeIds.has(edge.from) && !replacedNodeIds.has(edge.to));
    const synchronizedAudioReferences = synchronizeAutomaticAudioReferences({
      previousNodes: latestWorkflow.nodes,
      nextNodes: retainedNodes,
      previousEdges: latestWorkflow.edges,
      nextEdges: retainedEdges,
      newAudioNode: null,
    });

    const audioSourceEdge = matchingAudio
      ? [createEdge(sourceNode.id, matchingAudio.id, "剥离音频")]
      : [];
    const next = await updateBoardWorkflow(id, {
      status: "evidence",
      sourceVideoPath: prepared.videoPath,
      sourceVideoName: prepared.sourceVideoName,
      nodes: markCurrentReferenceVideo([...synchronizedAudioReferences.nodes, ...allNodes], sourceNode.id),
      edges: [...synchronizedAudioReferences.edges, ...edges, ...audioSourceEdge, ...executorEdges],
    }, latestWorkflow.revision ?? 0);
    graphSaved = true;
    const retiredEvidenceFiles = latestWorkflow.nodes
      .filter(isReplaceableVideoEvidenceNode)
      .filter((node) => node.id !== matchingAudio?.id)
      .filter((node) => node.kind !== "source_video")
      .map((node) => node.filePath)
      .filter((filePath): filePath is string => Boolean(filePath));
    if (retiredEvidenceFiles.length > 0) {
      await deleteBoardFiles(id, retiredEvidenceFiles).catch(() => undefined);
    }
    const finalWorkflow = executorNodeId
      ? await finishNodeExecution(id, executorNodeId, inputNodeIds, allNodes.map((node) => node.id), "参考视频导入和抽帧完成") || next
      : next;
    clearBoardTaskCancellation(id, clientTaskId);

    return NextResponse.json({
      workflow: finalWorkflow,
      meta,
      evidence: {
        storyboardCount: evidence.storyboards.length,
        actionSupplementBoardCount: evidence.actionSupplementBoards.length,
        sceneCutTimes: evidence.sceneCutTimes,
        evidenceDurationSeconds,
        evidenceBoundarySource: evidence.boundary.source,
        hasAudio: meta.hasAudio,
        options: prepared.options,
      },
    });
  } catch (error) {
    if (!graphSaved && workflowId) {
      if (createdFilePaths.length > 0) await deleteBoardFiles(workflowId, createdFilePaths).catch(() => undefined);
      if (generatedEvidenceDir) await rm(generatedEvidenceDir, { recursive: true, force: true }).catch(() => undefined);
    }
    console.error("board video evidence failed:", error);
    if (workflowId && executorNodeId) {
      await failNodeExecution(workflowId, executorNodeId, inputNodeIds, error instanceof Error ? error.message : "视频抽帧失败").catch(() => null);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "参考视频导入和抽帧失败" },
      { status: 500 }
    );
  }
}

