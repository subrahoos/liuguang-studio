import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { projectVersions, projects } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { getIdentityPack } from "@/lib/identity-pack";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const db = getDb();
    const result = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, user.id))
      .orderBy(desc(projects.createdAt));
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取项目列表失败" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const db = getDb();
    const requestedIdentityPackId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    const rawIdentityReferenceIds: unknown[] = Array.isArray(body.identityReferenceIds)
      ? body.identityReferenceIds
      : [];
    const requestedIdentityReferenceIds = Array.from(new Set(
      rawIdentityReferenceIds
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    ));
    if (!requestedIdentityPackId && requestedIdentityReferenceIds.length > 0) {
      return NextResponse.json({ error: "选择人物参考图时必须同时指定人物包。" }, { status: 400 });
    }
    let identitySelection: { packId: string; referenceIds: string[] } | null = null;
    if (requestedIdentityPackId) {
      const identityPack = await getIdentityPack(user.id, requestedIdentityPackId);
      if (!identityPack) {
        return NextResponse.json({ error: "选择的人物包不存在或不属于当前账户。" }, { status: 400 });
      }
      const approvedIds = new Set(identityPack.references.filter((reference) => reference.status === "approved").map((reference) => reference.id));
      const referenceIds = requestedIdentityReferenceIds.filter((referenceId) => approvedIds.has(referenceId));
      if (requestedIdentityReferenceIds.length && referenceIds.length !== requestedIdentityReferenceIds.length) {
        return NextResponse.json({ error: "人物包中包含未通过验收或不存在的参考图。" }, { status: 400 });
      }
      if (referenceIds.length === 0) {
        return NextResponse.json({ error: "请至少选择一张已通过验收的人物参考图。" }, { status: 400 });
      }
      identitySelection = { packId: identityPack.id, referenceIds };
    }

    const [project] = await db
      .insert(projects)
      .values({
        ownerId: user.id,
        name: body.name || "未命名项目",
        productName: body.productName,
        productCategory: body.productCategory,
        productDescription: body.productDescription,
        productImages: body.productImages || [],
        productId: body.productId || null,
        templateId: body.templateId || null,
        characterId: identitySelection?.packId || null,
        sourceType: body.sourceType === "clone" || body.sourceVideoUrl ? "clone" : "manual",
        sourceVideoUrl: body.sourceVideoUrl || null,
        videoMode: body.videoMode || "product_closeup",
        videoAspectRatio: ["9:16", "16:9", "1:1"].includes(body.videoAspectRatio) ? body.videoAspectRatio : "9:16",
        videoResolution: body.videoResolution === "1080p" ? "1080p" : "720p",
        imageChannelId: typeof body.imageChannelId === "string" ? body.imageChannelId : null,
        videoChannelId: typeof body.videoChannelId === "string" ? body.videoChannelId : null,
      })
      .returning();

    const [version] = await db
      .insert(projectVersions)
      .values({
        projectId: project.id,
        name: "版本1",
        versionNumber: 1,
        versionType: project.sourceType === "clone" ? "clone" : "normal",
        status: project.status,
        productAnalysis: project.productAnalysis ?? null,
        configSnapshot: identitySelection ? { identitySelection } : null,
        isDefault: true,
      })
      .returning();
    const [updatedProject] = await db
      .update(projects)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(projects.id, project.id))
      .returning();

    return NextResponse.json({ ...(updatedProject ?? project), currentVersion: version }, { status: 201 });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建项目失败" },
      { status: 500 }
    );
  }
}
