const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// 女装视觉结果现已包含真实姿态证据与模型参与摘要，旧缓存不可复用。
const ANALYSIS_CACHE_VERSION = 12;

function analysisCacheKey(files) {
  const canonical = files
    .map((file) => [
      path.resolve(file.path).toLowerCase(),
      Number(file.size) || 0,
      Number(file.mtimeMs) || 0,
    ].join("|"))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function loadAnalysisCache(filePath, expectedKey) {
  try {
    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (
      stored.version !== ANALYSIS_CACHE_VERSION
      || stored.key !== expectedKey
    ) return null;
    return stored.data;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeAnalysisCache(filePath, key, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  const stored = {
    version: ANALYSIS_CACHE_VERSION,
    key,
    createdAt: new Date().toISOString(),
    data,
  };
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(stored, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

module.exports = {
  ANALYSIS_CACHE_VERSION,
  analysisCacheKey,
  loadAnalysisCache,
  writeAnalysisCache,
};
