import { existsSync } from "fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { basename, extname, join, resolve } from "path";
import { ADMIN_USER_ID } from "@/lib/auth-constants";
import { identityPerformanceBaselineText, identityPhysicalLockText } from "@/lib/identity-performance";
import { storagePaths } from "@/lib/storage-root";
import { legacyIdentityReferenceRoot } from "@/lib/runtime-tools";

export type IdentityReferenceStatus = "draft" | "approved" | "archived";
export type IdentityReferenceGroup = "source" | "base" | "camera" | "expression";
export type IdentityAuxiliaryAssetKind = "expression_sheet" | "base_multiview_sheet" | "camera_pose_sheet" | "custom_sheet";
export type IdentityAuxiliaryAssetLayout = "portrait" | "full_body" | "mixed";

export interface IdentityGenerationTiming {
  upstreamProcessingMs?: number;
  resultTransferMs?: number;
  localSaveMs?: number;
  totalMs?: number;
  responseBodyBytes?: number;
}

export interface IdentityReference {
  id: string;
  title: string;
  role: string;
  url: string;
  requiredFor: string[];
  generated?: boolean;
  createdAt?: string;
  sourceKind?: string;
  group: IdentityReferenceGroup;
  status: IdentityReferenceStatus;
  aspectRatio?: "3:4" | "9:16";
  generationTiming?: IdentityGenerationTiming;
}

export interface IdentityAuxiliaryAssetPanel {
  referenceId: string;
  title: string;
  role: string;
  group: IdentityReferenceGroup;
  sourceKind?: string;
  label: string;
  order: number;
}

export interface IdentityAuxiliaryAsset {
  id: string;
  title: string;
  role: string;
  url: string;
  kind: IdentityAuxiliaryAssetKind;
  layout: IdentityAuxiliaryAssetLayout;
  panels: IdentityAuxiliaryAssetPanel[];
  createdAt: string;
  updatedAt: string;
}

export interface IdentityPack {
  id: string;
  packName: string;
  description: string;
  identityLock: string;
  identityPerformanceBaseline: string;
  references: IdentityReference[];
  auxiliaryAssets: IdentityAuxiliaryAsset[];
  sourceReferenceId: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

export interface IdentityLibrary {
  packs: IdentityPack[];
}

export interface IdentityPendingResult {
  id: string;
  packId: string;
  kind: string;
  title: string;
  role: string;
  sourceKind: string;
  group: IdentityReferenceGroup;
  aspectRatio: "3:4" | "9:16";
  requiredFor: string[];
  taskId?: string;
  modelId?: string;
  transport: "b64_json" | "url";
  payload: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  generationTiming?: IdentityGenerationTiming;
}

export type IdentityPendingResultSummary = Omit<IdentityPendingResult, "payload">;

export const defaultMainIdentityReferenceId = "main-model-v2";

export const identityLockText = identityPhysicalLockText;

const identityRoot = () => storagePaths.identityPack();
const legacyGeneratedDir = () => join(identityRoot(), "generated");
const legacyGeneratedFile = () => join(identityRoot(), "generated-references.json");

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 96) || "identity";
}

