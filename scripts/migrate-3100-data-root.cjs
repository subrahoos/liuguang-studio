/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * One-time migration from project-local data to the 3100 runtime root.
 * It never touches D:\\AI or D:\\AZiDongHua legacy workspaces.
 *
 *   node scripts/migrate-3100-data-root.cjs --dry-run
 *   node scripts/migrate-3100-data-root.cjs --execute
 *   node scripts/migrate-3100-data-root.cjs --cleanup
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const SOURCE_ROOT = path.resolve("D:\\AIzidoghua\\daihuo-jianshou\\data");
const TARGET_ROOT = path.resolve(process.env.LUMA_DATA_ROOT || "D:\\3100");
const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const cleanup = args.has("--cleanup");
const dryRun = !execute && !cleanup || args.has("--dry-run");

if (cleanup && execute) throw new Error("Run --execute first, then run --cleanup separately.");

function fail(message) {
  throw new Error(`3100 data migration: ${message}`);
}

function isInside(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function assertInside(candidate, root, label) {
  if (!isInside(candidate, root)) fail(`${label} is outside its allowed root: ${candidate}`);
  return path.resolve(candidate);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function safeSegment(value, fallback) {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return text || fallback;
}

function boardFolderName(board) {
  const id = String(board.id || "");
  if (!/^[A-Za-z0-9_-]{8,}$/.test(id)) fail(`invalid board id in registry: ${id || "(empty)"}`);
  return `${safeSegment(board.name, "board")}_${id.slice(0, 8)}`;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function collectFiles(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile()) {
        const info = await fsp.stat(filePath);
        results.push({ filePath, size: info.size });
      } else fail(`unsupported filesystem entry: ${filePath}`);
    }
  }
  await walk(root);
  return results;
}

async function copyTree(source, target, records, options = {}) {
  if (!fs.existsSync(source)) return;
  assertInside(source, SOURCE_ROOT, "source path");
  assertInside(target, TARGET_ROOT, "target path");
  const files = await collectFiles(source);
  for (const { filePath, size } of files) {
    const destination = path.join(target, path.relative(source, filePath));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(filePath, destination, fs.constants.COPYFILE_EXCL);
    const sourceHash = await hashFile(filePath);
    const targetHash = await hashFile(destination);
    if (sourceHash !== targetHash) fail(`hash mismatch after copy: ${filePath}`);
    records.push({ source: filePath, target: destination, size, sha256: sourceHash, mutable: Boolean(options.mutable) });
  }
}

function replaceRootPaths(value, sourceRoot, targetRoot) {
  if (typeof value === "string") return value.includes(sourceRoot) ? value.split(sourceRoot).join(targetRoot) : value;
  if (Array.isArray(value)) return value.map((item) => replaceRootPaths(item, sourceRoot, targetRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRootPaths(item, sourceRoot, targetRoot)]));
  }
  return value;
}

function checkpointDatabase(databasePath) {
  const db = new Database(databasePath);
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") fail(`source SQLite integrity_check failed: ${integrity}`);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function rewriteDatabasePaths(databasePath, pathMappings) {
  const db = new Database(databasePath);
  let changed = 0;
  try {
    db.pragma("journal_mode = DELETE");
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("copied SQLite integrity_check failed");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    db.transaction(() => {
      for (const row of tables) {
        const table = String(row.name);
        const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
        for (const column of columns) {
          const type = String(column.type || "").toUpperCase();
          if (type && !type.includes("TEXT") && !type.includes("CHAR") && !type.includes("CLOB")) continue;
          const name = String(column.name);
          for (const [sourcePath, targetPath] of pathMappings) {
            const result = db.prepare(
              `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(name)} = REPLACE(${quoteIdentifier(name)}, ?, ?) WHERE instr(${quoteIdentifier(name)}, ?) > 0`
            ).run(sourcePath, targetPath, sourcePath);
            changed += result.changes;
          }
        }
      }
    })();
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("migrated SQLite integrity_check failed");
  } finally {
    db.close();
  }
  return changed;
}

async function readBoardRegistry() {
  const sourceRegistry = path.join(SOURCE_ROOT, "board-workflows", "workflows.json");
  if (!fs.existsSync(sourceRegistry)) return [];
  const parsed = JSON.parse(await fsp.readFile(sourceRegistry, "utf8"));
  if (!Array.isArray(parsed)) fail("board registry is not an array");
  return parsed;
}

