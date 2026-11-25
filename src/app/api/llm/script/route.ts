import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projectVersions, projects, scripts as scriptsTable } from "@/lib/db/schema";
import { generateScript, analyzeProduct, extractJSON } from "@/lib/script-engine/generator";
import { uniqueStrings } from "@/lib/prompt-dedup";
import { resolveOwnedStoredProjectFile } from "@/lib/project-local-archive";
import { resolveProjectVersion } from "@/lib/project-versions";
import type { ScriptStyleType } from "@/lib/script-engine/prompts";
import type { ProductCategory } from "@/lib/script-engine/templates";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { canAccessOptionalProject } from "@/lib/server/resource-access";
import { getIdentityPack, isIdentityPackFileUrl, resolveIdentityImageFile } from "@/lib/identity-pack";

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

function logScriptStage(projectId: unknown, stage: string, detail?: string) {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[script:${String(projectId || "no-project")}] ${stage}${suffix}`);
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

function buildProjectVisualAnalysisPrompt(productImageCount: number, characterImageCount: number): string {
  return [
    "You are an ecommerce visual analysis director. Inspect the attached product and character reference images before any script or prompt generation. Output Chinese JSON only.",
    `Attached image order: first ${productImageCount} image(s) are product references; next ${characterImageCount} image(s) are character/identity references.`,
    "Analyze product and character identity separately. Product images define clothing/product structure. Character images define face, body proportion, skin tone, and identity only; do not copy character-reference outfit as the product.",
    "Return valid JSON with fields: productVisualAnalysis { productType, visibleStructure, colorsAndMaterials, mutationRisks, sellableVisualPoints, recommendedShotForms }, characterVisualAnalysis { hasCharacterReference, identityLocks, lightingCalibration, outfitWarning }, scriptPlanningAdvice { bestStyle, mustHaveShots, promptRules }.",
  ].join("\n");
}

/** 将本地图片路径转为 base64 data URI，供 LLM 视觉模型使用 */
async function imagePathToBase64(imagePath: string, origin?: string, ownerId?: string): Promise<string> {
  if (ownerId && isIdentityPackFileUrl(imagePath)) {
    const filePath = resolveIdentityImageFile(ownerId, imagePath);
    if (filePath) {
      const buffer = await readFile(filePath);
      const ext = filePath.split(".").pop()?.toLowerCase() || "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    }
  }
  // 已经是完整 URL 或 base64，直接返回
  if (imagePath.startsWith("http") || imagePath.startsWith("data:")) {
    return imagePath;
  }

  if (imagePath.startsWith("/") && !imagePath.startsWith("/api/files/") && origin) {
    try {
      const response = await fetch(`${origin}${imagePath}`);
      if (!response.ok) return imagePath;
      const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
      const buffer = Buffer.from(await response.arrayBuffer());
      return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch {
      return imagePath;
    }
  }

  // 本地 API 路径如 /api/files/projectId/filename.png
  // 提取实际文件路径: data/uploads/projectId/filename.png
  const match = imagePath.match(/\/api\/files\/(.+)/);
  if (!match) return imagePath;

  const parts = match[1].split("/");
  const filePath = parts.length >= 2
    ? await resolveOwnedStoredProjectFile(ownerId || "", parts[0], "assets", parts.slice(1).join("/"))
    : "";

  if (!filePath) return imagePath;

  try {
    const buffer = await readFile(filePath);
    const base64 = buffer.toString("base64");
    // 根据扩展名推断 MIME 类型
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    };
    const mime = mimeMap[ext] || "image/png";
    return `data:${mime};base64,${base64}`;
  } catch {
    console.warn(`无法读取图片文件: ${filePath}`);
    return imagePath;
  }
}

// 生成带货脚本
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    productImages,
    productName,
    productCategory,
    category,
    productDescription,
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
    character,
    sourceVideoUrl,
    customRequirements,
    cloneContext,
    forceProductAnalysis,
    llmConfig,
    projectId,
    versionId,
  } = body;

  const access = await canAccessOptionalProject(req, projectId);
  if (!access) return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });

  if (!productName) {
    return NextResponse.json({ error: "请填写商品名称" }, { status: 400 });
  }

  const resolvedLlmConfig = await resolveLLMSetting(req, llmConfig);

  if (!resolvedLlmConfig?.baseUrl || !resolvedLlmConfig?.apiKey || !resolvedLlmConfig?.model) {
    return NextResponse.json({ error: "请配置 LLM 参数（baseUrl、apiKey、model）" }, { status: 400 });
  }
  const auditedLlmConfig = {
    ...resolvedLlmConfig,
    audit: {
      userId: access.user.id,
      providerKey: "openai-compatible",
      channelId: "llm-default",
      channelName: "LLM",
      source: "llm.script.generate",
      projectId: typeof projectId === "string" ? projectId : undefined,
    },
  };

  try {
    logScriptStage(projectId, "start");
    const { version: projectVersion } = typeof projectId === "string" && projectId
      ? await resolveProjectVersion(projectId, typeof versionId === "string" ? versionId : null)
      : { version: null };
    const snapshot = projectVersion?.configSnapshot;
    const snapshotSelection = snapshot && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>).identitySelection as { packId?: string; referenceIds?: string[] } | undefined
      : undefined;
    const identityPackId = snapshotSelection?.packId || access.project?.characterId || "";
    const selectedIdentityIds = Array.isArray(snapshotSelection?.referenceIds) ? snapshotSelection.referenceIds.map(String) : [];
    const selectedIdentityReferences = identityPackId
      ? (await getIdentityPack(access.user.id, identityPackId))?.references.filter((reference) => (
          reference.status === "approved" && selectedIdentityIds.includes(reference.id)
        )) ?? []
      : [];
    const selectedIdentityUrls = selectedIdentityReferences.map((reference) => reference.url);
    const resolvedCharacter = selectedIdentityUrls.length
      ? { ...(character && typeof character === "object" ? character : {}), referenceImages: selectedIdentityUrls }
      : character;
    // 商品图分析：将本地路径转为 base64 后传给视觉模型
    let analysis = forceProductAnalysis && productImages?.length
      ? undefined
      : body.productAnalysis;
    if (!analysis && productImages?.length > 0 && resolvedLlmConfig) {
      try {
        const productImagesForAnalysis = (productImages as string[]).slice(0, 3);
        const characterReferenceImages: string[] = selectedIdentityUrls.length
          ? selectedIdentityUrls.slice(0, 4)
          : Array.isArray(character?.referenceImages) ? character.referenceImages.slice(0, 4) : [];
        logScriptStage(projectId, "image-analysis:start", `${productImagesForAnalysis.length} product images, ${characterReferenceImages.length} character images`);
        const productImageUrls = await Promise.all(
          productImagesForAnalysis.map((image) => imagePathToBase64(image, req.nextUrl.origin, access.user.id))
        );
        const characterImageUrls = await Promise.all(
          characterReferenceImages.map((image) => imagePathToBase64(image, req.nextUrl.origin, access.user.id))
        );
        const uniqueProductImageUrls = uniqueStrings(productImageUrls);
        const productImageKeys = new Set(uniqueProductImageUrls.map((url) => url.toLowerCase()));
        const uniqueCharacterImageUrls = uniqueStrings(characterImageUrls).filter((url) => !productImageKeys.has(url.toLowerCase()));
        analysis = await analyzeProduct(
          [...uniqueProductImageUrls, ...uniqueCharacterImageUrls],
          auditedLlmConfig,
          buildProjectVisualAnalysisPrompt(uniqueProductImageUrls.length, uniqueCharacterImageUrls.length)
        );
        if (!analysis) {
          throw new Error("视觉模型未返回商品图分析内容");
        }
        logScriptStage(projectId, "image-analysis:done");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logScriptStage(projectId, "image-analysis:failed", message);
        throw new Error(`商品图视觉分析失败: ${message}`);
      }
    }

    // 生成脚本
    const resolvedStyleType = resolveAutoStyle(styleType, analysis);
    logScriptStage(projectId, "script-generation:start");
    const scripts = await generateScript({
      productName,
      category: normalizeCategory(productCategory || category),
      productDescription,
      productAnalysis: analysis,
      styleType: resolvedStyleType,
      targetDuration: Number(duration || targetDuration || 30),
      videoMode,
      videoAspectRatio,
      videoResolution,
      sourceVideoUrl,
      customRequirements,
      priceRange,
      targetAudience,
      platforms,
      usageAdvantage,
      character: resolvedCharacter,
      llmConfig: auditedLlmConfig,
    });
    logScriptStage(projectId, "script-generation:done", `${scripts.length} scripts`);

    if (projectId) {
      logScriptStage(projectId, "persist:start");
      const db = getDb();
      const { version } = await resolveProjectVersion(projectId, typeof versionId === "string" ? versionId : null);
      if (!version) throw new Error("项目版本不存在");
      await db.delete(scriptsTable).where(and(eq(scriptsTable.projectId, projectId), eq(scriptsTable.versionId, version.id)));
      if (scripts.length > 0) {
        await db.insert(scriptsTable).values(
          scripts.map((script, index) => ({
            projectId,
            versionId: version.id,
            version: index + 1,
            styleType: normalizeStyle(script.styleType || resolvedStyleType),
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
          videoMode: videoMode || "product_closeup",
          videoAspectRatio: ["9:16", "16:9", "1:1"].includes(videoAspectRatio) ? videoAspectRatio : undefined,
          videoResolution: videoResolution === "1080p" ? "1080p" : "720p",
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
      logScriptStage(projectId, "persist:done");
    }

    logScriptStage(projectId, "done");
    return NextResponse.json({ scripts, analysis });
  } catch (error) {
    console.error("脚本生成失败:", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `脚本生成失败: ${errMsg}` },
      { status: 500 }
    );
  }
}
