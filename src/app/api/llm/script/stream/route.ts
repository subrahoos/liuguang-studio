import { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projectVersions, projects, scripts as scriptsTable } from "@/lib/db/schema";
import { analyzeProduct, generateScript, parseScriptResponse, extractJSON } from "@/lib/script-engine/generator";
import { SYSTEM_PROMPT, buildBatchPrompt, type ScriptStyleType } from "@/lib/script-engine/prompts";
import { resolveOwnedStoredProjectFile } from "@/lib/project-local-archive";
import { resolveProjectVersion } from "@/lib/project-versions";
import type { GeneratedScript, LLMConfig, ScriptInput } from "@/lib/script-engine/generator";
import { canAccessOptionalProject } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import type { ProductCategory } from "@/lib/script-engine/templates";
import { auditModelApiCall } from "@/lib/model-api-audit";

export const runtime = "nodejs";
export const maxDuration = 180;

const STYLE_MAP: Record<string, ScriptStyleType> = {
  "pain-point": "pain_point",
  pain_point: "pain_point",
  scenario: "scene",
  scene: "scene",
  comparison: "comparison",
  story: "story",
  auto: "pain_point",
  custom: "custom",
};

const CATEGORY_MAP: Record<string, ProductCategory> = {
  beauty: "beauty",
  food: "food",
  home: "home",
  fashion: "fashion",
  digital: "tech",
  tech: "tech",
  other: "home",
};

const VIDEO_MODE_SET = new Set(["product_closeup", "graphic_montage", "scene_demo", "live_presenter"]);

type StreamEvent =
  | "progress"
  | "token"
  | "complete"
  | "error";

interface ScriptStreamBody {
  productImages?: string[];
  productName?: string;
  productCategory?: string;
  category?: string;
  productDescription?: string;
  productAnalysis?: string;
  forceProductAnalysis?: boolean;
  styleType?: string;
  duration?: number;
  targetDuration?: number;
  videoMode?: string;
  videoAspectRatio?: "9:16" | "16:9" | "1:1";
  videoResolution?: "720p" | "1080p";
  priceRange?: string;
  targetAudience?: string;
  platforms?: string | string[];
  usageAdvantage?: string;
  sourceVideoUrl?: string;
  customRequirements?: string;
  cloneContext?: Record<string, unknown>;
  character?: {
    id: string;
    name: string;
    appearance: string;
    voiceStyle?: string;
  };
  llmConfig?: LLMConfig;
  projectId?: string;
  versionId?: string;
}

function normalizeStyle(value: unknown): ScriptStyleType {
  return STYLE_MAP[String(value || "auto")] || "pain_point";
}

function resolveAutoStyle(styleType: unknown, analysis: unknown): ScriptStyleType {
  if (String(styleType || "auto") !== "auto") return normalizeStyle(styleType);
  if (typeof analysis !== "string" || !analysis.trim()) return "pain_point";

  try {
    const parsed = JSON.parse(extractJSON(analysis)) as {
      videoSuggestions?: { suggestedStyle?: string };
      suggestedStyle?: string;
    };
    const suggested = parsed.videoSuggestions?.suggestedStyle || parsed.suggestedStyle;
    if (suggested) return normalizeStyle(suggested);
  } catch {
    const lower = analysis.toLowerCase();
    if (/comparison|compare|对比|测评|横向/.test(lower)) return "comparison";
    if (/story|剧情|故事|反转|冲突/.test(lower)) return "story";
    if (/scene|scenario|场景|生活|通勤|约会|居家|户外/.test(lower)) return "scene";
  }

  return "pain_point";
}

function normalizeCategory(value: unknown): ProductCategory {
  return CATEGORY_MAP[String(value || "beauty")] || "beauty";
}

function normalizeVideoMode(value: unknown): "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter" {
  const mode = String(value || "product_closeup");
  return VIDEO_MODE_SET.has(mode)
    ? mode as "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter"
    : "product_closeup";
}

