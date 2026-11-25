export type ImageSizePreset = "auto" | "720p" | "1080p" | "2k" | "4k";

export const IMAGE_SIZE_PRESET_LABELS: Record<ImageSizePreset, string> = {
  auto: "上游默认",
  "720p": "720p 快速",
  "1080p": "1080p 清晰",
  "2k": "2K 固定尺寸",
  "4k": "4K 固定尺寸",
};

export function normalizeImageSizePreset(value?: string | null, hint?: string): ImageSizePreset {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "720p" || normalized === "1080p" || normalized === "2k" || normalized === "4k") {
    return normalized;
  }
  if (normalized === "auto" || normalized === "default" || normalized === "upstream") return "auto";
  if (/\b4k\b/i.test(hint || "")) return "4k";
  if (/\b2k\b/i.test(hint || "")) return "2k";
  return "auto";
}

export function imageDimensionsForPreset(
  aspectRatio: string,
  preset?: string | null
): { width: number; height: number } | null {
  const normalized = normalizeImageSizePreset(preset);
  if (normalized === "auto") return null;

  const table: Record<Exclude<ImageSizePreset, "auto">, Record<string, { width: number; height: number }>> = {
    "720p": {
      "9:16": { width: 720, height: 1280 },
      "16:9": { width: 1280, height: 720 },
      "1:1": { width: 1024, height: 1024 },
      "3:4": { width: 960, height: 1280 },
    },
    "1080p": {
      "9:16": { width: 1080, height: 1920 },
      "16:9": { width: 1920, height: 1080 },
      "1:1": { width: 1536, height: 1536 },
      "3:4": { width: 1440, height: 1920 },
    },
    "2k": {
      "9:16": { width: 1440, height: 2560 },
      "16:9": { width: 2560, height: 1440 },
      "1:1": { width: 1440, height: 1440 },
      "3:4": { width: 1440, height: 1920 },
    },
    "4k": {
      "9:16": { width: 2160, height: 3840 },
      "16:9": { width: 3840, height: 2160 },
      "1:1": { width: 2160, height: 2160 },
      "3:4": { width: 2160, height: 2880 },
    },
  };

  return table[normalized][aspectRatio] || table[normalized]["9:16"];
}

export function aspectRatioFromDimensions(width?: number, height?: number): "3:4" | "9:16" | "16:9" | "1:1" | undefined {
  if (!width || !height) return undefined;
  if (width === height) return "1:1";
  if (width * 4 === height * 3) return "3:4";
  return height > width ? "9:16" : "16:9";
}