async function migrateBoards(records, transformed) {
  const boards = await readBoardRegistry();
  const sourceBoardRoot = path.join(SOURCE_ROOT, "board-workflows");
  const targetRegistry = path.join(TARGET_ROOT, "system", "board-workflows.json");
  const migrated = [];
  const pathMappings = [];
  for (const board of boards) {
    const fallback = path.join(sourceBoardRoot, String(board.id));
    const declared = typeof board.localDir === "string" ? path.resolve(board.localDir) : fallback;
    const sourceDir = isInside(declared, sourceBoardRoot) ? declared : fallback;
    if (!fs.existsSync(sourceDir)) fail(`board asset directory not found: ${sourceDir}`);
    const targetDir = path.join(TARGET_ROOT, "boards", boardFolderName(board));
    await copyTree(sourceDir, targetDir, records);
    const next = replaceRootPaths(board, sourceDir, targetDir);
    next.localDir = targetDir;
    delete next.archiveDir;
    migrated.push(next);
    pathMappings.push([sourceDir, targetDir]);
  }
  await fsp.mkdir(path.dirname(targetRegistry), { recursive: true });
  await fsp.writeFile(targetRegistry, JSON.stringify(migrated, null, 2), "utf8");
  if (JSON.stringify(migrated).includes(SOURCE_ROOT)) fail("old board path remained after registry rewrite");
  transformed.push({ source: path.join(sourceBoardRoot, "workflows.json"), target: targetRegistry, kind: "board-registry", boardCount: migrated.length });
  return { boardCount: migrated.length, pathMappings };
}

const directoryMappings = [
  ["analytics-imports", ["imports"]],
  ["clone-analysis", ["clone", "analysis"]],
  ["clone-methods", ["clone", "methods"]],
  ["clone-plan", ["clone", "plans"]],
  ["home-backgrounds", ["backgrounds"]],
  ["identity-pack", ["identity-pack"]],
  ["manual-method-analysis", ["diagnostics", "manual-method-analysis"]],
  ["review", ["diagnostics", "review"]],
  ["system", ["diagnostics", "legacy-project-system"]],
  ["tmp", ["tmp"]],
  ["uploads", ["projects", "_legacy", "assets"]],
  ["videos", ["projects", "_legacy", "videos"]],
  ["whisper-cache", ["cache", "whisper"]],
];

async function copyMappedDirectories(records) {
  for (const [sourceName, targetParts] of directoryMappings) {
    await copyTree(path.join(SOURCE_ROOT, sourceName), path.join(TARGET_ROOT, ...targetParts), records);
  }
}

async function assertKnownSourceEntries() {
  const names = await fsp.readdir(SOURCE_ROOT);
  const knownDirectories = new Set(["board-workflows", ...directoryMappings.map(([name]) => name)]);
  const emptyDirectoriesCreatedByPreMigrationBuild = new Set([
    "backgrounds", "boards", "cache", "clone", "diagnostics", "imports", "projects",
  ]);
  const unknown = names.filter((name) => {
    if (knownDirectories.has(name)) return false;
    if (emptyDirectoriesCreatedByPreMigrationBuild.has(name)) return false;
    if (["sqlite.db", "sqlite.db-wal", "sqlite.db-shm"].includes(name)) return false;
    return !/^server-3100\..+\.log$/i.test(name);
  });
  if (unknown.length) fail(`unmapped source entries must be classified before migration: ${unknown.join(", ")}`);
  for (const name of emptyDirectoriesCreatedByPreMigrationBuild) {
    const files = await collectFiles(path.join(SOURCE_ROOT, name));
    if (files.length) fail(`pre-migration build directory unexpectedly contains data: ${name}`);
  }
}

