import { and, asc, eq, isNull, max } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, compositions, projectVersions, projects, scripts, videoClips, type ProjectVersionType } from "@/lib/db/schema";

export type ProjectVersion = typeof projectVersions.$inferSelect;

export type CreateProjectVersionMode = "blank" | "copy_full";

function sanitizeVersionType(value: unknown, fallback: ProjectVersionType): ProjectVersionType {
  return value === "clone" || value === "normal" ? value : fallback;
}

function defaultVersionType(project: typeof projects.$inferSelect): ProjectVersionType {
  return project.sourceType === "clone" ? "clone" : "normal";
}

export async function listProjectVersions(projectId: string) {
  const db = getDb();
  return db
    .select()
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(asc(projectVersions.versionNumber), asc(projectVersions.createdAt));
}

export async function getProjectVersion(projectId: string, versionId?: string | null) {
  const db = getDb();
  const rows = versionId
    ? await db
        .select()
        .from(projectVersions)
        .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId)))
    : await db
        .select()
        .from(projectVersions)
        .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.isDefault, true)))
        .orderBy(asc(projectVersions.versionNumber), asc(projectVersions.createdAt));
  return rows[0] ?? null;
}

export async function getOrCreateDefaultProjectVersion(project: typeof projects.$inferSelect) {
  const db = getDb();
  const existing = await getProjectVersion(project.id, project.currentVersionId) ?? await getProjectVersion(project.id);
  if (existing) return existing;

  const [created] = await db
    .insert(projectVersions)
    .values({
      projectId: project.id,
      name: "版本1",
      versionNumber: 1,
      versionType: defaultVersionType(project),
      status: project.status,
      productAnalysis: project.productAnalysis ?? null,
      isDefault: true,
    })
    .returning();

  await db.update(projects).set({ currentVersionId: created.id, updatedAt: new Date() }).where(eq(projects.id, project.id));
  await assignLooseRowsToVersion(project.id, created.id);
  return created;
}

export async function resolveProjectVersion(projectId: string, requestedVersionId?: string | null) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { project: null, version: null };
  const version =
    requestedVersionId
      ? await getProjectVersion(projectId, requestedVersionId)
      : await getProjectVersion(projectId, project.currentVersionId) ?? await getProjectVersion(projectId);
  return { project, version: version ?? await getOrCreateDefaultProjectVersion(project) };
}

export function versionIdFromRequest(req: Request) {
  try {
    return new URL(req.url).searchParams.get("versionId");
  } catch {
    return null;
  }
}

export async function assignLooseRowsToVersion(projectId: string, versionId: string) {
  const db = getDb();
  await db.update(scripts).set({ versionId }).where(and(eq(scripts.projectId, projectId), isNull(scripts.versionId)));
  await db.update(assets).set({ versionId }).where(and(eq(assets.projectId, projectId), isNull(assets.versionId)));
  await db.update(videoClips).set({ versionId }).where(and(eq(videoClips.projectId, projectId), isNull(videoClips.versionId)));
  await db.update(compositions).set({ versionId }).where(and(eq(compositions.projectId, projectId), isNull(compositions.versionId)));
}

