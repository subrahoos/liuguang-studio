import { NextRequest, NextResponse } from "next/server";
import { internalAppOrigin } from "@/lib/request-security";
import { CloneMethod } from "@/lib/clone-methods";
import { buildCloneMethodDistillationPrompt } from "@/lib/clone-method-prompts";
import { extractLongJsonError, postJsonWithLongTimeout } from "@/lib/server/long-json-request";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

type LlmConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  visionModel?: string;
};

function safeJson(text: string): Record<string, unknown> {
  const direct = text.trim();
  try {
    return JSON.parse(direct) as Record<string, unknown>;
  } catch {
    const match = direct.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as Record<string, unknown>;
    throw new Error("The configured LLM did not return valid JSON for method distillation.");
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeUsageMode(value: unknown): "normal" | "clone" | "both" {
  return value === "normal" || value === "clone" || value === "both" ? value : "both";
}

function fallbackVideoStructureBreakdown(analysis: unknown): string[] {
  const text = String(analysis || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter((line) => line.length >= 12);
  return text.slice(0, 12);
}

async function callChatJson(llm: Required<LlmConfig>, prompt: string) {
  const baseUrl = llm.baseUrl.replace(/\/+$/, "").replace(/\/v1\/chat\/completions$/i, "/v1");
  const url = /\/v1$/i.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const result = await postJsonWithLongTimeout(
    url,
    {
      model: llm.model,
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content:
            "You are an ecommerce short-video clone-method distillation expert. Analyze visual, camera, asset, and video-generation logic in precise English, but return the main method-library fields in Chinese as requested by the JSON schema. Return strict JSON only. Do not output Markdown.",
        },
        { role: "user", content: prompt },
      ],
    },
    {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
    },
    0,
  );
  const json = result.payload as { choices?: Array<{ message?: { content?: string } }> };
  if (!result.ok) throw new Error(extractLongJsonError(result));
  const text = json.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("The configured LLM returned empty method distillation.");
  return safeJson(text);
}

function parseAnalysisJson(value: FormDataEntryValue | null) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid analysisJson payload for method distillation.");
  }
}