function safeFileNamePart(value: string, fallback: string) {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

export function identityImageTimestamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}.${parts.minute}`;
}

export function identityImageTitleFromFileName(fileName: string) {
  return basename(fileName, extname(fileName));
}

function identityImageBaseName(ownerName: string, imageTitle: string, createdAt: Date) {
  return `${safeFileNamePart(ownerName, "用户")}${safeFileNamePart(imageTitle, "人物参考图")}${identityImageTimestamp(createdAt)}`;
}

function ownerDir(ownerId: string) {
  return join(identityRoot(), safeSegment(ownerId));
}

function libraryFile(ownerId: string) {
  return join(ownerDir(ownerId), "identity-packs.json");
}

export function generatedImageDir(ownerId?: string) {
  return ownerId ? join(ownerDir(ownerId), "images") : legacyGeneratedDir();
}

function pendingIdentityResultDir(ownerId: string) {
  return join(ownerDir(ownerId), "pending-results");
}

function pendingIdentityResultFile(ownerId: string, pendingId: string) {
  const root = resolve(pendingIdentityResultDir(ownerId));
  const target = resolve(join(root, `${safeSegment(pendingId)}.json`));
  if (!target.startsWith(root)) throw new Error("无效的人物包待处理结果路径。");
  return target;
}

export function summarizeIdentityPendingResult(result: IdentityPendingResult): IdentityPendingResultSummary {
  const summary = { ...result } as Partial<IdentityPendingResult>;
  delete summary.payload;
  return summary as IdentityPendingResultSummary;
}

export async function saveIdentityPendingResult(input: Omit<IdentityPendingResult, "id" | "createdAt" | "updatedAt" | "payload"> & { ownerId: string; payload: string }) {
  const now = new Date().toISOString();
  const { ownerId, ...pendingInput } = input;
  const result: IdentityPendingResult = {
    ...pendingInput,
    id: `identity-pending-${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(pendingIdentityResultDir(ownerId), { recursive: true });
  await writeFile(pendingIdentityResultFile(ownerId, result.id), JSON.stringify(result), "utf8");
  return result;
}

export async function getIdentityPendingResult(ownerId: string, pendingId: string) {
  const file = pendingIdentityResultFile(ownerId, pendingId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as IdentityPendingResult;
    return parsed?.id === pendingId && parsed?.packId ? parsed : null;
  } catch {
    return null;
  }
}

export async function getIdentityPendingResults(ownerId: string, packId?: string | null) {
  const dir = pendingIdentityResultDir(ownerId);
  if (!existsSync(dir)) return [] as IdentityPendingResultSummary[];
  const names = await readdir(dir);
  const results: IdentityPendingResultSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as IdentityPendingResult;
      if (!parsed?.id || !parsed.packId || (packId && parsed.packId !== packId)) continue;
      results.push(summarizeIdentityPendingResult(parsed));
    } catch {
      // Ignore an incomplete result file; it must not make the identity library unavailable.
    }
  }
  return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updateIdentityPendingResult(ownerId: string, pendingId: string, patch: Pick<IdentityPendingResult, "lastError" | "generationTiming">) {
  const current = await getIdentityPendingResult(ownerId, pendingId);
  if (!current) throw new Error("待处理生图结果不存在或已完成。");
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeFile(pendingIdentityResultFile(ownerId, pendingId), JSON.stringify(next), "utf8");
  return next;
}

export async function deleteIdentityPendingResult(ownerId: string, pendingId: string) {
  await unlink(pendingIdentityResultFile(ownerId, pendingId)).catch(() => undefined);
}

async function deleteIdentityPendingResultsForPack(ownerId: string, packId: string) {
  const dir = pendingIdentityResultDir(ownerId);
  if (!existsSync(dir)) return;
  const names = await readdir(dir);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const file = join(dir, name);
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<IdentityPendingResult>;
      if (parsed.packId === packId) await unlink(file).catch(() => undefined);
    } catch {
      // Leave malformed files for manual inspection rather than deleting unrelated data.
    }
  }
}

export function identityImageFilePath(ownerId: string, fileName: string) {
  const root = resolve(generatedImageDir(ownerId));
  const target = resolve(join(root, basename(fileName)));
  if (!target.startsWith(root)) throw new Error("无效的人物包图片路径。");
  return target;
}

export function isIdentityPackFileUrl(url?: string) {
  return /^\/api\/identity-pack\/file\//.test(String(url || ""));
}