function normalizePlatforms(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(",");
  return typeof value === "string" ? value : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeBaseUrl(baseUrl)
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1\/images\/edits$/i, "")
    .replace(/\/v1\/images\/generations$/i, "")
    .replace(/\/v1\/videos(?:\/.*)?$/i, "")
    .replace(/\/v1$/i, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}/v1${path}`;
}

async function imagePathToBase64(imagePath: string, ownerId: string): Promise<string> {
  if (imagePath.startsWith("http") || imagePath.startsWith("data:")) {
    return imagePath;
  }

  const match = imagePath.match(/\/api\/files\/(.+)/);
  if (!match) return imagePath;

  const parts = match[1].split("/");
  const filePath = parts.length >= 2
    ? await resolveOwnedStoredProjectFile(ownerId, parts[0], "assets", parts.slice(1).join("/"))
    : "";

  if (!filePath) return imagePath;

  const buffer = await readFile(filePath);
  const base64 = buffer.toString("base64");
  const ext = filePath.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
  };
  const mime = mimeMap[ext] || "image/png";
  return `data:${mime};base64,${base64}`;
}

async function persistScripts(projectId: string | undefined, versionId: string | undefined, scripts: GeneratedScript[], analysis: string | undefined, videoMode: string | undefined) {
  if (!projectId) return;

  const db = getDb();
  const { version } = await resolveProjectVersion(projectId, versionId);
  if (!version) throw new Error("项目版本不存在");
  await db.delete(scriptsTable).where(and(eq(scriptsTable.projectId, projectId), eq(scriptsTable.versionId, version.id)));
  if (scripts.length > 0) {
    await db.insert(scriptsTable).values(
      scripts.map((script, index) => ({
        projectId,
        versionId: version.id,
        version: index + 1,
        styleType: normalizeStyle(script.styleType),
        title: script.title,
        totalDuration: script.totalDuration,
        shots: script.shots,
        selected: index === 0,
      }))
    );
  }
  await db
    .update(projects)
    .set({
      status: "scripting",
      productAnalysis: analysis || null,
      videoMode: normalizeVideoMode(videoMode),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
  await db
    .update(projectVersions)
    .set({
      status: "scripting",
      productAnalysis: analysis || null,
      updatedAt: new Date(),
    })
    .where(eq(projectVersions.id, version.id));
}

function buildPersistedAnalysis(analysis: unknown, cloneContext: unknown) {
  if (!cloneContext || typeof cloneContext !== "object") {
    return typeof analysis === "string" ? analysis : analysis ? JSON.stringify(analysis) : null;
  }

  let parsedAnalysis: unknown = analysis;
  if (typeof analysis === "string" && analysis.trim()) {
    try {
      parsedAnalysis = JSON.parse(extractJSON(analysis));
    } catch {
      parsedAnalysis = { rawProductAnalysis: analysis };
    }
  }

  return JSON.stringify({
    productVisualAnalysis: parsedAnalysis || null,
    cloneWorkflow: cloneContext,
  }, null, 2);
}

async function persistScriptsWithContext(
  projectId: string | undefined,
  versionId: string | undefined,
  scripts: GeneratedScript[],
  analysis: string | undefined,
  videoMode: string | undefined,
  cloneContext: unknown
) {
  if (!projectId) return;

  const db = getDb();
  const { version } = await resolveProjectVersion(projectId, versionId);
  if (!version) throw new Error("项目版本不存在");
  await db.delete(scriptsTable).where(and(eq(scriptsTable.projectId, projectId), eq(scriptsTable.versionId, version.id)));
  if (scripts.length > 0) {
    await db.insert(scriptsTable).values(
      scripts.map((script, index) => ({
        projectId,
        versionId: version.id,
        version: index + 1,
        styleType: normalizeStyle(script.styleType),
        title: script.title,
        totalDuration: script.totalDuration,
        shots: script.shots,
        selected: index === 0,
      }))
    );
  }
  await db
    .update(projects)
    .set({
      status: "scripting",
      productAnalysis: buildPersistedAnalysis(analysis, cloneContext),
      videoMode: normalizeVideoMode(videoMode),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
  await db
    .update(projectVersions)
    .set({
      status: "scripting",
      productAnalysis: buildPersistedAnalysis(analysis, cloneContext),
      updatedAt: new Date(),
    })
    .where(eq(projectVersions.id, version.id));
}

async function streamChatCompletion(input: ScriptInput, onToken: (token: string, totalChars: number) => void): Promise<string> {
  const prompt = buildBatchPrompt(input, 1);
  const response = await fetch(openAIEndpoint(input.llmConfig.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.llmConfig.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 6000,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => "");
    throw new Error(raw || `Chat Completions stream failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const payload = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const token = payload.choices?.[0]?.delta?.content || payload.choices?.[0]?.message?.content || "";
      if (token) {
        fullContent += token;
        onToken(token, fullContent.length);
      }
    }
  }

  if (!fullContent.trim()) {
    throw new Error("LLM stream returned empty content");
  }
  return fullContent;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as ScriptStreamBody;
  const access = await canAccessOptionalProject(req, body.projectId);
  if (!access) return new Response(JSON.stringify({ error: "未登录或无权访问该项目。" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  const resolvedLlmConfig = await resolveLLMSetting(req, body.llmConfig);
  if (!resolvedLlmConfig?.apiKey || !resolvedLlmConfig.baseUrl || !resolvedLlmConfig.model) {
    return new Response(JSON.stringify({ error: "请先配置可用的 LLM。" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  body.llmConfig = resolvedLlmConfig;
  const auditedLlmConfig: LLMConfig = {
    ...resolvedLlmConfig,
    audit: {
      userId: access.user.id,
      providerKey: "openai-compatible",
      channelId: "llm-default",
      channelName: "LLM",
      source: "llm.script.stream",
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    },
  };
  body.llmConfig = auditedLlmConfig;
  const encoder = new TextEncoder();

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: StreamEvent, data: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ ...data, at: new Date().toISOString() })}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const {
        productImages,
        productName,
        productCategory,
        category,
        productDescription,
        forceProductAnalysis,
        styleType,
        duration,
        targetDuration,
        videoMode,
        videoAspectRatio,
        videoResolution,
        priceRange,
        targetAudience,
        platforms,
        usageAdvantage,
        sourceVideoUrl,
        customRequirements,
        cloneContext,
        character,
        llmConfig,
        projectId,
        versionId,
      } = body;

      try {
        if (!productName) throw new Error("请填写商品名称");
        if (!llmConfig?.baseUrl || !llmConfig?.apiKey || !llmConfig?.model) {
          throw new Error("请配置 LLM 参数（baseUrl、apiKey、model）");
        }

        send(controller, "progress", {
          stage: "request-start",
          label: "已连接后端，开始准备脚本生成请求",
          progress: 3,
          source: "backend",
        });

        let analysis = forceProductAnalysis && productImages?.length
          ? undefined
          : body.productAnalysis;
        if (!analysis && productImages?.length) {
          const imagesForAnalysis = productImages.slice(0, 1);
          send(controller, "progress", {
            stage: "vision-start",
            label: "正在调用视觉模型分析商品图",
            progress: 10,
            source: "api",
            images: imagesForAnalysis.length,
          });
          const imageUrls = await Promise.all(imagesForAnalysis.map((image) => imagePathToBase64(image, access.user.id)));
          analysis = await analyzeProduct(imageUrls, llmConfig);
          send(controller, "progress", {
            stage: "vision-done",
            label: "商品图视觉分析已返回",
            progress: 32,
            source: "api",
            chars: analysis?.length ?? 0,
          });
        }

        const resolvedStyleType = resolveAutoStyle(styleType, analysis);
        const input: ScriptInput = {
          productName,
          category: normalizeCategory(productCategory || category),
          productDescription,
          productAnalysis: analysis,
          styleType: resolvedStyleType,
          targetDuration: Number(duration || targetDuration || 30),
          videoMode: normalizeVideoMode(videoMode),
          videoAspectRatio: ["9:16", "16:9", "1:1"].includes(String(videoAspectRatio)) ? videoAspectRatio : "9:16",
          videoResolution: videoResolution === "1080p" ? "1080p" : "720p",
          sourceVideoUrl,
          customRequirements,
          priceRange,
          targetAudience,
          platforms: normalizePlatforms(platforms),
          usageAdvantage,
          character,
          llmConfig,
        };

        send(controller, "progress", {
          stage: "llm-stream-start",
          label: "正在调用 LLM 流式生成脚本",
          progress: 38,
          source: "api",
        });

        let scripts: GeneratedScript[];
        try {
          const content = await auditModelApiCall({
            userId: access.user.id,
            callType: "llm",
            providerKey: "openai-compatible",
            channelId: "llm-default",
            channelName: "LLM",
            model: llmConfig.model,
            source: "llm.script.stream.chat",
            projectId: typeof projectId === "string" ? projectId : undefined,
          }, () => streamChatCompletion(input, (token, totalChars) => {
            const progress = Math.min(82, 38 + Math.floor(totalChars / 120));
            send(controller, "token", {
              stage: "llm-token",
              label: "LLM 正在返回脚本内容",
              progress,
              source: "api-stream",
              chars: totalChars,
              token,
            });
          }));
          send(controller, "progress", {
            stage: "parse-start",
            label: "LLM 返回完成，正在解析脚本 JSON",
            progress: 86,
            source: "backend",
          });
          scripts = parseScriptResponse(content, input.styleType);
        } catch (streamError) {
          send(controller, "progress", {
            stage: "stream-fallback",
            label: "当前接口不支持真实流式返回，已切换为普通 API 调用监控",
            progress: 40,
            source: "backend",
            detail: streamError instanceof Error ? streamError.message : String(streamError),
          });
          scripts = await generateScript(input);
        }

        send(controller, "progress", {
          stage: "persist-start",
          label: "脚本已生成，正在保存到本地项目",
          progress: 92,
          source: "local-db",
          scripts: scripts.length,
        });
        if (cloneContext) {
          await persistScriptsWithContext(projectId, versionId, scripts, analysis, videoMode, cloneContext);
        } else {
          await persistScripts(projectId, versionId, scripts, analysis, videoMode);
        }

        send(controller, "complete", {
          stage: "done",
          label: "脚本生成完成",
          progress: 100,
          source: "local-db",
          scripts,
          analysis,
        });
      } catch (error) {
        send(controller, "error", {
          stage: "failed",
          label: "脚本生成失败",
          progress: 100,
          source: "backend",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
