import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { NextRequest, NextResponse } from "next/server";
import { updateBoardWorkflow, type BoardWorkflowNode } from "@/lib/board-workflows";
import { extractLongJsonError, postOpenAiChatJsonWithLongTimeout } from "@/lib/server/long-json-request";
import { auditModelApiCall, normalizeModelApiUsage } from "@/lib/model-api-audit";
import {
  completeReferenceAnalysisJson,
  formatReferenceVideoAnalysis,
  REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION,
  type ReferenceVideoAnalysis,
} from "@/lib/video-director-input";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
const TRANSLATION_LLM_TIMEOUT_MS = 10 * 60 * 1000;

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
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
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

function translationPrompt(source: ReferenceVideoAnalysis) {
  return [
    "Translate every string value in the following English JSON into Simplified Chinese.",
    "Keep every property name, object, array, number, boolean, null value, storyboard label, time code, L# limb id, T# contact target id, and these fixed contact-state values exactly unchanged: contact, open_or_neutral, no_contact, not_observable, none, unknown.",
    "Do not add, remove, summarize, interpret, or reorder anything. Return strict JSON only.",
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
    const analysisNodeId = String(body.analysisNodeId || "");
    if (!llm?.baseUrl || !llm.apiKey || !llm.model) {
      return NextResponse.json({ error: "请先配置可用的 LLM。" }, { status: 400 });
    }
    const analysisNode = access.workflow.nodes.find((node) => node.id === analysisNodeId && roleOf(node) === "reference_method_analysis");
    if (!analysisNode) return NextResponse.json({ error: "找不到可翻译的英文参考视频拆解。" }, { status: 404 });
    if (Number(analysisNode.meta?.analysisSchemaVersion || 0) !== REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION) {
      return NextResponse.json({ error: "当前拆解报告不是最新结构，请重新拆解参考视频后再翻译。" }, { status: 400 });
    }
    const source = analysisNode.meta?.parsed as ReferenceVideoAnalysis | undefined;
    if (!source || typeof source !== "object") {
      return NextResponse.json({ error: "英文拆解不是可翻译的结构化结果，请先重新拆解参考视频。" }, { status: 400 });
    }
    completeReferenceAnalysisJson(source);

    const response = await auditModelApiCall({
      userId: access.user.id,
      callType: "llm",
      providerKey: "openai-compatible",
      channelId: "llm-default",
      channelName: "LLM",
      model: llm.model,
      source: "board.analyze.translate",
      boardWorkflowId: id,
      boardNodeId: analysisNodeId,
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
    const translated = extractJson<ReferenceVideoAnalysis>(rawText);
    if (!translated || !sameJsonShape(source, translated)) {
      return NextResponse.json({ error: "中文翻译没有保持英文拆解的原始结构，未保存本次结果。请重试。" }, { status: 502 });
    }
    completeReferenceAnalysisJson(translated);

    const translatedText = formatReferenceVideoAnalysis(translated, "chinese");
    const nodes = access.workflow.nodes.map((node) => node.id === analysisNode.id ? {
      ...node,
      meta: {
        ...node.meta,
        translatedChinese: {
          parsed: translated,
          rawText,
          text: translatedText,
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
