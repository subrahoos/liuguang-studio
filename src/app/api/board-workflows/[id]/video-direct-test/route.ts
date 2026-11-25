import { mediaExecutable } from "@/lib/runtime-tools";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { existsSync } from "fs";
import { mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { extractLongJsonError, postJsonWithLongTimeout } from "@/lib/server/long-json-request";
import { storagePaths } from "@/lib/storage-root";
import { auditModelApiCall } from "@/lib/model-api-audit";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

const execFileAsync = promisify(execFile);
const SAMPLE_SECONDS = 1.5;
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;

function mediaTool(name: "ffmpeg") {
  return mediaExecutable(name);
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
}

function endpoint(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}/v1${path.startsWith("/") ? path : `/${path}`}`;
}

function extractText(payload: unknown): string {
  const body = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output.flatMap((item) => item.content || []).map((content) => content.text || "").join("\n").trim();
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text || "").join("").trim();
  return "";
}

async function createTinyVideoSample(sourcePath: string, outputPath: string) {
  await execFileAsync(mediaTool("ffmpeg"), [
    "-y",
    "-i", sourcePath,
    "-t", String(SAMPLE_SECONDS),
    "-vf", "scale=320:-2",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "32",
    "-movflags", "+faststart",
    outputPath,
  ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const bytes = await readFile(outputPath);
  if (bytes.length <= 0) throw new Error("视频小样生成失败。");
  if (bytes.length > MAX_SAMPLE_BYTES) throw new Error(`瑙嗛灏忔牱鏈粛鐒惰繃澶э細${Math.round(bytes.length / 1024 / 1024)}MB`);
  return `data:video/mp4;base64,${bytes.toString("base64")}`;
}

async function tryChatVideo(llm: LlmConfig, videoDataUrl: string) {
  const model = llm.visionModel?.trim() || llm.model;
  const payload = await postJsonWithLongTimeout(endpoint(llm.baseUrl, "/chat/completions"), {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "This is a direct video-input capability test. If you can inspect the video, reply exactly: DIRECT_VIDEO_OK, then add a short Chinese description within 20 characters." },
        { type: "video_url", video_url: { url: videoDataUrl } },
      ],
    }],
    temperature: 0,
    max_tokens: 80,
  }, {
    Authorization: `Bearer ${llm.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "daihuo-jianshou/1.0",
  }, 180_000);
  if (!payload.ok) throw Object.assign(new Error(extractLongJsonError(payload)), { code: "API_ERROR", statusCode: payload.status });
  return extractText(payload.payload);
}

async function tryResponsesVideo(llm: LlmConfig, videoDataUrl: string) {
  const model = llm.visionModel?.trim() || llm.model;
  const payload = await postJsonWithLongTimeout(endpoint(llm.baseUrl, "/responses"), {
    model,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "This is a direct video-input capability test. If you can inspect the video, reply exactly: DIRECT_VIDEO_OK, then add a short Chinese description within 20 characters." },
        { type: "input_video", video_url: videoDataUrl },
      ],
    }],
    temperature: 0,
    max_output_tokens: 80,
  }, {
    Authorization: `Bearer ${llm.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "daihuo-jianshou/1.0",
  }, 180_000);
  if (!payload.ok) throw Object.assign(new Error(extractLongJsonError(payload)), { code: "API_ERROR", statusCode: payload.status });
  return extractText(payload.payload);
}

export async function POST(req: NextRequest, { params }: Params) {
  let temporaryDirectory = "";
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const workflow = access.workflow;
    if (!workflow.sourceVideoPath || !existsSync(workflow.sourceVideoPath)) {
      return NextResponse.json({ error: "请先登记参考视频，再测试视频直传。" }, { status: 400 });
    }

    await req.json();
    const llm = await resolveLLMSetting(req);
    if (!llm?.baseUrl || !llm.apiKey || !llm.model) {
      return NextResponse.json({ error: "请先配置可用的 LLM。" }, { status: 400 });
    }

    temporaryDirectory = storagePaths.tmp("board-direct-video-tests", crypto.randomUUID());
    await mkdir(temporaryDirectory, { recursive: true });
    const samplePath = join(temporaryDirectory, "sample.mp4");
    const videoDataUrl = await createTinyVideoSample(workflow.sourceVideoPath, samplePath);
    const errors: Record<string, string> = {};

    try {
      const text = await auditModelApiCall({
        userId: access.user.id,
        callType: "llm",
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        model: llm.visionModel?.trim() || llm.model,
        source: "board.video-direct-test.chat",
        boardWorkflowId: id,
      }, () => tryChatVideo(llm, videoDataUrl));
      return NextResponse.json({
        ok: true,
        method: "chat/completions video_url",
        reply: text,
        sampleSeconds: SAMPLE_SECONDS,
      });
    } catch (error) {
      errors.chatVideoUrl = error instanceof Error ? error.message : String(error);
    }

    try {
      const text = await auditModelApiCall({
        userId: access.user.id,
        callType: "llm",
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        model: llm.visionModel?.trim() || llm.model,
        source: "board.video-direct-test.responses",
        boardWorkflowId: id,
      }, () => tryResponsesVideo(llm, videoDataUrl));
      return NextResponse.json({
        ok: true,
        method: "responses input_video",
        reply: text,
        sampleSeconds: SAMPLE_SECONDS,
        chatVideoUrlError: errors.chatVideoUrl,
      });
    } catch (error) {
      errors.responsesInputVideo = error instanceof Error ? error.message : String(error);
    }

    return NextResponse.json({
      ok: false,
      error: "当前 LLM 没有返回可执行的视频结果，请检查模型配置或改用 FFmpeg 合成。",
      sampleSeconds: SAMPLE_SECONDS,
      errors,
    }, { status: 502 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "瑙嗛鐩翠紶娴嬭瘯澶辫触" },
      { status: 500 }
    );
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