async function copyLegacyLogs(records) {
  const names = await fsp.readdir(SOURCE_ROOT);
  for (const name of names.filter((value) => /^server-3100\..+\.log$/i.test(value))) {
    const source = path.join(SOURCE_ROOT, name);
    const target = path.join(TARGET_ROOT, "system", "legacy-logs", name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    const sourceHash = await hashFile(source);
    if (sourceHash !== await hashFile(target)) fail(`hash mismatch after log copy: ${source}`);
    const info = await fsp.stat(source);
    records.push({ source, target, size: info.size, sha256: sourceHash, mutable: false });
  }
}

async function copyDatabase(records, transformed, pathMappings) {
  const source = path.join(SOURCE_ROOT, "sqlite.db");
  if (!fs.existsSync(source)) fail(`SQLite database not found: ${source}`);
  checkpointDatabase(source);
  const target = path.join(TARGET_ROOT, "system", "sqlite.db");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const sourceHash = await hashFile(source);
  if (sourceHash !== await hashFile(target)) fail("SQLite hash mismatch after copy");
  const info = await fsp.stat(source);
  records.push({ source, target, size: info.size, sha256: sourceHash, mutable: true });
  transformed.push({ source, target, kind: "sqlite-path-rewrite", changedRows: rewriteDatabasePaths(target, pathMappings) });
}

async function verifyRecords(records) {
  let verifiedFiles = 0;
  let verifiedBytes = 0;
  for (const record of records) {
    if (!fs.existsSync(record.target)) fail(`missing target file: ${record.target}`);
    const info = await fsp.stat(record.target);
    if (!record.mutable && info.size !== record.size) fail(`size mismatch: ${record.target}`);
    if (!record.mutable && (await hashFile(record.target)) !== record.sha256) fail(`hash mismatch: ${record.target}`);
    verifiedFiles += 1;
    verifiedBytes += record.size;
  }
  const db = new Database(path.join(TARGET_ROOT, "system", "sqlite.db"), { readonly: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("final SQLite integrity_check failed");
  } finally {
    db.close();
  }
  return { verifiedFiles, verifiedBytes };
}

async function writeManifest(manifest) {
  const migrations = path.join(TARGET_ROOT, "system", "migrations");
  await fsp.mkdir(migrations, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = path.join(migrations, `migration-${stamp}.json`);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

function latestManifestPath() {
  const directory = path.join(TARGET_ROOT, "system", "migrations");
  if (!fs.existsSync(directory)) fail("no migration manifest exists under the target root");
  const candidates = fs.readdirSync(directory)
    .filter((name) => /^migration-.+\.json$/i.test(name))
    .map((name) => path.join(directory, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) fail("no migration manifest exists under the target root");
  return candidates[0];
}

async function cleanupSource() {
  const manifestPath = latestManifestPath();
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.sourceRoot !== SOURCE_ROOT || manifest.targetRoot !== TARGET_ROOT || !manifest.verification?.verifiedFiles) {
    fail("latest manifest is not a verified migration for these roots");
  }
  assertInside(SOURCE_ROOT, "D:\\AIzidoghua\\daihuo-jianshou", "cleanup source");
  if (fs.existsSync(SOURCE_ROOT)) {
    await fsp.rm(SOURCE_ROOT, { recursive: true, force: true });
    console.log(`Removed verified old 3100 data directory: ${SOURCE_ROOT}`);
  } else {
    console.log("Old project-local data directory is already absent.");
  }
  manifest.cleanup = { sourceRemoved: true, removedAt: new Date().toISOString() };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

async function runMigration() {
  if (!fs.existsSync(SOURCE_ROOT)) fail(`source root does not exist: ${SOURCE_ROOT}`);
  if (fs.existsSync(TARGET_ROOT)) fail(`target root already exists: ${TARGET_ROOT}. Refusing to overwrite it.`);
  await assertKnownSourceEntries();
  const sourceFiles = await collectFiles(SOURCE_ROOT);
  const sourceBytes = sourceFiles.reduce((sum, file) => sum + file.size, 0);
  console.log(`Planned migration: ${sourceFiles.length} files, ${sourceBytes} bytes`);
  console.log(`  from ${SOURCE_ROOT}`);
  console.log(`  to   ${TARGET_ROOT}`);
  if (dryRun) return console.log("Dry run only. No file was created, moved, or deleted.");

  const records = [];
  const transformed = [];
  await fsp.mkdir(TARGET_ROOT, { recursive: true });
  try {
    const boardResult = await migrateBoards(records, transformed);
    await copyMappedDirectories(records);
    await copyLegacyLogs(records);
    const pathMappings = [
      ...boardResult.pathMappings,
      ...directoryMappings.map(([sourceName, targetParts]) => [path.join(SOURCE_ROOT, sourceName), path.join(TARGET_ROOT, ...targetParts)]),
      ["data/analytics-imports", path.join(TARGET_ROOT, "imports")],
      ["data\\analytics-imports", path.join(TARGET_ROOT, "imports")],
      [SOURCE_ROOT, TARGET_ROOT],
    ];
    await copyDatabase(records, transformed, pathMappings);
    const verification = await verifyRecords(records);
    const manifestPath = await writeManifest({
      version: 1,
      createdAt: new Date().toISOString(),
      sourceRoot: SOURCE_ROOT,
      targetRoot: TARGET_ROOT,
      source: { files: sourceFiles.length, bytes: sourceBytes },
      excludedRecreatableSourceFiles: ["sqlite.db-wal", "sqlite.db-shm"],
      boardCount: boardResult.boardCount,
      copied: { files: records.length, bytes: records.reduce((sum, record) => sum + record.size, 0) },
      verification,
      transformed,
      records,
      cleanup: { sourceRemoved: false },
    });
    console.log(`Migration verified: ${verification.verifiedFiles} copied files.`);
    console.log(`Manifest: ${manifestPath}`);
    console.log("Old project-local data remains untouched. Run --cleanup after inspection to remove only that verified source data.");
  } catch (error) {
    console.error(`Migration failed. Source remains untouched. Partial target: ${TARGET_ROOT}`);
    throw error;
  }
}

(async () => {
  if (cleanup) await cleanupSource();
  else await runMigration();
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
