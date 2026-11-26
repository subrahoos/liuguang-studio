import { existsSync } from "fs";
import path from "path";
import { storagePaths } from "@/lib/storage-root";

/** Runtime binaries are shipped with the repository's Windows release. */
export function localRuntimeRoot() {
  return path.resolve(process.env.LUMA_RUNTIME_ROOT?.trim() || path.join(process.cwd(), ".runtime"));
}

export function mediaExecutable(name: "ffmpeg" | "ffprobe") {
  const configured = process.env[name === "ffmpeg" ? "LUMA_FFMPEG_PATH" : "LUMA_FFPROBE_PATH"]?.trim();
  if (configured) return configured;
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    path.join(localRuntimeRoot(), "tools", "ffmpeg", executable),
    path.join(localRuntimeRoot(), "quick-cut", "runtime", "ffmpeg", executable),
    path.join("D:\\Tools\\ffmpeg\\bin", executable),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || name;
}

export function transcriptionPython() {
  return process.env.LUMA_ASR_PYTHON?.trim() || process.env.CODEX_PYTHON_PATH?.trim() ||
    [path.join(localRuntimeRoot(), "asr", "python", "Scripts", "python.exe"),
      path.join(process.cwd(), ".venv", "Scripts", "python.exe")].find((candidate) => existsSync(candidate)) || "python";
}

export function transcriptionModel() {
  const bundled = path.join(localRuntimeRoot(), "asr", "models", "small");
  return process.env.WHISPER_MODEL?.trim() || (existsSync(path.join(bundled, "model.bin")) ? bundled : "small");
}

export function chineseFontFile() {
  return [process.env.LUMA_CHINESE_FONT_PATH?.trim(),
    path.join(process.cwd(), "runtime-assets", "fonts", "NotoSansSC.ttf"),
    path.join(process.env.SystemRoot || "C:\\Windows", "Fonts", "msyh.ttc"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) || "";
}

export function legacyIdentityReferenceRoot() {
  const configured = process.env.MODEL_IDENTITY_PACK_DIR?.trim();
  if (configured) return configured;
  const legacy = "C:\\Users\\应钟\\Documents\\Obsidian Vault\\50_资源\\模特身份参考包";
  const originalInstallation = path.resolve(storagePaths.root()).toLowerCase() === path.resolve("D:\\3100").toLowerCase();
  return originalInstallation && existsSync(legacy) ? legacy : storagePaths.identityPack("legacy-references");
}
