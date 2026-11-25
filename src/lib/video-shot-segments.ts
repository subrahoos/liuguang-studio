import { getBoardVideoProfile, GROK_BOARD_VIDEO_MODEL } from "@/lib/board-video-protocol";
import { VIDEO_DIRECTOR_SCHEMA_VERSION } from "@/lib/video-director-contract";

export const BOARD_VIDEO_MODEL = GROK_BOARD_VIDEO_MODEL;
export const BOARD_VIDEO_ASPECT_RATIO = "9:16";
export const BOARD_VIDEO_RESOLUTION = "720p";
export const BOARD_VIDEO_GENERATION_SECONDS = 10;
export const BOARD_VIDEO_MAX_TARGET_SECONDS = 120;

export type VideoShotSegmentPlan = {
  index: number;
  /** Start time in the generated / delivered timeline. */
  start: number;
  /** Start time in the reference-evidence timeline. This can differ from `start` when a task boundary is moved to a shot cut. */
  sourceStart: number;
  /** Upstream model generation length. */
  duration: number;
  /** Length of the reference-video evidence covered by this task. */
  sourceDuration: number;
  sourceTimeRange: string;
  /** Full task output is always kept. It is never trimmed to sourceDuration. */
  outputDuration: number;
  outputTimeRange: string;
  /** Selected reference or manually-entered evidence duration. */
  requestedTotal: number;
  /** Sum of every full generated task that will be delivered. */
  plannedOutputDuration: number;
};

type CurrentDirector = {
  id?: string;
  meta?: Record<string, unknown>;
} | null | undefined;

export function normalizedBoardVideoTargetDuration(value: number) {
  const rounded = Math.round(Number(value) || BOARD_VIDEO_GENERATION_SECONDS);
  return Math.min(BOARD_VIDEO_MAX_TARGET_SECONDS, Math.max(1, rounded));
}

