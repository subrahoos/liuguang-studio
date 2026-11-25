import { NextRequest, NextResponse } from "next/server";
import { updateBoardWorkflow, type BoardWorkflowNode } from "@/lib/board-workflows";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { extractLongJsonError, postOpenAiChatJsonWithLongTimeout } from "@/lib/server/long-json-request";
import { auditModelApiCall, normalizeModelApiUsage } from "@/lib/model-api-audit";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
const TRANSLATION_LLM_TIMEOUT_MS = 10 * 60 * 1000;

interface DirectorPlan {
  fullDirectorPromptEnglish?: string;
  segmentPrompts?: Array<{
    segmentIndex?: number;
    timeRange?: string;
    outputTimeRange?: string;
    duration?: number;
    promptEnglish?: string;
  }>;
}

function roleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1$/i, "");
}

function endpoint(baseUrl: string) {
  return `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
}

function extractText(payload: unknown): string {
  const body = payload as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>; output_text?: string };
  if (typeof body.output_text === "string") return body.output_text;
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text || "").join("").trim();
  return "";
}

function extractJson<T>(text: string): T | null {
  const cleaned = text.trim().replace(/^\`\`\`json\s*/i, "").replace(/\`\`\`$/i, "").trim();
  const candidates = [cleaned, cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function sameJsonShape(source: unknown, translation: unknown): boolean {
  if (typeof source === "string") return typeof translation === "string";
  if (typeof source === "number" || typeof source === "boolean" || source === null) return source === translation;
  if (Array.isArray(source)) {
    return Array.isArray(translation)
      && source.length === translation.length
      && source.every((item, index) => sameJsonShape(item, translation[index]));
  }
  if (!source || typeof source !== "object" || !translation || typeof translation !== "object" || Array.isArray(translation)) return false;
  const sourceRecord = source as Record<string, unknown>;
  const translationRecord = translation as Record<string, unknown>;
  const sourceKeys = Object.keys(sourceRecord).sort();
  const translationKeys = Object.keys(translationRecord).sort();
  return sourceKeys.length === translationKeys.length
    && sourceKeys.every((key, index) => key === translationKeys[index] && sameJsonShape(sourceRecord[key], translationRecord[key]));
}

function formatChineseDirectorTranslation(translated: DirectorPlan) {
  const segments = (translated.segmentPrompts || [])
    .map((segment) => [
      `### 分段 ${segment.segmentIndex || ""} 参考 ${segment.timeRange || ""} · 输出 ${segment.outputTimeRange || ""}`.trim(),
      segment.promptEnglish || "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  return [
    "# 完整视频导演稿中文译文",
    translated.fullDirectorPromptEnglish ? `## 全片导演母稿\n${translated.fullDirectorPromptEnglish}` : "",
    segments ? `## 分段执行稿\n${segments}` : "",
  ].filter(Boolean).join("\n\n").trim();
}

function translationPrompt(source: DirectorPlan) {
  return [
    "Translate every English string value in the following JSON into Simplified Chinese.",
    "Keep every property name, object, array, number, time code, duration, quoted Mandarin spoken line, and JSON structure exactly unchanged.",
    "Do not add, remove, summarize, reinterpret, or reorder anything. Return strict JSON only.",
    "",
    JSON.stringify(source, null, 2),
  ].join("\n");
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access?.workflow) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const body = await req.json();
    const llm = await resolveLLMSetting(req);
    const directorNodeId = String(body.directorNodeId || "");
    if (!llm?.baseUrl || !llm.apiKey || !llm.model) {
      return NextResponse.json({ error: "请先配置可用的 LLM。" }, { status: 400 });
    }
    const directorNode = access.workflow.nodes.find((node) => node.id === directorNodeId && roleOf(node) === "video_director_prompt");
    if (!directorNode) return NextResponse.json({ error: "找不到可翻译的英文完整视频导演稿。" }, { status: 404 });
    const source = directorNode.meta?.parsed as DirectorPlan | undefined;
    if (!source?.fullDirectorPromptEnglish || !Array.isArray(source.segmentPrompts)) {
      return NextResponse.json({ error: "英文导演稿不是可翻译的结构化结果，请先重新生成导演稿。" }, { status: 400 });
    }

    const response = await auditModelApiCall({
      userId: access.user.id,
      callType: "llm",
      providerKey: "openai-compatible",
      channelId: "llm-default",
      channelName: "LLM",
      model: llm.model,
      source: "board.director.translate",
      boardWorkflowId: id,
      boardNodeId: directorNodeId,
    }, () => postOpenAiChatJsonWithLongTimeout(endpoint(llm.baseUrl), {
      model: llm.model,
      messages: [{ role: "user", content: translationPrompt(source) }],
      temperature: 0,
      max_tokens: 7000,
    }, {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "daihuo-jianshou/1.0",
    }, TRANSLATION_LLM_TIMEOUT_MS), {
      toResult: (result) => ({
        httpStatus: result.status,
        usage: normalizeModelApiUsage((result.payload as { usage?: unknown } | null)?.usage),
      }),
      toError: (result) => result.ok ? undefined : { errorCode: "API_ERROR" },
    });
    if (!response.ok) throw new Error(extractLongJsonError(response));
    const rawText = extractText(response.payload).trim();
    const translated = extractJson<DirectorPlan>(rawText);
    if (!translated || !sameJsonShape(source, translated)) {
      return NextResponse.json({ error: "中文翻译没有保持英文导演稿的原始结构，未保存本次结果。请重试。" }, { status: 502 });
    }

    const nodes = access.workflow.nodes.map((node) => node.id === directorNode.id ? {
      ...node,
      meta: {
        ...node.meta,
        translatedChinese: {
          parsed: translated,
          rawText,
          text: formatChineseDirectorTranslation(translated),
          translatedAt: new Date().toISOString(),
        },
      },
    } : node);
    const workflow = await updateBoardWorkflow(id, { nodes }, access.workflow.revision ?? 0);
    return NextResponse.json({ workflow, translated: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "中文翻译失败" }, { status: 500 });
  }
}
