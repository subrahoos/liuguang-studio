import { localRuntimeRoot } from "@/lib/runtime-tools";
import { existsSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { storagePaths } from "@/lib/storage-root";

let cachedRuntime: unknown;

export function quickCutRuntimeRoot() {
  const bundled = path.join(localRuntimeRoot(), "quick-cut", "runtime");
  return existsSync(bundled) ? bundled : storagePaths.quickCut("runtime");
}

export function quickCutRuntimePaths() {
  const runtime = quickCutRuntimeRoot();
  const ffmpegRoot = path.join(runtime, "ffmpeg");
  const metadataWatermarkRoot = path.join(runtime, "metadata-watermark");
  const sourceAssets = path.join(process.cwd(), "runtime-assets");
  const sourceScript = (name: string, fallback: string) => {
    const candidate = path.join(sourceAssets, name);
    return existsSync(candidate) ? candidate : fallback;
  };
  return {
    runtime,
    ffmpeg: path.join(ffmpegRoot, "ffmpeg.exe"),
    ffprobe: path.join(ffmpegRoot, "ffprobe.exe"),
    whisper: path.join(runtime, "whisper", "whisper-cli.exe"),
    whisperModel: path.join(runtime, "whisper", "ggml-small-q5_1.bin"),
    faceModel: path.join(runtime, "face", "face_detection_yunet_2023mar.onnx"),
    personModel: path.join(runtime, "face", "person_detection_mediapipe_2023mar.onnx"),
    metadataWatermarkPython: path.join(metadataWatermarkRoot, "python", "Scripts", "python.exe"),
    metadataWatermarkProcessor: sourceScript("metadata_watermark_processor.py", path.join(metadataWatermarkRoot, "processor", "metadata_watermark_processor.py")),
    qualityOptimizeProfileProcessor: sourceScript("quality_optimize_profile.py", path.join(metadataWatermarkRoot, "processor", "quality_optimize_profile.py")),
    metadataWatermarkFfmpeg: path.join(metadataWatermarkRoot, "ffmpeg", "ffmpeg.exe"),
    metadataWatermarkFfprobe: path.join(metadataWatermarkRoot, "ffmpeg", "ffprobe.exe"),
    metadataWatermarkKey: existsSync(path.join(metadataWatermarkRoot, "watermark.key"))
      ? path.join(metadataWatermarkRoot, "watermark.key") : storagePaths.system("metadata-watermark.key"),
    fashionVisionRoot: path.join(runtime, "fashion-vision"),
    fashionVisionPython: path.join(runtime, "fashion-vision", "python", "Scripts", "python.exe"),
    fashionVisionScript: sourceScript(process.env.LUMA_QUICK_CUT_VISION_PROFILE === "baseline" ? "fashion_vision_baseline.py" : "fashion_vision_analyzer.py", path.join(runtime, "fashion-vision", "fashion_vision_analyzer.py")),
    fashionVisionModelRoot: path.join(runtime, "fashion-vision", "models"),
  };
}

export function loadQuickCutOnnxRuntime() {
  if (cachedRuntime) return cachedRuntime;
  const runtime = quickCutRuntimeRoot();
  const packageFile = path.join(runtime, "node_modules", "onnxruntime-node", "package.json");
  if (!existsSync(packageFile)) {
    throw new Error("流光快剪的人物检测运行库缺失，请重新迁移本地运行资源。");
  }
  const runtimeRequire = createRequire(path.join(runtime, "runtime-loader.cjs"));
  cachedRuntime = runtimeRequire("onnxruntime-node");
  return cachedRuntime;
}
