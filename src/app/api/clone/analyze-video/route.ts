import { mediaExecutable } from "@/lib/runtime-tools";
import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "fs/promises";
import { basename, extname, join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildCloneMethodEvidencePrompt } from "@/lib/clone-method-prompts";
import { extractLongJsonError, postJsonWithLongTimeout } from "@/lib/server/long-json-request";
import { canAccessOptionalProject } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { isPathInsideRoot, storagePaths } from "@/lib/storage-root";
import { auditModelApiCall, normalizeModelApiUsage, type ModelApiAuditContext } from "@/lib/model-api-audit";
import {
  actionSupplementBoardFilter,
  actionSupplementCells,
  resolveEvidenceBoundary,
  storyboardCells,
  storyboardOverviewFilter,
  type ActionSupplementCell,
  type StoryboardCell,
} from "@/lib/video-evidence";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const DEFAULT_STORYBOARD_INTERVAL_SECONDS = 1;
const ACTION_SUPPLEMENT_INTERVAL_SECONDS = 0.5;
const REFERENCE_JPEG_QUALITY = "8";
const MAX_EVIDENCE_IMAGE_PAYLOAD_CHARS = 6_000_000;

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  audit?: Omit<ModelApiAuditContext, "callType" | "model">;
}

interface ReferenceVideoEvidence {
  durationSeconds: number;
  storyboardPath: string;
  actionSupplementPath: string | null;
  storyboardCells: StoryboardCell[];
  actionSupplementCells: ActionSupplementCell[];
  sceneCutTimes: number[];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizeBaseUrl(baseUrl)}/v1${path}`;
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const headers = (init.headers || {}) as Record<string, string>;
  const rawBody = typeof init.body === "string" ? init.body : "{}";
  let body: unknown = {};
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = {};
  }
  const result = await postJsonWithLongTimeout(url, body, headers, timeoutMs);
  if (!result.ok) {
    throw Object.assign(new Error(extractLongJsonError(result)), { code: "API_ERROR", statusCode: result.status });
  }
  return { payload: result.payload, status: result.status };
}

async function auditedLlmRequest(
  llm: LlmConfig,
  source: string,
  model: string,
  execute: () => ReturnType<typeof fetchJsonWithTimeout>,
) {
  const context = llm.audit
    ? {
        ...llm.audit,
        callType: "llm" as const,
        model,
        source: `${llm.audit.source}.${source}`,
      }
    : null;
  if (!context) return execute();
  return auditModelApiCall(context, execute, {
    toResult: (result) => ({
      httpStatus: result.status,
      usage: normalizeModelApiUsage((result.payload as { usage?: unknown } | null)?.usage),
    }),
  });
}

function extractText(payload: unknown): string {
  const body = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("\n")
      .trim();
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text || "").join("").trim();
  return "";
}

function safeProjectId(projectId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Invalid projectId.");
  return projectId;
}

async function validateVideoPath(filePath: string, projectId: string) {
  const resolved = resolve(filePath.trim().replace(/^"|"$/g, ""));
  const ext = extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error("Reference video must be mp4/webm/mov/m4v.");
  const allowedRoot = storagePaths.clone("uploads", projectId);
  const [resolvedReal, allowedRootReal] = await Promise.all([
    realpath(resolved).catch(() => null),
    realpath(allowedRoot).catch(() => allowedRoot),
  ]);
  if (!resolvedReal || !isPathInsideRoot(resolvedReal, allowedRootReal)) {
    throw new Error("Reference video must be inside the current project's upload directory.");
  }
  const info = await stat(resolvedReal);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_VIDEO_BYTES) {
    throw new Error("Reference video is missing, empty, or larger than 800MB.");
  }
  return resolvedReal;
}

function mediaTool(name: "ffmpeg" | "ffprobe") {
  return mediaExecutable(name);
}

async function saveUploadedVideo(file: File, projectId: string) {
  const ext = extname(file.name).toLowerCase() || ".mp4";
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error("Reference video must be mp4/webm/mov/m4v.");
  if (file.size > MAX_VIDEO_BYTES) throw new Error("Reference video is larger than 800MB.");
  const dir = storagePaths.clone("uploads", projectId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `clone-source-${Date.now()}${ext}`);
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return target;
}

async function prepareSourceVideo(form: FormData, projectId: string) {
  const file = form.get("sourceVideoFile");
  const sourcePath = String(form.get("sourceVideoPath") || "").trim();
  if (file instanceof File && file.size > 0) return saveUploadedVideo(file, projectId);
  if (/^https?:\/\//i.test(sourcePath)) {
    throw new Error("当前高相似拆解请先下载到本地或直接上传视频文件，链接解析暂未接入。");
  }
  if (sourcePath) {
    const validated = await validateVideoPath(sourcePath, projectId);
    const dir = storagePaths.clone("uploads", projectId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `clone-source-${Date.now()}${extname(validated).toLowerCase()}`);
    await copyFile(validated, target);
    return target;
  }
  throw new Error("Please upload a reference video or fill a local video path.");
}

async function probeVideo(videoPath: string) {
  try {
    const { stdout } = await execFileAsync(mediaTool("ffprobe"), [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      videoPath,
    ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; bit_rate?: string; size?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; codec_name?: string }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    return {
      durationSeconds: Number(parsed.format?.duration || 0),
      width: video?.width,
      height: video?.height,
      fps: video?.avg_frame_rate,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
      sizeBytes: Number(parsed.format?.size || 0),
      bitRate: parsed.format?.bit_rate,
      hasAudio: Boolean(audio),
    };
  } catch {
    return { durationSeconds: 0, hasAudio: false };
  }
}

function trimVideoFilter(durationSeconds: number, nextFilter: string) {
  return `trim=start=0:end=${durationSeconds.toFixed(3)},setpts=PTS-STARTPTS,${nextFilter}`;
}

async function detectSceneCutTimes(videoPath: string, threshold = 0.18) {
  try {
    const { stderr } = await execFileAsync(mediaTool("ffmpeg"), [
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

async function extractReferenceVideoEvidence(
  videoPath: string,
  outDir: string,
  sourceDurationSeconds: number,
): Promise<ReferenceVideoEvidence> {
  const boundary = resolveEvidenceBoundary({ sourceDurationSeconds });
  const durationSeconds = boundary.durationSeconds;
  const detectedCutTimes = await detectSceneCutTimes(videoPath);
  const sceneCutTimes = detectedCutTimes.filter((time) => time < durationSeconds - 0.05);
  const overviewCells = storyboardCells(durationSeconds, DEFAULT_STORYBOARD_INTERVAL_SECONDS);
  const supplementCells = actionSupplementCells(durationSeconds, sceneCutTimes, {
    overviewIntervalSeconds: DEFAULT_STORYBOARD_INTERVAL_SECONDS,
    interstitialIntervalSeconds: ACTION_SUPPLEMENT_INTERVAL_SECONDS,
  });
  const storyboardPath = join(outDir, "storyboard_overview.jpg");
  const actionSupplementPath = supplementCells.length ? join(outDir, "action_supplement.jpg") : null;

  await execFileAsync(mediaTool("ffmpeg"), [
    "-y",
    "-i", videoPath,
    "-vf", trimVideoFilter(durationSeconds, storyboardOverviewFilter(durationSeconds, DEFAULT_STORYBOARD_INTERVAL_SECONDS)),
    "-frames:v", "1",
    "-q:v", REFERENCE_JPEG_QUALITY,
    storyboardPath,
  ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });

  if (actionSupplementPath) {
    await execFileAsync(mediaTool("ffmpeg"), [
      "-y",
      "-i", videoPath,
      "-filter_complex", actionSupplementBoardFilter(supplementCells),
      "-frames:v", "1",
      "-q:v", REFERENCE_JPEG_QUALITY,
      "-update", "1",
      actionSupplementPath,
    ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
  }

  if (!existsSync(storyboardPath)) throw new Error("Failed to extract the one-second storyboard evidence.");
  if (actionSupplementPath && !existsSync(actionSupplementPath)) {
    throw new Error("Failed to extract the half-second action supplement evidence.");
  }
  return {
    durationSeconds,
    storyboardPath,
    actionSupplementPath,
    storyboardCells: overviewCells,
    actionSupplementCells: supplementCells,
    sceneCutTimes,
  };
}

async function extractAudio(videoPath: string, outDir: string) {
  const audioPath = join(outDir, "audio_full.mp3");
  try {
    await execFileAsync(mediaTool("ffmpeg"), [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      audioPath,
    ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    if (!existsSync(audioPath)) return null;
    const bytes = await readFile(audioPath);
    if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) return null;
    return bytes.toString("base64");
  } catch {
    return null;
  }
}

async function transcribeAudio(audioBase64: string | null, llm: LlmConfig) {
  if (!audioBase64) return "";
  const prompt = "请把这段参考视频完整音频转写成中文文案，并尽量保留停顿、重复、口头语、节奏和段落。只返回可读文案。";
  const model = llm.visionModel?.trim() || llm.model;
  try {
    const responsesPayload = await auditedLlmRequest(llm, "audio.responses", model, () => fetchJsonWithTimeout(openAIEndpoint(llm.baseUrl, "/responses"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: "You transcribe ecommerce short-video audio into Simplified Chinese.",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" } },
          ],
        }],
        max_output_tokens: 5000,
      }),
    }, 0));
    return extractText(responsesPayload.payload).trim();
  } catch {
    try {
      const chatPayload = await auditedLlmRequest(llm, "audio.chat", model, () => fetchJsonWithTimeout(openAIEndpoint(llm.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${llm.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" } },
            ],
          }],
          max_tokens: 5000,
        }),
      }, 0));
      return extractText(chatPayload.payload).trim();
    } catch {
      return "";
    }
  }
}

async function imageToDataUrl(filePath: string) {
  const bytes = await readFile(filePath);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function analyzeReferenceEvidence(input: {
  evidence: ReferenceVideoEvidence;
  llm: LlmConfig;
  meta: Awaited<ReturnType<typeof probeVideo>>;
  transcript: string;
  userRequirements: string;
}) {
  const prompt = buildCloneMethodEvidencePrompt({
    meta: input.meta as Record<string, unknown>,
    durationSeconds: input.evidence.durationSeconds,
    storyboardCells: input.evidence.storyboardCells,
    actionSupplementCells: input.evidence.actionSupplementCells,
    sceneCutTimes: input.evidence.sceneCutTimes,
    transcript: input.transcript,
    analysisFocus: input.userRequirements,
  });
  const storyboardImage = await imageToDataUrl(input.evidence.storyboardPath);
  const actionSupplementImage = input.evidence.actionSupplementPath
    ? await imageToDataUrl(input.evidence.actionSupplementPath)
    : "";
  const imagePayloadApproxChars = storyboardImage.length + actionSupplementImage.length;
  if (imagePayloadApproxChars > MAX_EVIDENCE_IMAGE_PAYLOAD_CHARS) {
    throw new Error("Storyboard evidence is too large to send without dropping action frames. Shorten or re-encode the reference video, then retry.");
  }
  const model = input.llm.visionModel?.trim() || input.llm.model;

  const payload = await auditedLlmRequest(input.llm, "reference-analysis.chat", model, () => fetchJsonWithTimeout(openAIEndpoint(input.llm.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.llm.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: storyboardImage, detail: "low" } },
          ...(actionSupplementImage
            ? [{ type: "image_url" as const, image_url: { url: actionSupplementImage, detail: "high" as const } }]
            : []),
        ],
      }],
      temperature: 0.25,
      max_tokens: 8000,
    }),
  }, 0));

  const text = extractText(payload.payload).trim();
  if (!text) throw new Error("Reference video analysis returned empty text.");
  return {
    text,
    method: "ffmpeg_1s_storyboard_plus_0.5s_action_supplement_and_audio_chat_completions",
    sentStoryboardCount: 1,
    sentActionSupplementCount: actionSupplementImage ? 1 : 0,
    imagePayloadApproxChars,
  };
}

function buildSavedMarkdown(input: {
  projectId: string;
  sourceVideoPath: string;
  sourceVideoName: string;
  meta: Awaited<ReturnType<typeof probeVideo>>;
  evidence: ReferenceVideoEvidence;
  transcript: string;
  analysis: string;
  method: string;
}) {
  return [
    "# 爆款复刻拆解方法",
    "",
    `- 项目ID：${input.projectId}`,
    `- 来源视频：${input.sourceVideoName}`,
    `- 本地路径：${input.sourceVideoPath}`,
    `- 分析方法：${input.method}`,
    `- 1 秒故事板：${input.evidence.storyboardCells.length} 格`,
    `- 0.5 秒动作补证：${input.evidence.actionSupplementCells.length} 格`,
    `- 程序切点：${input.evidence.sceneCutTimes.length ? input.evidence.sceneCutTimes.map((time) => time.toFixed(3)).join(", ") : "未检测到"}`,
    `- 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "## 视频基础信息",
    "",
    "```json",
    JSON.stringify(input.meta, null, 2),
    "```",
    "",
    "## 抽帧证据清单",
    "",
    `S（1 秒故事板）：${input.evidence.storyboardCells.map((cell) => `${cell.sequence} ${cell.timestamp}`).join(", ")}`,
    `P（0.5 秒动作补证与切点两侧帧）：${input.evidence.actionSupplementCells.map((cell) => `${cell.sequence} ${cell.timestamp}`).join(", ")}`,
    "",
    "## 原视频音频/口播转写",
    "",
    input.transcript || "未识别到音频口播，或当前模型不支持音频输入。",
    "",
    "## 详细证据拆解",
    "",
    input.analysis,
    "",
  ].join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const requestedProjectId = String(form.get("projectId") || "");
    const access = await canAccessOptionalProject(req, requestedProjectId);
    if (!access) return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
    const projectId = requestedProjectId
      ? safeProjectId(requestedProjectId)
      : safeProjectId(`method-${access.user.id}-${Date.now()}`);
    const incomingLlm: LlmConfig = {
      baseUrl: String(form.get("baseUrl") || ""),
      apiKey: String(form.get("apiKey") || ""),
      model: String(form.get("model") || ""),
      visionModel: String(form.get("visionModel") || "") || undefined,
    };
    const userRequirements = String(form.get("userRequirements") || "").trim();
    if (userRequirements.length > 1200) {
      return NextResponse.json({ error: "补充核对重点不能超过 1200 个字符。" }, { status: 400 });
    }
    const resolvedLlm = await resolveLLMSetting(req, incomingLlm);
    if (!resolvedLlm?.baseUrl || !resolvedLlm.apiKey || !resolvedLlm.model) {
      return NextResponse.json({ error: "Missing LLM config." }, { status: 400 });
    }
    const llm: LlmConfig = {
      ...resolvedLlm,
      audit: {
        userId: access.user.id,
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        source: "clone.analyze-video",
        projectId: requestedProjectId || undefined,
      },
    };

    const sourceVideoPath = await prepareSourceVideo(form, projectId);
    const analysisDir = storagePaths.clone("analysis", projectId, String(Date.now()));
    await mkdir(analysisDir, { recursive: true });

    const meta = await probeVideo(sourceVideoPath);
    const [evidence, audio] = await Promise.all([
      extractReferenceVideoEvidence(sourceVideoPath, analysisDir, meta.durationSeconds || 30),
      meta.hasAudio ? extractAudio(sourceVideoPath, analysisDir) : Promise.resolve(null),
    ]);

    const transcript = await transcribeAudio(audio, llm);
    const analysis = await analyzeReferenceEvidence({
      evidence,
      llm,
      meta,
      transcript,
      userRequirements,
    });

    const savedMarkdown = buildSavedMarkdown({
      projectId,
      sourceVideoPath,
      sourceVideoName: basename(sourceVideoPath),
      meta,
      evidence,
      transcript,
      analysis: analysis.text,
      method: analysis.method,
    });
    const savedMarkdownPath = join(analysisDir, "爆款复刻拆解方法.md");
    await writeFile(savedMarkdownPath, savedMarkdown, "utf8");

    return NextResponse.json({
      sourceVideoPath,
      sourceVideoName: basename(sourceVideoPath),
      meta,
      analysisMode: analysis.method,
      storyboardFrameCount: evidence.storyboardCells.length,
      actionSupplementFrameCount: evidence.actionSupplementCells.length,
      sceneCutTimes: evidence.sceneCutTimes,
      sentStoryboardCount: analysis.sentStoryboardCount,
      sentActionSupplementCount: analysis.sentActionSupplementCount,
      imagePayloadApproxChars: analysis.imagePayloadApproxChars,
      storyboardCells: evidence.storyboardCells,
      actionSupplementCells: evidence.actionSupplementCells,
      transcript,
      analysis: analysis.text,
      method: analysis.method,
      savedMarkdown,
      savedMarkdownPath,
    });
  } catch (error) {
    console.error("clone video analysis failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "clone video analysis failed" },
      { status: 500 }
    );
  }
}
