import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, projects, projectVersions, scripts, type Shot } from "@/lib/db/schema";
import { resolveProjectVersion, versionIdFromRequest } from "@/lib/project-versions";

type AssetPayload = {
  versionId?: string | null;
  shotId: number;
  type: "ai_generated" | "product_image" | "user_upload";
  filePath?: string | null;
  thumbnailPath?: string | null;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  status?: "pending" | "generating" | "done" | "failed";
};

type UnknownRecord = Record<string, unknown>;

function parseClonePlan(productAnalysis?: string | null): UnknownRecord | null {
  if (!productAnalysis?.trim()) return null;
  try {
    const parsed = JSON.parse(productAnalysis) as UnknownRecord;
    const workflow = parsed.cloneWorkflow;
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return null;
    const plan = (workflow as UnknownRecord).plan;
    return plan && typeof plan === "object" && !Array.isArray(plan) ? plan as UnknownRecord : null;
  } catch {
    return null;
  }
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return value == null ? "" : String(value);
}

function inferCloneShotType(text: string): Shot["type"] {
  const normalized = text.toLowerCase();
  if (/hook|opening|first frame|anchor|开场|首帧|锚点/.test(normalized)) return "hook";
  if (/detail|collar|sleeve|waist|fabric|texture|structure|细节|结构|材质|领口|袖口|腰部|面料/.test(normalized)) return "product_reveal";
  if (/demo|try-on|wear|action|pose|model|person|模特|人物|动作|试穿|上身/.test(normalized)) return "demo";
  if (/scene|atmosphere|background|环境|场景|氛围|背景/.test(normalized)) return "social_proof";
  return "product_reveal";
}