export function formatVideoTime(seconds: number) {
  const safe = Math.round(Math.max(0, Number(seconds) || 0) * 1000) / 1000;
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  const secondText = Number.isInteger(remainder)
    ? String(remainder).padStart(2, "0")
    : remainder.toFixed(3).replace(/0+$/, "").padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${secondText}`;
}

function normalizedCutTimes(cutTimes: number[] | undefined, requestedTotal: number) {
  return [...new Set((cutTimes || [])
    .map(Number)
    .filter((time) => Number.isFinite(time) && time > 0 && time < requestedTotal)
    .map((time) => Math.round(time * 1000) / 1000))]
    .sort((left, right) => left - right);
}

/**
 * Pack reference evidence into full model tasks without beginning a new task
 * halfway through a reference shot when an earlier hard cut fits inside the
 * task. A short spare tail belongs to the outgoing shot's end-state hold;
 * the next independent task starts at the next shot's actual entry state.
 */
export function splitTargetDurationIntoVideoSegments(
  totalDuration: number,
  generationSeconds = BOARD_VIDEO_GENERATION_SECONDS,
  sceneCutTimes?: number[],
  sourceEvidenceDuration?: number,
): VideoShotSegmentPlan[] {
  const requestedTotal = normalizedBoardVideoTargetDuration(totalDuration);
  const taskDuration = Math.max(1, Math.round(Number(generationSeconds) || BOARD_VIDEO_GENERATION_SECONDS));
  const availableEvidence = Number(sourceEvidenceDuration);
  const sourceTotal = Number.isFinite(availableEvidence) && availableEvidence > 0
    ? Math.min(requestedTotal, Math.round(availableEvidence * 1000) / 1000)
    : requestedTotal;
  const cuts = normalizedCutTimes(sceneCutTimes, sourceTotal);
  const sourceWindows: Array<{ start: number; end: number }> = [];
  let sourceStart = 0;

  while (sourceStart < sourceTotal - 0.001) {
    const maxEnd = Math.min(sourceTotal, sourceStart + taskDuration);
    const cutInsideTask = cuts.filter((cut) => cut > sourceStart + 0.001 && cut <= maxEnd + 0.001).at(-1);
    const sourceEnd = cutInsideTask ?? maxEnd;
    sourceWindows.push({ start: sourceStart, end: sourceEnd });
    sourceStart = sourceEnd;
  }

  const plannedOutputDuration = sourceWindows.length * taskDuration;
  return sourceWindows.map((window, offset) => {
    const start = offset * taskDuration;
    const sourceDuration = Math.round((window.end - window.start) * 1000) / 1000;
    return {
      index: offset + 1,
      start,
      sourceStart: window.start,
      duration: taskDuration,
      sourceDuration,
      sourceTimeRange: `${formatVideoTime(window.start)}-${formatVideoTime(window.end)}`,
      outputDuration: taskDuration,
      outputTimeRange: `${formatVideoTime(start)}-${formatVideoTime(start + taskDuration)}`,
      requestedTotal,
      plannedOutputDuration,
    };
  });
}

export function readStoredVideoShotSegmentPlan(
  value: unknown,
  generationSeconds: number,
): VideoShotSegmentPlan[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const taskDuration = Math.max(1, Math.round(Number(generationSeconds) || BOARD_VIDEO_GENERATION_SECONDS));
  const plans = value.map((item, offset) => {
    const record = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    if (!record) return null;
    const start = Number(record.start);
    const sourceStart = Number(record.sourceStart);
    const duration = Number(record.duration);
    const sourceDuration = Number(record.sourceDuration);
    const outputDuration = Number(record.outputDuration);
    const requestedTotal = Number(record.requestedTotal);
    const plannedOutputDuration = Number(record.plannedOutputDuration);
    const sourceTimeRange = String(record.sourceTimeRange || "");
    const outputTimeRange = String(record.outputTimeRange || "");
    if (
      Number(record.index) !== offset + 1
      || !Number.isFinite(start)
      || !Number.isFinite(sourceStart)
      || duration !== taskDuration
      || !(sourceDuration > 0 && sourceDuration <= taskDuration)
      || outputDuration !== taskDuration
      || !(requestedTotal > 0)
      || plannedOutputDuration !== value.length * taskDuration
      || !sourceTimeRange
      || !outputTimeRange
    ) return null;
    return {
      index: offset + 1,
      start,
      sourceStart,
      duration,
      sourceDuration,
      sourceTimeRange,
      outputDuration,
      outputTimeRange,
      requestedTotal,
      plannedOutputDuration,
    };
  });
  return plans.every((plan): plan is VideoShotSegmentPlan => Boolean(plan))
    ? plans
    : null;
}

export function matchesGeneratedVideoSegment(
  meta: Record<string, unknown> | undefined,
  segment: VideoShotSegmentPlan,
  channel: { id?: string; model?: string; durationOptions?: number[] } | null | undefined,
  director: CurrentDirector,
  expectedReferenceNodeIds?: string[],
) {
  const channelId = String(channel?.id || "").trim();
  const model = String(channel?.model || "").trim();
  const profile = getBoardVideoProfile(channel);
  const directorId = String(director?.id || "").trim();
  const directorSchemaVersion = Number(director?.meta?.directorSchemaVersion || 0);
  const capabilitySignature = String(director?.meta?.videoCapabilitySignature || "").trim();
  if (!channelId || !profile || !directorId || directorSchemaVersion !== VIDEO_DIRECTOR_SCHEMA_VERSION) return false;
  const expectedSegments = readStoredVideoShotSegmentPlan(director?.meta?.segmentPlan, profile.generationSeconds)
    || splitTargetDurationIntoVideoSegments(Number(meta?.requestedTotalDuration || 0), profile.generationSeconds);
  const exactReferences = !expectedReferenceNodeIds
    || (Array.isArray(meta?.referenceNodeIds)
      && meta.referenceNodeIds.length === expectedReferenceNodeIds.length
      && meta.referenceNodeIds.every((nodeId, index) => nodeId === expectedReferenceNodeIds[index]));
  return Number(meta?.segmentIndex) === segment.index
    && Number(meta?.segmentCount) === expectedSegments.length
    && Number(meta?.generationDuration) === profile.generationSeconds
    && Number(meta?.sourceDuration) === segment.sourceDuration
    && Number(meta?.outputDuration) === segment.outputDuration
    && Number(meta?.requestedTotalDuration) === segment.requestedTotal
    && Number(meta?.plannedOutputDuration) === segment.plannedOutputDuration
    && String(meta?.channelId || "").trim() === channelId
    && String(meta?.model || "").trim() === model
    && String(meta?.capabilitySignature || "").trim() === capabilitySignature
    && String(meta?.directorNodeId || "").trim() === directorId
    && Number(meta?.directorSchemaVersion || 0) === directorSchemaVersion
    && Array.isArray(meta?.referenceNodeIds)
    && meta.referenceNodeIds.length === profile.referenceImageCount
    && exactReferences;
}
