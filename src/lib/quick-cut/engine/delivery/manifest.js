const fs = require("node:fs/promises");
const path = require("node:path");

async function createDeliveryFolders(outputRoot, taskName) {
  const safeName = String(taskName || "混剪任务")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim() || "混剪任务";
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const taskRoot = path.join(outputRoot, `${safeName}-${stamp}`);
  const folders = {
    root: taskRoot,
    videos: path.join(taskRoot, "videos"),
    subtitles: path.join(taskRoot, "subtitles"),
  };
  await Promise.all(
    Object.values(folders).map((folder) => fs.mkdir(folder, { recursive: true })),
  );
  return folders;
}

module.exports = {
  createDeliveryFolders,
};

