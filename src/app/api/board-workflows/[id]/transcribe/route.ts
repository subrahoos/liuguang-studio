import { transcriptionModel, transcriptionPython } from "@/lib/runtime-tools";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  createEdge,
  createNode,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  startNodeExecution,
  updateBoardWorkflow,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import { generatedOutputPosition } from "@/lib/board-node-placement";
import { assertCleanTranscriptText } from "@/lib/video-director-input";
import { storagePaths } from "@/lib/storage-root";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "small";
const TRANSCRIPTION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BUFFER = 20 * 1024 * 1024;

type Params = { params: Promise<{ id: string }> };

interface TranscriptSegment {
  startTime: string;
  endTime: string;
  text: string;
}

interface LocalTranscriptResult {
  language?: string;
  languageProbability?: number;
  sourceSegments: TranscriptSegment[];
  sourceText: string;
  segments: TranscriptSegment[];
  text: string;
  targetLanguage: "zh";
  task: "transcribe";
  model: string;
}

function roleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

function localPythonPath() {
  return transcriptionPython();
}

function scriptPath() {
  return join(process.cwd(), "scripts", "local-transcribe.py");
}

function parseResult(raw: string): LocalTranscriptResult {
  const result = JSON.parse(raw) as Partial<LocalTranscriptResult>;
  const segments = Array.isArray(result.segments)
    ? result.segments
      .map((segment) => ({
        startTime: String(segment?.startTime || "").trim(),
        endTime: String(segment?.endTime || "").trim(),
        text: String(segment?.text || "").trim(),
      }))
      .filter((segment) => segment.startTime && segment.endTime && segment.text)
    : [];
  const sourceSegments = Array.isArray(result.sourceSegments)
    ? result.sourceSegments
      .map((segment) => ({
        startTime: String(segment?.startTime || "").trim(),
        endTime: String(segment?.endTime || "").trim(),
        text: String(segment?.text || "").trim(),
      }))
      .filter((segment) => segment.startTime && segment.endTime && segment.text)
    : [];
  if (!segments.length || !sourceSegments.length || typeof result.text !== "string" || !result.text.trim() || typeof result.sourceText !== "string" || !result.sourceText.trim()) {
    throw new Error("本地转写没有返回可用的中文文本。");
  }
  assertCleanTranscriptText(result.text, "中文音频转写");
  assertCleanTranscriptText(result.sourceText, "音频原文转写");
  for (const segment of segments) assertCleanTranscriptText(segment.text, "中文音频转写分段");
  for (const segment of sourceSegments) assertCleanTranscriptText(segment.text, "音频原文转写分段");
  return {
    language: String(result.language || ""),
    languageProbability: Number(result.languageProbability || 0),
    sourceSegments,
    sourceText: result.sourceText.trim(),
    segments,
    text: result.text.trim(),
    targetLanguage: "zh",
    task: "transcribe",
    model: String(result.model || DEFAULT_MODEL),
  };
}