export function identityFileNameFromUrl(url?: string) {
  const matched = String(url || "").match(/^\/api\/identity-pack\/file\/([^/?#]+)/);
  return matched ? basename(decodeURIComponent(matched[1])) : null;
}

export function identityFileUrl(fileName: string) {
  return `/api/identity-pack/file/${encodeURIComponent(basename(fileName))}`;
}

export async function nextIdentityImageFileName(
  ownerId: string,
  ownerName: string,
  imageTitle: string,
  extension = ".png",
  createdAt = new Date()
) {
  const normalizedExtension = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  const root = generatedImageDir(ownerId);
  await mkdir(root, { recursive: true });

  const base = identityImageBaseName(ownerName, imageTitle, createdAt);
  let sequence = 1;
  while (true) {
    const suffix = sequence === 1 ? "" : `-${String(sequence).padStart(2, "0")}`;
    const fileName = `${base}${suffix}${normalizedExtension}`;
    if (!existsSync(identityImageFilePath(ownerId, fileName))) return fileName;
    sequence += 1;
  }
}

export function resolveIdentityImageFile(ownerId: string, url: string) {
  const fileName = identityFileNameFromUrl(url);
  if (!fileName) return null;
  const ownerFile = identityImageFilePath(ownerId, fileName);
  if (existsSync(ownerFile)) return ownerFile;
  if (ownerId === ADMIN_USER_ID) {
    const legacyFile = resolve(join(legacyGeneratedDir(), fileName));
    if (legacyFile.startsWith(resolve(legacyGeneratedDir())) && existsSync(legacyFile)) return legacyFile;
  }
  return null;
}

const legacyDefaultReferences: IdentityReference[] = [
  {
    id: "main-model-v2",
    title: "主模特身份图",
    role: "人物身份来源：锁定脸型、身材、肤色、发型、体态和整体气质。",
    url: "/api/model-identity/main-model-v2.png",
    requiredFor: ["人物身份来源", "白底定型组"],
    group: "source",
    status: "approved",
    aspectRatio: "3:4",
  },
  {
    id: "five-angles-v1",
    title: "历史五视角校准",
    role: "旧版多角度人物参考，保留供人工选择；不会再自动带入项目。",
    url: "/api/model-identity/five-angles-v1.png",
    requiredFor: ["手动参考"],
    group: "base",
    status: "approved",
    aspectRatio: "3:4",
  },
  {
    id: "pitch-angle-v1",
    title: "历史镜头适配校准",
    role: "旧版俯仰角人物参考，保留供人工选择；不会再自动带入项目。",
    url: "/api/model-identity/pitch-angle-v1.png",
    requiredFor: ["手动参考"],
    group: "camera",
    status: "approved",
    aspectRatio: "3:4",
  },
  {
    id: "expression-mouth-v1",
    title: "历史表情动作校准（旧版）",
    role: "旧版表情参考，保留供人工选择；新版表情口型组仅生成静态面部校准图。",
    url: "/api/model-identity/expression-mouth-v1.png",
    requiredFor: ["手动参考"],
    group: "expression",
    status: "approved",
    aspectRatio: "3:4",
  },
];

function toReference(item: Partial<IdentityReference> & Pick<IdentityReference, "id" | "title" | "role" | "url">): IdentityReference {
  return {
    id: String(item.id),
    title: String(item.title),
    role: String(item.role),
    url: String(item.url),
    requiredFor: Array.isArray(item.requiredFor) ? item.requiredFor.map(String) : ["手动人物参考"],
    generated: Boolean(item.generated),
    createdAt: item.createdAt || new Date().toISOString(),
    sourceKind: item.sourceKind,
    group: item.group === "source" || item.group === "base" || item.group === "camera" || item.group === "expression"
      ? item.group
      : "base",
    status: item.status === "draft" || item.status === "archived" || item.status === "approved"
      ? item.status
      : "approved",
    aspectRatio: item.aspectRatio === "9:16" ? "9:16" : "3:4",
    generationTiming: normalizeIdentityGenerationTiming(item.generationTiming),
  };
}

function toAuxiliaryAsset(item: Partial<IdentityAuxiliaryAsset> & Pick<IdentityAuxiliaryAsset, "id" | "title" | "role" | "url">): IdentityAuxiliaryAsset {
  const kind = item.kind === "expression_sheet" || item.kind === "base_multiview_sheet" || item.kind === "camera_pose_sheet" || item.kind === "custom_sheet"
    ? item.kind
    : "custom_sheet";
  const layout = item.layout === "portrait" || item.layout === "full_body" || item.layout === "mixed"
    ? item.layout
    : "mixed";
  const panels = Array.isArray(item.panels)
    ? item.panels
      .filter((panel): panel is IdentityAuxiliaryAssetPanel => Boolean(panel?.referenceId && panel?.title))
      .slice(0, 6)
      .map((panel, index) => ({
        referenceId: String(panel.referenceId),
        title: String(panel.title),
        role: String(panel.role || "人物身份辅助参考"),
        group: panel.group === "source" || panel.group === "base" || panel.group === "camera" || panel.group === "expression"
          ? panel.group
          : "base",
        sourceKind: panel.sourceKind ? String(panel.sourceKind) : undefined,
        label: String(panel.label || `${String(index + 1).padStart(2, "0")} ${panel.title}`).slice(0, 64),
        order: index + 1,
      }))
    : [];
  const createdAt = item.createdAt || new Date().toISOString();
  return {
    id: String(item.id),
    title: String(item.title),
    role: String(item.role || "由已验收人物图本地合成的辅助参考资产。"),
    url: String(item.url),
    kind,
    layout,
    panels,
    createdAt,
    updatedAt: item.updatedAt || createdAt,
  };
}

function normalizeIdentityGenerationTiming(value: unknown): IdentityGenerationTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const number = (key: keyof IdentityGenerationTiming) => {
    const candidate = source[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? Math.round(candidate)
      : undefined;
  };
  const timing: IdentityGenerationTiming = {
    upstreamProcessingMs: number("upstreamProcessingMs"),
    resultTransferMs: number("resultTransferMs"),
    localSaveMs: number("localSaveMs"),
    totalMs: number("totalMs"),
    responseBodyBytes: number("responseBodyBytes"),
  };
  return Object.values(timing).some((item) => item !== undefined) ? timing : undefined;
}

function createLegacyPack(generated: IdentityReference[] = []): IdentityPack {
  const now = new Date().toISOString();
  return {
    id: "legacy-main-model",
    packName: "主模特人物包",
    description: "由现有主模特身份图迁移而来。新生成的白底定型、镜头适配和表情口型图会先进入待验收状态，只有通过的图片才可手动调用。",
    identityLock: identityLockText,
    identityPerformanceBaseline: identityPerformanceBaselineText,
    references: [...legacyDefaultReferences, ...generated],
    auxiliaryAssets: [],
    sourceReferenceId: defaultMainIdentityReferenceId,
    createdAt: now,
    updatedAt: now,
  };
}

async function readLegacyGeneratedReferences(): Promise<IdentityReference[]> {
  if (!existsSync(legacyGeneratedFile())) return [];
  try {
    const parsed = JSON.parse(await readFile(legacyGeneratedFile(), "utf8")) as Array<Partial<IdentityReference>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.id && item.title && item.url)
      .map((item) => toReference({
        ...item,
        id: String(item.id),
        title: String(item.title),
        role: typeof item.role === "string" && item.role.trim() ? item.role : "历史人物参考图。",
        url: String(item.url),
        group: item.group || "base",
        status: item.status || "approved",
      }));
  } catch {
    return [];
  }
}

async function writeIdentityLibrary(ownerId: string, library: IdentityLibrary) {
  await mkdir(ownerDir(ownerId), { recursive: true });
  await writeFile(libraryFile(ownerId), JSON.stringify(library, null, 2), "utf8");
}

export async function getIdentityLibrary(ownerId: string): Promise<IdentityLibrary> {
  const file = libraryFile(ownerId);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<IdentityLibrary>;
      if (Array.isArray(parsed.packs)) {
        return {
          packs: parsed.packs
            .filter((pack): pack is IdentityPack => Boolean(pack?.id && pack?.packName))
            .map((pack) => ({
              ...pack,
              identityLock: pack.identityLock || identityLockText,
              identityPerformanceBaseline: pack.identityPerformanceBaseline || identityPerformanceBaselineText,
              sourceReferenceId: pack.sourceReferenceId || pack.references?.find((reference) => reference.group === "source")?.id || "",
              references: Array.isArray(pack.references) ? pack.references.map(toReference) : [],
              auxiliaryAssets: Array.isArray(pack.auxiliaryAssets) ? pack.auxiliaryAssets
                .filter((asset): asset is IdentityAuxiliaryAsset => Boolean(asset?.id && asset?.title && asset?.url))
                .map(toAuxiliaryAsset)
                : [],
              createdAt: pack.createdAt || new Date().toISOString(),
              updatedAt: pack.updatedAt || new Date().toISOString(),
            })),
        };
      }
    } catch {
      // Fall through to a safe fresh library instead of making the account unusable.
    }
  }

  const legacyReferences = ownerId === ADMIN_USER_ID ? await readLegacyGeneratedReferences() : [];
  const hasLegacySource = existsSync(join(legacyIdentityReferenceRoot(), "白底棚拍运动服模特-参考脸型身材-4K-v2.png"));
  const library: IdentityLibrary = {
    packs: ownerId === ADMIN_USER_ID && (hasLegacySource || legacyReferences.length > 0) ? [createLegacyPack(legacyReferences)] : [],
  };
  await writeIdentityLibrary(ownerId, library);
  return library;
}