export async function setDefaultProjectVersion(projectId: string, versionId: string) {
  const db = getDb();
  await db.update(projectVersions).set({ isDefault: false }).where(eq(projectVersions.projectId, projectId));
  const [updated] = await db
    .update(projectVersions)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId)))
    .returning();
  if (updated) {
    await db
      .update(projects)
      .set({
        currentVersionId: versionId,
        sourceType: updated.versionType === "clone" ? "clone" : "manual",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
  }
  return updated ?? null;
}

export async function createProjectVersion(
  projectId: string,
  options: {
    versionType?: ProjectVersionType;
    mode?: CreateProjectVersionMode;
    sourceVersionId?: string | null;
    name?: string | null;
  } = {}
) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("项目不存在。");

  const [{ value: maxVersionNumber } = { value: 0 }] = await db
    .select({ value: max(projectVersions.versionNumber) })
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId));
  const nextNumber = Number(maxVersionNumber || 0) + 1;
  const sourceVersion = options.sourceVersionId
    ? await getProjectVersion(projectId, options.sourceVersionId)
    : await getProjectVersion(projectId, project.currentVersionId) ?? await getProjectVersion(projectId);
  const versionType = sanitizeVersionType(options.versionType, sourceVersion?.versionType ?? defaultVersionType(project));
  const name = options.name?.trim() || `版本${nextNumber}`;
  const mode = options.mode ?? "blank";

  if (mode === "copy_full" && sourceVersion && sourceVersion.versionType !== versionType) {
    throw new Error("普通项目和爆款复刻的数据结构不同，不能跨类型复制。请新建空白版本。");
  }

  const [created] = await db
    .insert(projectVersions)
    .values({
      projectId,
      name,
      versionNumber: nextNumber,
      versionType,
      status: mode === "blank" ? "draft" : sourceVersion?.status ?? "draft",
      productAnalysis: mode === "blank" ? null : sourceVersion?.productAnalysis ?? null,
      configSnapshot: sourceVersion?.configSnapshot ?? null,
      isDefault: false,
    })
    .returning();

  if (sourceVersion && mode === "copy_full") {
    const sourceScripts = await db.select().from(scripts).where(and(eq(scripts.projectId, projectId), eq(scripts.versionId, sourceVersion.id)));
    if (sourceScripts.length > 0) {
      await db.insert(scripts).values(sourceScripts.map((item) => ({
        projectId,
        versionId: created.id,
        version: item.version,
        styleType: item.styleType,
        title: item.title,
        totalDuration: item.totalDuration,
        shots: item.shots,
        selected: item.selected,
      })));
    }

    const sourceAssets = await db.select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.versionId, sourceVersion.id)));
    if (sourceAssets.length > 0) {
      await db.insert(assets).values(sourceAssets.map((item) => ({
        projectId,
        versionId: created.id,
        shotId: item.shotId,
        type: item.type,
        filePath: item.filePath,
        thumbnailPath: item.thumbnailPath,
        provider: item.provider,
        model: item.model,
        prompt: item.prompt,
        status: item.status,
      })));
    }

    const sourceClips = await db.select().from(videoClips).where(and(eq(videoClips.projectId, projectId), eq(videoClips.versionId, sourceVersion.id)));
    if (sourceClips.length > 0) {
      await db.insert(videoClips).values(sourceClips.map((item) => ({
        projectId,
        versionId: created.id,
        shotId: item.shotId,
        assetId: null,
        filePath: item.filePath,
        duration: item.duration,
        provider: item.provider,
        model: item.model,
        transitionType: item.transitionType,
        status: item.status,
      })));
    }

    const sourceCompositions = await db.select().from(compositions).where(and(eq(compositions.projectId, projectId), eq(compositions.versionId, sourceVersion.id)));
    if (sourceCompositions.length > 0) {
      await db.insert(compositions).values(sourceCompositions.map((item) => ({
        projectId,
        versionId: created.id,
        outputPath: item.outputPath,
        resolution: item.resolution,
        aspectRatio: item.aspectRatio,
        duration: item.duration,
        bgmPath: item.bgmPath,
        ttsEnabled: item.ttsEnabled,
        subtitleStyle: item.subtitleStyle,
        status: item.status,
      })));
    }
  }

  await setDefaultProjectVersion(projectId, created.id);
  return created;
}

export async function renameProjectVersion(projectId: string, versionId: string, name: string) {
  const db = getDb();
  const cleanName = name.trim();
  if (!cleanName) throw new Error("版本名称不能为空。");
  const [updated] = await db
    .update(projectVersions)
    .set({ name: cleanName, updatedAt: new Date() })
    .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId)))
    .returning();
  return updated ?? null;
}

export async function deleteProjectVersionRecords(projectId: string, versionId: string) {
  const db = getDb();
  const versions = await listProjectVersions(projectId);
  if (versions.length <= 1) throw new Error("至少保留一个版本，不能删除最后一个版本。");
  const target = versions.find((item) => item.id === versionId);
  if (!target) throw new Error("版本不存在。");

  await db.delete(projectVersions).where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId)));
  if (target.isDefault) {
    const nextVersion = versions.find((item) => item.id !== versionId);
    if (nextVersion) await setDefaultProjectVersion(projectId, nextVersion.id);
  }
  return target;
}