async function distillAndSaveMethod(input: {
  form: FormData;
  llm: Required<LlmConfig>;
  analysisJson: Record<string, unknown>;
  origin: string;
  cookie: string;
}) {
  const { form, llm, analysisJson, origin, cookie } = input;
  const distilled = await callChatJson(
    llm,
    buildCloneMethodDistillationPrompt({
      sourceVideoName: String(analysisJson.sourceVideoName || ""),
      analysis: String(analysisJson.analysis || ""),
      transcript: String(analysisJson.transcript || ""),
      userMethodName: String(form.get("methodName") || ""),
    }),
  );

  const now = new Date().toISOString().slice(0, 10);
  const name = String(distilled.name || form.get("methodName") || analysisJson.sourceVideoName || "新拆解方法");
  const videoStructureBreakdown = asStringArray(distilled.videoStructureBreakdown);
  const method: CloneMethod = {
    id: `distilled-${Date.now()}`,
    name,
    styleShortName: String(distilled.styleShortName || name).slice(0, 24),
    category: String(distilled.category || "其他"),
    usageMode: normalizeUsageMode(distilled.usageMode),
    description: String(distilled.description || ""),
    source: String(analysisJson.sourceVideoPath || ""),
    sourceVideoName: String(analysisJson.sourceVideoName || ""),
    sourceAnalysisPath: String(analysisJson.savedMarkdownPath || ""),
    sourceTranscript: String(analysisJson.transcript || ""),
    methodSummary: String(distilled.methodSummary || ""),
    videoStructureBreakdown: videoStructureBreakdown.length
      ? videoStructureBreakdown
      : fallbackVideoStructureBreakdown(analysisJson.analysis),
    shotTimeline: asStringArray(distilled.shotTimeline),
    voiceoverRules: asStringArray(distilled.voiceoverRules),
    actionRules: asStringArray(distilled.actionRules),
    expressionRules: asStringArray(distilled.expressionRules),
    sceneRules: asStringArray(distilled.sceneRules),
    productShowcaseRules: asStringArray(distilled.productShowcaseRules),
    visualStructure: asStringArray(distilled.visualStructure),
    assetNeeds: asStringArray(distilled.assetNeeds),
    directorRules: asStringArray(distilled.directorRules),
    productReplacementRules: asStringArray(distilled.productReplacementRules),
    grokPromptRules: asStringArray(distilled.grokPromptRules),
    failureReviewRules: asStringArray(distilled.failureReviewRules),
    qualityRubric: asStringArray(distilled.qualityRubric),
    assetRolePolicy: asStringArray(distilled.assetRolePolicy),
    englishMethodSummary: typeof distilled.englishMethodSummary === "string" ? distilled.englishMethodSummary : undefined,
    englishVisualRules: asStringArray(distilled.englishVisualRules),
    englishImagePromptRules: asStringArray(distilled.englishImagePromptRules),
    englishVideoPromptRules: asStringArray(distilled.englishVideoPromptRules),
    promptFocus: String(distilled.promptFocus || ""),
    updatedAt: now,
  };

  const saveRes = await fetch(new URL("/api/clone-methods", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(method),
  });
  const saved = await saveRes.json().catch(() => ({}));
  if (!saveRes.ok) throw new Error(saved.error || "方法保存失败。");

  return NextResponse.json({
    method: saved.method || method,
    methods: saved.methods,
    analysis: analysisJson,
  });
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);
    const cookie = req.headers.get("cookie") || "";
    const form = await req.formData();
    const llm: Required<LlmConfig> = {
      baseUrl: String(form.get("baseUrl") || ""),
      apiKey: String(form.get("apiKey") || ""),
      model: String(form.get("model") || ""),
      visionModel: String(form.get("visionModel") || ""),
    };
    if (!llm.baseUrl || !llm.apiKey || !llm.model) {
      return NextResponse.json({ error: "方法库拆解需要先配置 LLM。" }, { status: 400 });
    }

    const providedAnalysisJson = parseAnalysisJson(form.get("analysisJson"));
    if (providedAnalysisJson) {
      return distillAndSaveMethod({
        form,
        llm,
        analysisJson: providedAnalysisJson,
        origin: internalAppOrigin(),
        cookie,
      });
    }

    const analysisForm = new FormData();
    analysisForm.append("sourceVideoPath", String(form.get("sourceVideoPath") || ""));
    const sourceVideoFile = form.get("sourceVideoFile");
    if (sourceVideoFile instanceof File) analysisForm.append("sourceVideoFile", sourceVideoFile);
    analysisForm.append("userRequirements", String(form.get("userRequirements") || "请蒸馏为可复用方法库记录。"));
    analysisForm.append("baseUrl", llm.baseUrl);
    analysisForm.append("apiKey", llm.apiKey);
    analysisForm.append("model", llm.model);
    if (llm.visionModel) analysisForm.append("visionModel", llm.visionModel);

    const analysisRes = await fetch(new URL("/api/clone/analyze-video", internalAppOrigin()), {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : undefined,
      body: analysisForm,
    });
    const analysisJson = await analysisRes.json().catch(() => ({}));
    if (!analysisRes.ok) {
      throw new Error(analysisJson.error || "参考视频拆解失败。");
    }

    const distilled = await callChatJson(
      llm,
      buildCloneMethodDistillationPrompt({
        sourceVideoName: analysisJson.sourceVideoName,
        analysis: String(analysisJson.analysis || ""),
        transcript: String(analysisJson.transcript || ""),
        userMethodName: String(form.get("methodName") || ""),
      }),
    );

    const now = new Date().toISOString().slice(0, 10);
    const name = String(distilled.name || form.get("methodName") || analysisJson.sourceVideoName || "新拆解方法");
    const videoStructureBreakdown = asStringArray(distilled.videoStructureBreakdown);
    const method: CloneMethod = {
      id: `distilled-${Date.now()}`,
      name,
      styleShortName: String(distilled.styleShortName || name).slice(0, 24),
      category: String(distilled.category || "其他"),
      usageMode: normalizeUsageMode(distilled.usageMode),
      description: String(distilled.description || ""),
      source: String(analysisJson.sourceVideoPath || ""),
      sourceVideoName: String(analysisJson.sourceVideoName || ""),
      sourceAnalysisPath: String(analysisJson.savedMarkdownPath || ""),
      sourceTranscript: String(analysisJson.transcript || ""),
      methodSummary: String(distilled.methodSummary || ""),
      videoStructureBreakdown: videoStructureBreakdown.length
        ? videoStructureBreakdown
        : fallbackVideoStructureBreakdown(analysisJson.analysis),
      shotTimeline: asStringArray(distilled.shotTimeline),
      voiceoverRules: asStringArray(distilled.voiceoverRules),
      actionRules: asStringArray(distilled.actionRules),
      expressionRules: asStringArray(distilled.expressionRules),
      sceneRules: asStringArray(distilled.sceneRules),
      productShowcaseRules: asStringArray(distilled.productShowcaseRules),
      visualStructure: asStringArray(distilled.visualStructure),
      assetNeeds: asStringArray(distilled.assetNeeds),
      directorRules: asStringArray(distilled.directorRules),
      productReplacementRules: asStringArray(distilled.productReplacementRules),
      grokPromptRules: asStringArray(distilled.grokPromptRules),
      failureReviewRules: asStringArray(distilled.failureReviewRules),
      qualityRubric: asStringArray(distilled.qualityRubric),
      assetRolePolicy: asStringArray(distilled.assetRolePolicy),
      englishMethodSummary: typeof distilled.englishMethodSummary === "string" ? distilled.englishMethodSummary : undefined,
      englishVisualRules: asStringArray(distilled.englishVisualRules),
      englishImagePromptRules: asStringArray(distilled.englishImagePromptRules),
      englishVideoPromptRules: asStringArray(distilled.englishVideoPromptRules),
      promptFocus: String(distilled.promptFocus || ""),
      updatedAt: now,
    };

    const saveRes = await fetch(new URL("/api/clone-methods", internalAppOrigin()), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(method),
    });
    const saved = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok) throw new Error(saved.error || "方法保存失败。");

    return NextResponse.json({
      method: saved.method || method,
      methods: saved.methods,
      analysis: analysisJson,
    });
  } catch (error) {
    console.error("distill clone method failed:", error);
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "方法库视频拆解失败。" },
      { status: 500 },
    );
  }
}
