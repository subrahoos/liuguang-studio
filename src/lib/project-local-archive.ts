import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { basename, join } from "path";
import { eq } from "drizzle-orm";
import { ADMIN_USER_ID } from "@/lib/auth-constants";
import { getDb } from "@/lib/db";
import { projectVersions, projects } from "@/lib/db/schema";
import { getOrCreateDefaultProjectVersion, getProjectVersion } from "@/lib/project-versions";
import { storagePaths } from "@/lib/storage-root";

export type ArchiveKind = "assets" | "videos" | "compositions";

export type ArchiveProjectInfo = {
  id: string;
  ownerId?: string | null;
  name?: string | null;
  productName?: string | null;
  versionId?: string | null;
  versionName?: string | null;
  versionNumber?: number | null;
};

export type WriteProjectFileOptions = {
  versionId?: string | null;
};

const CN = {
  productLibrary: "\u5546\u54c1\u5e93",
  project: "\u9879\u76ee",
  version: "\u7248\u672c",
  infoFile: "\u9879\u76ee\u7248\u672c\u4fe1\u606f.txt",
  sourceInfoFile: "\u6765\u6e90\u7248\u672c\u4fe1\u606f.txt",
  assets: "\u8d44\u4ea7\u56fe",
  videos: "\u89c6\u9891\u7247\u6bb5",
  compositions: "\u6210\u7247",
  cloneSuffix: "\u9ad8\u76f8\u4f3c\u590d\u523b",
  hotCloneSuffix: "\u7206\u6b3e\u590d\u523b",
  normalSuffix: "\u666e\u901a\u9879\u76ee",
};

export const LOCAL_PROJECT_ARCHIVE_ROOT =
  storagePaths.projects();

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function isProductLibraryId(projectId: string) {
  return projectId === "product-library" || projectId.startsWith("product-library-");
}

function cleanText(value?: string | null, fallback = "") {
  const cleaned = (value ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function stripWorkflowSuffix(value: string) {
  let result = value.trim();
  for (const suffix of [CN.cloneSuffix, CN.hotCloneSuffix, CN.normalSuffix]) {
    if (result.endsWith(suffix)) {
      result = result.slice(0, -suffix.length).trim();
    }
  }
  return result;
}

function projectFolderName(project: ArchiveProjectInfo) {
  if (isProductLibraryId(project.id)) return CN.productLibrary;

  const fromProduct = cleanText(project.productName);
  if (fromProduct) return stripWorkflowSuffix(fromProduct);

  const fromName = cleanText(project.name);
  if (fromName) return stripWorkflowSuffix(fromName);

  return `${CN.project}_${safeId(project.id)}`;
}

function legacyProjectRootCandidates(project: ArchiveProjectInfo) {
  const names = [
    projectFolderName(project),
    cleanText(project.name),
    stripWorkflowSuffix(cleanText(project.name)),
    cleanText(project.productName),
    stripWorkflowSuffix(cleanText(project.productName)),
    `${CN.project}_${safeId(project.id)}`,
  ].filter(Boolean);

  return Array.from(new Set(names)).map((name) => join(LOCAL_PROJECT_ARCHIVE_ROOT, name));
}

function versionFolderName(project: ArchiveProjectInfo) {
  if (isProductLibraryId(project.id)) return "";
  if (project.versionNumber && Number.isFinite(project.versionNumber)) return `${CN.version}${project.versionNumber}`;
  return cleanText(project.versionName, `${CN.version}1`);
}

export function projectArchivePaths(project: ArchiveProjectInfo | string) {
  const info = typeof project === "string" ? { id: project } : project;
  const ownerSegment = isProductLibraryId(info.id)
    ? safeId(info.ownerId || "shared-product-library")
    : safeId(info.ownerId || "luma-admin");
  const projectSegment = isProductLibraryId(info.id)
    ? projectFolderName(info)
    : `${projectFolderName(info)}_${safeId(info.id).slice(0, 12)}`;
  const root = join(LOCAL_PROJECT_ARCHIVE_ROOT, ownerSegment, projectSegment);
  const versionDir = isProductLibraryId(info.id) ? root : join(root, versionFolderName(info));

  return {
    root,
    versionDir,
    assetsDir: versionDir,
    videosDir: versionDir,
    compositionsDir: versionDir,
    infoFile: join(versionDir, CN.infoFile),
  };
}

export async function getArchiveProjectInfo(projectId: string, versionId?: string | null): Promise<ArchiveProjectInfo> {
  if (isProductLibraryId(projectId)) {
    const ownerId = projectId === "product-library" ? "luma-admin" : projectId.slice("product-library-".length);
    return { id: projectId, name: CN.productLibrary, ownerId };
  }

  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (project) {
      const version =
        (versionId ? await getProjectVersion(project.id, versionId) : null)
        ?? await getProjectVersion(project.id, project.currentVersionId)
        ?? await getOrCreateDefaultProjectVersion(project);

      return {
        id: project.id,
        ownerId: project.ownerId,
        name: project.name,
        productName: project.productName,
        versionId: version?.id ?? null,
        versionName: version?.name ?? null,
        versionNumber: version?.versionNumber ?? 1,
      };
    }
  } catch {
    // Temporary IDs and legacy paths can still be served without DB access.
  }

  return { id: projectId, versionId, ownerId: "luma-admin" };
}

export async function ensureProjectArchive(project: ArchiveProjectInfo) {
  const paths = projectArchivePaths(project);
  await mkdir(paths.versionDir, { recursive: true });

  const info = [
    `${CN.project}ID: ${project.id}`,
    `${CN.project}\u540d\u79f0: ${cleanText(project.name) || "-"}`,
    `\u5546\u54c1\u540d\u79f0: ${cleanText(project.productName) || "-"}`,
    `${CN.version}ID: ${project.versionId || "-"}`,
    `${CN.version}\u540d\u79f0: ${cleanText(project.versionName) || "-"}`,
    `${CN.project}\u6839\u76ee\u5f55: ${paths.root}`,
    `\u5f53\u524d${CN.version}\u76ee\u5f55: ${paths.versionDir}`,
    "\u8bf4\u660e: \u9875\u9762\u9884\u89c8\u3001\u4e0b\u8f7d\u548c\u751f\u6210\u7ed3\u679c\u90fd\u8bfb\u53d6\u8fd9\u4e00\u4efd\u7248\u672c\u76ee\u5f55\u6587\u4ef6\u3002",
  ].join("\r\n");

  await writeFile(paths.infoFile, info, "utf8");
  return paths;
}

export async function ensureProjectArchiveById(projectId: string, versionId?: string | null) {
  const project = await getArchiveProjectInfo(projectId, versionId);
  return ensureProjectArchive(project);
}

function legacyDir(projectId: string, kind: ArchiveKind) {
  return storagePaths.projects("_legacy", kind, projectId);
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function versionSearchDirs(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return [];

  const versions = await db
    .select()
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId));

  const ordered = versions.sort((a, b) => {
    if (a.id === project.currentVersionId) return -1;
    if (b.id === project.currentVersionId) return 1;
    if (a.isDefault && !b.isDefault) return -1;
    if (b.isDefault && !a.isDefault) return 1;
    return a.versionNumber - b.versionNumber;
  });

  return ordered.map((version) => projectArchivePaths({
    id: project.id,
    ownerId: project.ownerId,
    name: project.name,
    productName: project.productName,
    versionId: version.id,
    versionName: version.name,
    versionNumber: version.versionNumber,
  }).versionDir);
}

