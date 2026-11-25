import { existsSync } from "fs";
import { mkdir, readdir, rm, stat, unlink } from "fs/promises";
import path from "path";

/**
 * All user data produced by the local 3100 service lives below this root.
 * Source code, node_modules and build output must never be used as media
 * storage.  Tests can override the root with LUMA_DATA_ROOT.
 */
const configuredRoot = process.env.LUMA_DATA_ROOT?.trim();
export const LUMA_DATA_ROOT = path.resolve(configuredRoot || path.join(process.cwd(), "data"));

export const storagePaths = {
  root: () => LUMA_DATA_ROOT,
  system: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "system", ...parts),
  boards: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "boards", ...parts),
  projects: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "projects", ...parts),
  identityPack: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "identity-pack", ...parts),
  backgrounds: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "backgrounds", ...parts),
  imports: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "imports", ...parts),
  cache: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "cache", ...parts),
  tmp: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "tmp", ...parts),
  diagnostics: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "diagnostics", ...parts),
  clone: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "clone", ...parts),
  review: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "review", ...parts),
  quickCut: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "quick-cut", ...parts),
  productProduction: (...parts: string[]) => path.join(LUMA_DATA_ROOT, "product-production", ...parts),
};

export async function ensureStorageLayout() {
  await Promise.all([
    storagePaths.system(),
    storagePaths.boards(),
    storagePaths.projects(),
    storagePaths.identityPack(),
    storagePaths.backgrounds(),
    storagePaths.imports(),
    storagePaths.cache(),
    storagePaths.tmp(),
    storagePaths.diagnostics(),
    storagePaths.clone(),
    storagePaths.review(),
    storagePaths.quickCut(),
    storagePaths.productProduction(),
  ].map((directory) => mkdir(directory, { recursive: true })));
}

export function isPathInsideRoot(candidate: string, root = LUMA_DATA_ROOT) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function relativePathInsideRoot(candidate: string, root: string) {
  const resolved = path.resolve(candidate);
  if (!isPathInsideRoot(resolved, root)) throw new Error("Storage path is outside its allowed root.");
  return path.relative(root, resolved).replace(/\\/g, "/");
}

export function resolveSafeRelativePath(root: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid storage relative path.");
  }
  const target = path.resolve(root, normalized);
  if (!isPathInsideRoot(target, root)) throw new Error("Storage path is outside its allowed root.");
  return target;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TEMP_RETENTION_MS = DAY_MS;
const DIAGNOSTIC_RETENTION_MS = 30 * DAY_MS;
let maintenanceStarted = false;

async function removeExpiredEntries(root: string, cutoff: number) {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    const info = await stat(target).catch(() => null);
    if (!info) return;
    if (entry.isDirectory()) {
      if (info.mtimeMs < cutoff) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      await removeExpiredEntries(target, cutoff);
      const remaining = await readdir(target).catch(() => []);
      if (remaining.length === 0) await rm(target, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    if (info.mtimeMs < cutoff) await unlink(target).catch(() => undefined);
  }));
}

export async function runStorageMaintenance(now = Date.now()) {
  await ensureStorageLayout();
  await removeExpiredEntries(storagePaths.tmp(), now - TEMP_RETENTION_MS);
  await removeExpiredEntries(storagePaths.diagnostics(), now - DIAGNOSTIC_RETENTION_MS);
  if (existsSync(storagePaths.boards())) {
    const boardDirectories = await readdir(storagePaths.boards(), { withFileTypes: true });
    await Promise.all(boardDirectories
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        removeExpiredEntries(path.join(storagePaths.boards(), entry.name, "gpt-debug"), now - DIAGNOSTIC_RETENTION_MS),
        removeExpiredEntries(path.join(storagePaths.boards(), entry.name, "diagnostics"), now - DIAGNOSTIC_RETENTION_MS),
        removeExpiredEntries(path.join(storagePaths.boards(), entry.name, "pending-image-results"), now - DIAGNOSTIC_RETENTION_MS),
      ]));
  }
}

export function scheduleStorageMaintenance() {
  if (maintenanceStarted || process.env.NODE_ENV === "test") return;
  maintenanceStarted = true;
  void runStorageMaintenance().catch(() => undefined);
  const timer = setInterval(() => void runStorageMaintenance().catch(() => undefined), DAY_MS);
  timer.unref?.();
}
