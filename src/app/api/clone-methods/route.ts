import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { CloneMethod, defaultCloneMethods, sharedCloneAssetRolePolicy, sharedCloneQualityRubric } from "@/lib/clone-methods";
import { handleAuthRouteError, requireAdmin, requireUser } from "@/lib/auth";
import { storagePaths } from "@/lib/storage-root";

export const runtime = "nodejs";

const dataDir = () => storagePaths.clone("methods");
const dataFile = () => join(dataDir(), "methods.json");

async function readMethods(): Promise<CloneMethod[]> {
  const file = dataFile();
  if (!existsSync(file)) {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(file, JSON.stringify(defaultCloneMethods, null, 2), "utf8");
    return defaultCloneMethods.map(hydrateMethod);
  }

  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as CloneMethod[];
    const merged = [...defaultCloneMethods];
    for (const method of parsed) {
      if (!merged.some((item) => item.id === method.id)) merged.push(method);
    }
    return merged.map(hydrateMethod);
  } catch {
    return defaultCloneMethods.map(hydrateMethod);
  }
}

async function writeMethods(methods: CloneMethod[]) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(dataFile(), JSON.stringify(methods, null, 2), "utf8");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : undefined;
}

function normalizeUsageMode(value: unknown): "normal" | "clone" | "both" | undefined {
  return value === "normal" || value === "clone" || value === "both" ? value : undefined;
}

function hydrateMethod(method: CloneMethod): CloneMethod {
  return {
    ...method,
    qualityRubric: method.qualityRubric?.length ? method.qualityRubric : sharedCloneQualityRubric,
    assetRolePolicy: method.assetRolePolicy?.length ? method.assetRolePolicy : sharedCloneAssetRolePolicy,
  };
}

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    return NextResponse.json({ methods: await readMethods() });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取方法库失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json();
    const now = new Date().toISOString().slice(0, 10);
    const method: CloneMethod = {
      id: String(body.id || `method-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "-"),
      name: String(body.name || "未命名复刻方法"),
      styleShortName: optionalString(body.styleShortName),
      category: String(body.category || "自定义"),
      usageMode: normalizeUsageMode(body.usageMode),
      description: String(body.description || ""),
      sourceVideoName: optionalString(body.sourceVideoName),
      sourceAnalysisPath: optionalString(body.sourceAnalysisPath),
      sourceTranscript: optionalString(body.sourceTranscript),
      methodSummary: optionalString(body.methodSummary),
      videoStructureBreakdown: asStringArray(body.videoStructureBreakdown),
      shotTimeline: asStringArray(body.shotTimeline),
      voiceoverRules: asStringArray(body.voiceoverRules),
      actionRules: asStringArray(body.actionRules),
      expressionRules: asStringArray(body.expressionRules),
      sceneRules: asStringArray(body.sceneRules),
      productShowcaseRules: asStringArray(body.productShowcaseRules),
      visualStructure: asStringArray(body.visualStructure),
      assetNeeds: asStringArray(body.assetNeeds),
      directorRules: asStringArray(body.directorRules),
      productReplacementRules: asStringArray(body.productReplacementRules),
      grokPromptRules: asStringArray(body.grokPromptRules),
      failureReviewRules: asStringArray(body.failureReviewRules),
      qualityRubric: asStringArray(body.qualityRubric),
      assetRolePolicy: asStringArray(body.assetRolePolicy),
      englishMethodSummary: optionalString(body.englishMethodSummary),
      englishVisualRules: asStringArray(body.englishVisualRules),
      englishImagePromptRules: asStringArray(body.englishImagePromptRules),
      englishVideoPromptRules: asStringArray(body.englishVideoPromptRules),
      promptFocus: String(body.promptFocus || ""),
      source: optionalString(body.source),
      updatedAt: now,
    };

    const methods = await readMethods();
    const next = methods.some((item) => item.id === method.id)
      ? methods.map((item) => (item.id === method.id ? method : item))
      : [method, ...methods];
    await writeMethods(next);
    return NextResponse.json({ method, methods: next }, { status: 201 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "保存复刻方法失败" },
      { status: 500 },
    );
  }
}