export async function getIdentityPack(ownerId: string, packId?: string | null): Promise<IdentityPack | null> {
  const library = await getIdentityLibrary(ownerId);
  const visible = library.packs.filter((pack) => !pack.archived);
  if (packId) return visible.find((pack) => pack.id === packId) ?? null;
  return visible[0] ?? null;
}

export async function createIdentityPack(input: {
  ownerId: string;
  packName: string;
  source: Omit<IdentityReference, "id" | "group" | "status" | "requiredFor"> & { id?: string; requiredFor?: string[] };
}) {
  const library = await getIdentityLibrary(input.ownerId);
  const now = new Date().toISOString();
  const packId = `identity-pack-${crypto.randomUUID()}`;
  const source: IdentityReference = toReference({
    ...input.source,
    id: input.source.id || `identity-source-${crypto.randomUUID()}`,
    title: input.source.title || "人物身份来源图",
    role: input.source.role || "该人物包的唯一身份来源图。",
    requiredFor: input.source.requiredFor || ["人物身份来源", "白底定型组"],
    group: "source",
    status: "approved",
    generated: false,
    createdAt: now,
    aspectRatio: "3:4",
  });
  const pack: IdentityPack = {
    id: packId,
    packName: input.packName.trim() || "未命名人物包",
    description: "人物来源图与通过验收的白底校准图。后续项目只会使用你手动勾选的图片。",
    identityLock: identityLockText,
    identityPerformanceBaseline: identityPerformanceBaselineText,
    references: [source],
    auxiliaryAssets: [],
    sourceReferenceId: source.id,
    createdAt: now,
    updatedAt: now,
  };
  library.packs = [pack, ...library.packs];
  await writeIdentityLibrary(input.ownerId, library);
  return { library, pack };
}

