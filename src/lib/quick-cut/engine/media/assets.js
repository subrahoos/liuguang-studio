const fs = require("node:fs/promises");
const path = require("node:path");

const EXTENSIONS = {
  video: new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]),
  image: new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]),
  audio: new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]),
};

async function listAssets(folder, type) {
  if (!folder) return [];
  const supported = EXTENSIONS[type];
  if (!supported) throw new Error("素材类型无效");
  const result = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile()
        && supported.has(path.extname(entry.name).toLowerCase())
      ) {
        result.push(fullPath);
      }
    }
  }

  await walk(folder);
  return result;
}

module.exports = { listAssets };