function flattenClonePrompts(clonePlan: UnknownRecord | null): UnknownRecord[] {
  if (!clonePlan) return [];
  const segmentPlans = Array.isArray(clonePlan.segmentAssetPlans)
    ? clonePlan.segmentAssetPlans as UnknownRecord[]
    : [];
  const nested = segmentPlans.flatMap((segment, segmentIndex) => {
    const explicitIndex = Number(segment.segmentIndex);
    const safeSegmentIndex = Number.isFinite(explicitIndex) && explicitIndex > 0
      ? Math.round(explicitIndex)
      : segmentIndex + 1;
    const prompts = Array.isArray(segment.image2AssetPrompts)
      ? segment.image2AssetPrompts as UnknownRecord[]
      : [];
    return prompts.slice(0, 7).map((prompt, promptIndex) => ({
      ...prompt,
      segmentIndex: Number(prompt.segmentIndex) || safeSegmentIndex,
      segmentTimeRange: prompt.segmentTimeRange || segment.timeRange || "",
      segmentStoryPurpose: prompt.segmentStoryPurpose || segment.storyPurpose || segment.segmentDirectorSummary || "",
      assetRole: prompt.assetRole || prompt.role || `segment-${safeSegmentIndex}-asset-${promptIndex + 1}`,
    }));
  });
  if (nested.length > 0) return nested;
  return Array.isArray(clonePlan.image2AssetPrompts)
    ? clonePlan.image2AssetPrompts as UnknownRecord[]
    : [];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });

  try {
    const db = getDb();
    const { project, version } = await resolveProjectVersion(id, versionIdFromRequest(req));
    if (!project || !version) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const projectScripts = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.projectId, id), eq(scripts.versionId, version.id)))
      .orderBy(asc(scripts.version));
    const selectedScript = projectScripts.find((script) => script.selected) ?? projectScripts[0] ?? null;

    const savedAssets = await db
      .select()
      .from(assets)
      .where(and(eq(assets.projectId, id), eq(assets.versionId, version.id)))
      .orderBy(asc(assets.shotId));

    const scriptShots = selectedScript?.shots ?? [];
    const effectiveProductAnalysis = version.productAnalysis ?? project.productAnalysis;
    const clonePlan = version.versionType === "clone" || project.sourceType === "clone"
      ? parseClonePlan(effectiveProductAnalysis)
      : null;
    const clonePrompts = flattenClonePrompts(clonePlan);

    const viewAssets = scriptShots.length > 0 ? scriptShots.map((shot: Shot) => {
      const rawSaved = savedAssets.find((item) => item.shotId === shot.shotId);
      const isDirectProductImageReuse =
        rawSaved?.type === "product_image" &&
        rawSaved.filePath &&
        (project.productImages ?? []).includes(rawSaved.filePath);
      const saved = isDirectProductImageReuse ? undefined : rawSaved;
      const isUserUpload = shot.visualSource === "user_upload";

      return {
        id: saved?.id ?? null,
        shotId: shot.shotId,
        shotType: shot.type,
        duration: shot.duration,
        description: shot.description,
        camera: shot.camera,
        voiceover: shot.voiceover,
        prompt: shot.prompt ?? shot.description,
        finalPrompt: saved?.prompt ?? null,
        visualSource: shot.visualSource,
        transition: shot.transition,
        assetType: saved?.type ?? (isUserUpload ? "user_upload" : "ai_generated"),
        status: saved?.status ?? "pending",
        filePath: saved?.filePath ?? null,
        thumbnailPath: saved?.thumbnailPath ?? null,
        provider: saved?.provider ?? null,
        model: saved?.model ?? null,
      };
    }) : clonePrompts.map((prompt, index) => {
      const shotId = index + 1;
      const saved = savedAssets.find((item) => item.shotId === shotId);
      const assetName = textValue(prompt.assetName) || `鐖嗘璧勪骇 ${shotId}`;
      const purpose = textValue(prompt.purpose);
      const promptEnglish = textValue(prompt.promptEnglish);
      const referencePriority = textValue(prompt.referencePriority);
      const segmentIndex = Number(prompt.segmentIndex);
      const assetRole = textValue(prompt.assetRole);
      const combinedText = `${assetName}\n${purpose}\n${promptEnglish}\n${referencePriority}`;

      return {
        id: saved?.id ?? null,
        shotId,
        segmentIndex: Number.isFinite(segmentIndex) && segmentIndex > 0
          ? Math.round(segmentIndex)
          : Math.floor(index / 7) + 1,
        assetRole,
        shotType: inferCloneShotType(combinedText),
        duration: 0,
        description: [assetName, purpose].filter(Boolean).join(" - "),
        camera: referencePriority ? `参考优先级：${referencePriority}` : "爆款复刻资产区",
        voiceover: textValue(clonePlan?.voiceoverRewrite),
        prompt: promptEnglish || purpose || assetName,
        finalPrompt: saved?.prompt ?? null,
        visualSource: "ai_generate" as const,
        transition: "ai_reference" as const,
        assetType: saved?.type ?? "ai_generated" as const,
        status: saved?.status ?? "pending" as const,
        filePath: saved?.filePath ?? null,
        thumbnailPath: saved?.thumbnailPath ?? null,
        provider: saved?.provider ?? null,
        model: saved?.model ?? null,
      };
    });

    return NextResponse.json({
      project: {
        ...project,
        sourceType: version.versionType === "clone" ? "clone" : project.sourceType,
        productAnalysis: effectiveProductAnalysis,
        currentVersion: version,
        productImages: project.productImages ?? [],
      },
      script: selectedScript,
      assets: viewAssets,
    });
  } catch (error) {
    console.error("get project assets failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "鑾峰彇椤圭洰绱犳潗澶辫触" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const body = (await req.json()) as AssetPayload;

  if (!body.shotId || !body.type) {
    return NextResponse.json({ error: "缺少素材 shotId 或 type" }, { status: 400 });
  }

  try {
    const db = getDb();
    const { project, version } = await resolveProjectVersion(id, body.versionId ?? null);
    if (!project || !version) {
      return NextResponse.json({ error: "素材不存在" }, { status: 404 });
    }

    await db
      .delete(assets)
      .where(and(eq(assets.projectId, id), eq(assets.versionId, version.id), eq(assets.shotId, body.shotId)));

    const [saved] = await db
      .insert(assets)
      .values({
        projectId: id,
        versionId: version.id,
        shotId: body.shotId,
        type: body.type,
        filePath: body.filePath ?? null,
        thumbnailPath: body.thumbnailPath ?? body.filePath ?? null,
        provider: body.provider ?? null,
        model: body.model ?? null,
        prompt: body.prompt ?? null,
        status: body.status ?? "done",
      })
      .returning();

    await db.update(projects).set({ status: "assets", updatedAt: new Date() }).where(eq(projects.id, id));
    await db.update(projectVersions).set({ status: "assets", updatedAt: new Date() }).where(eq(projectVersions.id, version.id));

    return NextResponse.json(saved);
  } catch (error) {
    console.error("save project asset failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "淇濆瓨椤圭洰绱犳潗澶辫触" },
      { status: 500 }
    );
  }
}