export async function deleteIdentityPack(ownerId: string, packId: string, confirmed: boolean) {
  const library = await getIdentityLibrary(ownerId);
  const pack = library.packs.find((item) => item.id === packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已删除。");
  if (!confirmed) throw new Error("请在确认弹窗中确认后再彻底删除人物包。");

  const ownedFileNames = Array.from(new Set(
    [...pack.references.map((reference) => reference.url), ...pack.auxiliaryAssets.map((asset) => asset.url)]
      .map((url) => identityFileNameFromUrl(url))
      .filter((fileName): fileName is string => Boolean(fileName))
  ));

  let deletedFileCount = 0;
  for (const fileName of ownedFileNames) {
    const file = identityImageFilePath(ownerId, fileName);
    if (!existsSync(file)) continue;
    await unlink(file);
    deletedFileCount += 1;
  }

  library.packs = library.packs.filter((item) => item.id !== pack.id);
  await deleteIdentityPendingResultsForPack(ownerId, pack.id);
  await writeIdentityLibrary(ownerId, library);
  return { library, deletedPackName: pack.packName, deletedFileCount };
}

export async function deleteIdentityReference(ownerId: string, packId: string, referenceId: string, confirmed: boolean) {
  const library = await getIdentityLibrary(ownerId);
  const pack = library.packs.find((item) => item.id === packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已删除。");
  const reference = pack.references.find((item) => item.id === referenceId);
  if (!reference) throw new Error("人物图片不存在或已删除。");
  if (reference.group === "source" || reference.id === pack.sourceReferenceId) {
    throw new Error("人物脸部来源图不能单独删除，请使用删除人物包。");
  }
  if (!confirmed) throw new Error("请在确认弹窗中确认后再彻底删除图片。");

  const fileName = identityFileNameFromUrl(reference.url);
  let deletedFileCount = 0;
  if (fileName) {
    const file = identityImageFilePath(ownerId, fileName);
    if (existsSync(file)) {
      await unlink(file);
      deletedFileCount = 1;
    }
  }

  pack.references = pack.references.filter((item) => item.id !== reference.id);
  pack.updatedAt = new Date().toISOString();
  await writeIdentityLibrary(ownerId, library);
  return { library, pack, deletedReferenceTitle: reference.title, deletedFileCount };
}

export async function addIdentityAuxiliaryAsset(input: {
  ownerId: string;
  packId: string;
  asset: Omit<IdentityAuxiliaryAsset, "id" | "createdAt" | "updatedAt">;
}) {
  const library = await getIdentityLibrary(input.ownerId);
  const pack = library.packs.find((item) => item.id === input.packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已归档。");
  const now = new Date().toISOString();
  const asset = toAuxiliaryAsset({
    ...input.asset,
    id: `identity-auxiliary-${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  });
  pack.auxiliaryAssets = [asset, ...pack.auxiliaryAssets].slice(0, 48);
  pack.updatedAt = now;
  await writeIdentityLibrary(input.ownerId, library);
  return { library, pack, asset };
}

export async function deleteIdentityAuxiliaryAsset(ownerId: string, packId: string, assetId: string, confirmed: boolean) {
  const library = await getIdentityLibrary(ownerId);
  const pack = library.packs.find((item) => item.id === packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已归档。");
  const asset = pack.auxiliaryAssets.find((item) => item.id === assetId);
  if (!asset) throw new Error("辅助资产不存在或已删除。");
  if (!confirmed) throw new Error("请在确认弹窗中确认后再彻底删除辅助资产。");

  const fileName = identityFileNameFromUrl(asset.url);
  let deletedFileCount = 0;
  if (fileName) {
    const file = identityImageFilePath(ownerId, fileName);
    if (existsSync(file)) {
      await unlink(file);
      deletedFileCount = 1;
    }
  }

  pack.auxiliaryAssets = pack.auxiliaryAssets.filter((item) => item.id !== asset.id);
  pack.updatedAt = new Date().toISOString();
  await writeIdentityLibrary(ownerId, library);
  return { library, pack, deletedAssetTitle: asset.title, deletedFileCount };
}

export async function renameIdentityPack(ownerId: string, packId: string, packName: string) {
  const library = await getIdentityLibrary(ownerId);
  const pack = library.packs.find((item) => item.id === packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已归档。");
  const nextName = packName.trim().slice(0, 48);
  if (!nextName) throw new Error("请输入人物包名称。");
  pack.packName = nextName;
  pack.updatedAt = new Date().toISOString();
  await writeIdentityLibrary(ownerId, library);
  return { library, pack };
}

export async function addGeneratedIdentityReference(input: {
  ownerId: string;
  packId: string;
  reference: Omit<IdentityReference, "id" | "generated" | "createdAt" | "status"> & { id?: string; status?: IdentityReferenceStatus };
}) {
  const library = await getIdentityLibrary(input.ownerId);
  const pack = library.packs.find((item) => item.id === input.packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已归档。");
  const nextReference = toReference({
    ...input.reference,
    id: input.reference.id || `identity-reference-${crypto.randomUUID()}`,
    generated: true,
    createdAt: new Date().toISOString(),
    status: input.reference.status || "draft",
  });
  pack.references = [nextReference, ...pack.references.filter((item) => item.id !== nextReference.id)].slice(0, 96);
  pack.updatedAt = new Date().toISOString();
  await writeIdentityLibrary(input.ownerId, library);
  return { library, pack, reference: nextReference };
}

export async function finalizeIdentityPendingResult(input: {
  ownerId: string;
  ownerName?: string;
  pendingId: string;
  image: { bytes: Buffer; ext: string };
  generationTiming?: IdentityGenerationTiming;
  localSaveStartedAt?: number;
  requestStartedAt?: number;
}) {
  const pending = await getIdentityPendingResult(input.ownerId, input.pendingId);
  if (!pending) throw new Error("待处理生图结果不存在或已完成。");
  const pack = await getIdentityPack(input.ownerId, pending.packId);
  if (!pack) throw new Error("待处理结果对应的人物包不存在或已删除。");

  await mkdir(generatedImageDir(input.ownerId), { recursive: true });
  const extension = input.image.ext.startsWith(".") ? input.image.ext : `.${input.image.ext}`;
  const createdAt = new Date(pending.createdAt);
  const fileName = await nextIdentityImageFileName(
    input.ownerId,
    input.ownerName || input.ownerId,
    pending.title,
    extension,
    Number.isNaN(createdAt.getTime()) ? new Date() : createdAt
  );
  await writeFile(identityImageFilePath(input.ownerId, fileName), input.image.bytes);
  const generationTiming = input.generationTiming ? {
    ...input.generationTiming,
    localSaveMs: input.localSaveStartedAt === undefined
      ? input.generationTiming.localSaveMs
      : Math.max(0, Date.now() - input.localSaveStartedAt),
    totalMs: input.requestStartedAt === undefined
      ? input.generationTiming.totalMs
      : Math.max(0, Date.now() - input.requestStartedAt),
  } : pending.generationTiming;
  const result = await addGeneratedIdentityReference({
    ownerId: input.ownerId,
    packId: pending.packId,
    reference: {
      id: `identity-${pending.kind}-${Date.now()}`,
      title: identityImageTitleFromFileName(fileName),
      role: `${pending.role}；生成后等待人工验收。`,
      url: identityFileUrl(fileName),
      requiredFor: pending.requiredFor,
      sourceKind: pending.sourceKind,
      group: pending.group,
      aspectRatio: pending.aspectRatio,
      generationTiming,
      status: "draft",
    },
  });
  await deleteIdentityPendingResult(input.ownerId, pending.id);
  return { ...result, fileName, pending };
}

export async function setIdentityReferenceStatus(input: {
  ownerId: string;
  packId: string;
  referenceId: string;
  status: IdentityReferenceStatus;
}) {
  const library = await getIdentityLibrary(input.ownerId);
  const pack = library.packs.find((item) => item.id === input.packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已归档。");
  const reference = pack.references.find((item) => item.id === input.referenceId);
  if (!reference) throw new Error("人物参考图不存在。");
  if (reference.group === "source" && input.status !== "approved") {
    throw new Error("人物身份来源图不能取消通过状态。");
  }
  reference.status = input.status;
  pack.updatedAt = new Date().toISOString();
  await writeIdentityLibrary(input.ownerId, library);
  return { library, pack, reference };
}

export async function saveIdentitySourceImage(ownerId: string, ownerName: string, originalFileName: string, bytes: Buffer) {
  const cleanName = await nextIdentityImageFileName(ownerId, ownerName, "人物脸部来源图", extname(originalFileName).toLowerCase() || ".png");
  await writeFile(identityImageFilePath(ownerId, cleanName), bytes);
  return { fileName: cleanName, url: identityFileUrl(cleanName) };
}

const identityReferenceTargetTitles: Record<string, string> = {
  face_front: "人脸正面定型图",
  full_body_front: "全身正面比例图",
  full_body_left_45: "全身左侧45度图",
  full_body_right_45: "全身右侧45度图",
  full_body_side: "全身侧面比例图",
  full_body_back: "全身背面比例图",
  camera_eye_level: "平视半身校准图",
  camera_high_angle: "轻俯视半身校准图",
  camera_low_angle: "轻仰视全身校准图",
  // Keep legacy sourceKind values so historical generated records remain readable.
  expression_neutral: "亲和开场表情图",
  expression_smile: "热情分享表情图",
  expression_bright_smile: "专注讲解表情图",
  expression_turn_back: "卖点强调表情图",
  expression_gesture: "互动疑问表情图",
  expression_walk: "惊喜反应表情图",
};

function identityReferenceTargetTitle(reference: IdentityReference) {
  if (reference.group === "source") return "人物脸部来源图";
  // A generated reference title is the filename stem after migration. Never feed
  // that value back into the next filename, otherwise every page load appends it again.
  return identityReferenceTargetTitles[reference.sourceKind || ""] || null;
}

function identityFileStemMatchesBase(stem: string, base: string) {
  return stem === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}-\\d{2}$`).test(stem);
}

export async function migrateIdentityImageFileNames(ownerId: string, ownerName: string) {
  const library = await getIdentityLibrary(ownerId);
  const imageDir = generatedImageDir(ownerId);
  if (!existsSync(imageDir)) return library;

  const existingNames = new Set((await readdir(imageDir)).filter((name) => name.toLowerCase().endsWith(".png") || name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg") || name.toLowerCase().endsWith(".webp")));
  let changed = false;

  for (const pack of library.packs) {
    for (const reference of pack.references) {
      const currentName = identityFileNameFromUrl(reference.url);
      if (!currentName) continue;
      const currentFile = identityImageFilePath(ownerId, currentName);
      if (!existsSync(currentFile)) continue;

      const createdAt = new Date(reference.createdAt || pack.createdAt);
      const stableCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
      const targetTitle = identityReferenceTargetTitle(reference);
      if (!targetTitle) continue;

      const extension = extname(currentName).toLowerCase() || ".png";
      const base = identityImageBaseName(ownerName, targetTitle, stableCreatedAt);
      let targetName = currentName;

      if (!identityFileStemMatchesBase(identityImageTitleFromFileName(currentName), base)) {
        let sequence = 1;
        while (true) {
          const suffix = sequence === 1 ? "" : `-${String(sequence).padStart(2, "0")}`;
          const candidate = `${base}${suffix}${extension}`;
          if (!existingNames.has(candidate) || candidate === currentName) {
            targetName = candidate;
            break;
          }
          sequence += 1;
        }
      }

      if (targetName !== currentName) {
        await rename(currentFile, identityImageFilePath(ownerId, targetName));
        existingNames.delete(currentName);
        existingNames.add(targetName);
        reference.url = identityFileUrl(targetName);
        changed = true;
      }

      const displayTitle = identityImageTitleFromFileName(targetName);
      if (reference.title !== displayTitle) {
        reference.title = displayTitle;
        changed = true;
      }
    }
  }

  if (changed) {
    const now = new Date().toISOString();
    for (const pack of library.packs) {
      if (pack.references.some((reference) => identityFileNameFromUrl(reference.url))) pack.updatedAt = now;
    }
    await writeIdentityLibrary(ownerId, library);
  }
  return library;
}

export async function resetIdentityCalibrationReferences(ownerId: string, packId: string) {
  const library = await getIdentityLibrary(ownerId);
  const pack = library.packs.find((item) => item.id === packId && !item.archived);
  if (!pack) throw new Error("人物包不存在或已归档。");
  pack.references = pack.references.map((reference) => (
    reference.group === "source" ? reference : { ...reference, status: "archived" as const }
  ));
  pack.updatedAt = new Date().toISOString();
  await writeIdentityLibrary(ownerId, library);
  return { library, pack };
}