export async function writeProjectFile(
  project: ArchiveProjectInfo | string,
  _kind: ArchiveKind,
  fileName: string,
  bytes: Buffer,
  options: WriteProjectFileOptions = {}
) {
  const info = typeof project === "string" || (options.versionId && options.versionId !== project.versionId)
    ? await getArchiveProjectInfo(typeof project === "string" ? project : project.id, options.versionId)
    : project;
  const paths = await ensureProjectArchive(info);
  const safeFileName = basename(fileName);
  const filePath = join(paths.versionDir, safeFileName);
  await writeFile(filePath, bytes);
  return filePath;
}

export async function copyProjectFileFromLocal(
  project: ArchiveProjectInfo | string,
  kind: ArchiveKind,
  fileName: string,
  sourcePath: string,
  options: WriteProjectFileOptions = {}
) {
  const bytes = await readFile(sourcePath);
  return writeProjectFile(project, kind, fileName, bytes, options);
}

export async function resolveStoredProjectFile(
  projectId: string,
  kind: ArchiveKind,
  fileName: string,
  versionId?: string | null
) {
  const safeFileName = basename(decodeURIComponent(fileName));
  const project = await getArchiveProjectInfo(projectId, versionId);
  const primary = join(projectArchivePaths(project).versionDir, safeFileName);
  if (await exists(primary)) return primary;

  for (const dir of await versionSearchDirs(projectId)) {
    const candidate = join(dir, safeFileName);
    if (await exists(candidate)) return candidate;
  }

  for (const root of legacyProjectRootCandidates(project)) {
    const direct = join(root, safeFileName);
    if (await exists(direct)) return direct;

    for (const versionName of [versionFolderName(project), `${CN.version}1`]) {
      const versionCandidate = join(root, versionName, safeFileName);
      if (await exists(versionCandidate)) return versionCandidate;
    }

    for (const oldSubdir of [CN.assets, CN.videos, CN.compositions]) {
      const legacyArchive = join(root, oldSubdir, safeFileName);
      if (await exists(legacyArchive)) return legacyArchive;
    }
  }

  const legacy = join(legacyDir(projectId, kind), safeFileName);
  if (existsSync(legacy)) return legacy;
  return primary;
}