function transcriptNodeFor(audioNode: BoardWorkflowNode, result: LocalTranscriptResult, position: { x: number; y: number }) {
  return createNode({
    kind: "analysis",
    title: "中文音频转写",
    description: "使用本地 faster-whisper 读取完整中文口播并保留时间段；请手动连线到 LLM 拆参考视频方法。",
    text: result.text,
    meta: {
      assetRole: "voiceover_transcript",
      language: "chinese",
      targetLanguage: "zh",
      sourceLanguage: result.language || "unknown",
      sourceLanguageProbability: result.languageProbability || 0,
      sourceSegments: result.sourceSegments,
      sourceText: result.sourceText,
      sourceAudioNodeId: audioNode.id,
      evidenceSetId: String(audioNode.meta?.evidenceSetId || ""),
      segments: result.segments,
      method: "local-faster-whisper-mandarin-transcribe",
      task: result.task,
      model: result.model,
    },
    x: position.x,
    y: position.y,
  });
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
    const audioNodeId = String(body.audioNodeId || "");
    const clientTaskId = String(body.clientTaskId || "");
    executorNodeId = audioNodeId;
    const audioNode = workflow.nodes.find((node) => node.id === audioNodeId);
    if (!audioNode || (audioNode.kind !== "audio" && roleOf(audioNode) !== "audio_evidence")) {
      return NextResponse.json({ error: "找不到完整音频节点" }, { status: 404 });
    }
    if (!audioNode.filePath || !existsSync(audioNode.filePath)) {
      return NextResponse.json({ error: "完整音频文件不存在，请重新提取参考视频证据" }, { status: 400 });
    }
    const script = scriptPath();
    if (!existsSync(script)) {
      return NextResponse.json({ error: "本地转写脚本不存在" }, { status: 500 });
    }

    inputNodeIds = [audioNode.id];
    await startNodeExecution(id, audioNode.id, inputNodeIds, clientTaskId);
    const requestedModel = String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const model = requestedModel === DEFAULT_MODEL ? transcriptionModel() : requestedModel;
    const cacheDir = storagePaths.cache("whisper");
    await mkdir(cacheDir, { recursive: true });
    const python = localPythonPath();
    const result = await execFileAsync(
      python,
      [script, "--input", audioNode.filePath, "--model", model, "--device", "cpu", "--compute-type", "int8", "--language", "zh"],
      {
        timeout: TRANSCRIPTION_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BUFFER,
        env: {
          ...process.env,
          HF_HOME: cacheDir,
          HUGGINGFACE_HUB_CACHE: join(cacheDir, "hub"),
          HF_HUB_DOWNLOAD_TIMEOUT: "600",
          HF_HUB_ETAG_TIMEOUT: "600",
          HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      },
    );
    const transcript = parseResult(result.stdout);
    const latestWorkflow = await getBoardWorkflow(id, access.user.id) || workflow;
    if (isBoardTaskCancelled(id, clientTaskId) || isNodeExecutionCancelled(latestWorkflow, audioNode.id)) {
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }

    const replaceableNodes = latestWorkflow.nodes
      .filter((node) => roleOf(node) === "voiceover_transcript" && String(node.meta?.sourceAudioNodeId || "") === audioNode.id);
    const replacedIds = new Set(replaceableNodes.map((node) => node.id));
    const currentAudioNode = latestWorkflow.nodes.find((node) => node.id === audioNode.id) || audioNode;
    const outputPosition = generatedOutputPosition({
      nodes: latestWorkflow.nodes,
      anchor: currentAudioNode,
      outputKind: "analysis",
      outputRole: "voiceover_transcript",
      previousOutput: replaceableNodes.at(-1),
      excludedNodeIds: replacedIds,
    });
    const transcriptNode = transcriptNodeFor(currentAudioNode, transcript, outputPosition);
    const retainedNodes = latestWorkflow.nodes.filter((node) => !replacedIds.has(node.id));
    const retainedEdges = latestWorkflow.edges.filter((edge) => !replacedIds.has(edge.from) && !replacedIds.has(edge.to));
    const next = await updateBoardWorkflow(id, {
      nodes: [...retainedNodes, transcriptNode],
      edges: [...retainedEdges, createEdge(audioNode.id, transcriptNode.id, "本地中文转写")],
    }, latestWorkflow.revision ?? 0);
    const finalWorkflow = await finishNodeExecution(
      id,
      audioNode.id,
      inputNodeIds,
      [transcriptNode.id],
      "本地中文口播转写完成，请手动连接中文转写节点到 LLM 拆参考视频方法",
    ) || next;
    clearBoardTaskCancellation(id, clientTaskId);
    return NextResponse.json({ workflow: finalWorkflow, node: transcriptNode, transcript });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr || "").trim()
      : "";
    const rawMessage = stderr || (error instanceof Error ? error.message : "本地音频转写失败");
    const message = /No module named ['\"]?faster_whisper/i.test(rawMessage)
      ? "本地转写依赖 faster-whisper 未安装。请在项目目录运行 .venv\\Scripts\\python.exe -m pip install -r scripts\\requirements-local-transcribe.txt 后重试。"
      : rawMessage;
    if (workflowId && executorNodeId) {
      await failNodeExecution(workflowId, executorNodeId, inputNodeIds, message).catch(() => null);
    }
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
