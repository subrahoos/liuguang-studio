import type { BoardVideoProfile } from "@/lib/board-video-protocol";

export type BoardVideoMediaInfo = {
  durationSeconds: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
};

export type BoardVideoOutputValidation = {
  valid: boolean;
  expected: {
    durationSeconds: number;
    aspectRatio: string;
    resolution: string;
    requiresAudio: boolean;
  };
  actual: BoardVideoMediaInfo;
  violations: string[];
};

const DURATION_TOLERANCE_SECONDS = 0.75;
const ASPECT_RATIO_TOLERANCE = 0.04;

function parseAspectRatio(value: string) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function expectedShortEdge(resolution: string) {
  const match = String(resolution || "").match(/^(\d{3,4})p$/i);
  return match ? Number(match[1]) : null;
}

/**
 * The upstream task being marked completed is not enough for the board: its
 * downloaded media must still match the requested duration, portrait/landscape
 * contract, and declared output class before it can become a usable node.
 */
export function validateBoardVideoOutput(
  profile: Pick<BoardVideoProfile, "aspectRatio" | "resolution">,
  generationSeconds: number,
  media: BoardVideoMediaInfo,
  options: { requiresAudio?: boolean } = {},
): BoardVideoOutputValidation {
  const expected = {
    durationSeconds: generationSeconds,
    aspectRatio: profile.aspectRatio,
    resolution: profile.resolution,
    requiresAudio: Boolean(options.requiresAudio),
  };
  const violations: string[] = [];
  const duration = Number(media.durationSeconds || 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    violations.push("回传文件无法读取有效视频时长。");
  } else if (Math.abs(duration - generationSeconds) > DURATION_TOLERANCE_SECONDS) {
    violations.push(`请求 ${generationSeconds} 秒，实际回传 ${duration.toFixed(2)} 秒。`);
  }

  const width = Number(media.width || 0);
  const height = Number(media.height || 0);
  const requestedRatio = parseAspectRatio(profile.aspectRatio);
  if (!(width > 0 && height > 0)) {
    violations.push("回传文件无法读取有效画面尺寸。");
  } else {
    const actualRatio = width / height;
    if (requestedRatio && Math.abs(actualRatio - requestedRatio) > ASPECT_RATIO_TOLERANCE) {
      violations.push(`请求 ${profile.aspectRatio}，实际为 ${width}×${height}。`);
    }
    const shortEdge = Math.min(width, height);
    const expectedEdge = expectedShortEdge(profile.resolution);
    if (expectedEdge && shortEdge !== expectedEdge) {
      violations.push(`请求 ${profile.resolution}，实际短边为 ${shortEdge}px。`);
    }
  }
  if (expected.requiresAudio && media.hasAudio !== true) {
    violations.push("当前任务包含口播，但回传文件没有可读取的音轨。");
  }

  return { valid: violations.length === 0, expected, actual: media, violations };
}