export async function resolveOwnedStoredProjectFile(
  ownerId: string,
  projectId: string,
  kind: ArchiveKind,
  fileName: string,
  versionId?: string | null,
) {
  if (!ownerId || !projectId) return null;
  if (projectId === "product-library") {
    if (ownerId !== ADMIN_USER_ID) return null;
  } else if (projectId.startsWith("product-library-")) {
    if (projectId !== `product-library-${ownerId}`) return null;
  } else {
    const [project] = await getDb().select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project || project.ownerId !== ownerId) return null;
  }
  return resolveStoredProjectFile(projectId, kind, fileName, versionId).catch(() => null);
}

export async function countExistingProjectFiles(
  projectId: string,
  kind: ArchiveKind,
  publicPaths: Array<string | null | undefined>,
  versionId?: string | null
) {
  let count = 0;
  for (const publicPath of publicPaths) {
    const filePath = await resolvePublicProjectFilePath(projectId, publicPath, kind, versionId);
    if (filePath && await exists(filePath)) count += 1;
  }
  return count;
}

export async function resolvePublicProjectFilePath(
  projectId: string,
  publicPath?: string | null,
  expectedKind?: ArchiveKind,
  versionId?: string | null
) {
  if (!publicPath) return null;

  const assetMatch = publicPath.match(/^\/api\/files\/([^/]+)\/([^?#]+)/);
  if (assetMatch && assetMatch[1] === projectId && (!expectedKind || expectedKind === "assets")) {
    return resolveStoredProjectFile(projectId, "assets", assetMatch[2], versionId);
  }

  const videoMatch = publicPath.match(/^\/api\/project\/([^/]+)\/video-clips\/file\/([^?#]+)/);
  if (videoMatch && videoMatch[1] === projectId && (!expectedKind || expectedKind === "videos")) {
    return resolveStoredProjectFile(projectId, "videos", videoMatch[2], versionId);
  }

  const compositionMatch = publicPath.match(/^\/api\/project\/([^/]+)\/compositions\/file\/([^?#]+)/);
  if (compositionMatch && compositionMatch[1] === projectId && (!expectedKind || expectedKind === "compositions")) {
    return resolveStoredProjectFile(projectId, "compositions", compositionMatch[2], versionId);
  }

  return null;
}

export function publicProjectFileToLocalPath(projectId: string, publicPath?: string | null) {
  if (!publicPath) return null;
  const fileName = publicPath.split("/").pop();
  if (!fileName) return null;
  return join(LOCAL_PROJECT_ARCHIVE_ROOT, `${CN.project}_${safeId(projectId)}`, basename(decodeURIComponent(fileName)));
}

export async function archiveLocalFile(
  project: ArchiveProjectInfo,
  sourcePath: string,
  kind: ArchiveKind,
  fileName?: string
) {
  if (!sourcePath || !(await exists(sourcePath))) return null;
  return copyProjectFileFromLocal(project, kind, fileName || basename(sourcePath), sourcePath, { versionId: project.versionId });
}

export async function archivePublicProjectFile(
  project: ArchiveProjectInfo,
  publicPath: string | null | undefined,
  kind: ArchiveKind,
  fileName?: string
) {
  const sourcePath = await resolvePublicProjectFilePath(project.id, publicPath, kind, project.versionId);
  if (!sourcePath || !(await exists(sourcePath))) return null;
  if (fileName && basename(sourcePath) !== basename(fileName)) {
    return copyProjectFileFromLocal(project, kind, fileName, sourcePath, { versionId: project.versionId });
  }
  return sourcePath;
}

export async function deleteProjectVersionFolder(projectId: string, versionId: string) {
  const project = await getArchiveProjectInfo(projectId, versionId);
  const paths = projectArchivePaths(project);
  await rm(paths.versionDir, { recursive: true, force: true });
}

export async function copyProjectVersionFolder(projectId: string, sourceVersionId: string, targetVersionId: string) {
  const source = projectArchivePaths(await getArchiveProjectInfo(projectId, sourceVersionId)).versionDir;
  const target = projectArchivePaths(await getArchiveProjectInfo(projectId, targetVersionId)).versionDir;
  const targetInfo = await getArchiveProjectInfo(projectId, targetVersionId);
  if (!(await exists(source))) {
    await ensureProjectArchive(targetInfo);
    return;
  }

  await mkdir(target, { recursive: true });
  async function copyDir(from: string, to: string) {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (entry.isDirectory()) {
        await copyDir(sourcePath, targetPath);
      } else {
        await copyFile(sourcePath, targetPath);
      }
    }
  }

  await copyDir(source, target);
  await copyFile(join(source, CN.infoFile), join(target, CN.sourceInfoFile)).catch(() => null);
  await ensureProjectArchive(targetInfo);
}
