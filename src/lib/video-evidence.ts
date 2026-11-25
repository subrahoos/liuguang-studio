export interface StoryboardCell {
  index: number;
  sequence: string;
  timeSeconds: number;
  timestamp: string;
}

export interface ActionSupplementCell extends StoryboardCell {
  /**
   * Interstitial cells fill the half-second gaps in the one-second overview.
   * Cut-side cells are sampled immediately before/after a program-detected cut.
   */
  evidenceKind: "interstitial" | "cut-outgoing" | "cut-incoming";
  cutTimeSeconds?: number;
}

export interface EvidenceBoundary {
  durationSeconds: number;
  source: "full-video";
}

const MIN_SAMPLE_INTERVAL_SECONDS = 0.1;
const REPLACEABLE_VIDEO_EVIDENCE_ROLES = new Set([
  "storyboard_overview",
  "action_detail_storyboard_collection",
  "action_supplement_storyboard_collection",
  "keyframe_collection",
  "scene_change_collection",
  "audio_evidence",
]);

export function isReplaceableVideoEvidenceNode(node: {
  kind: string;
  meta?: Record<string, unknown>;
}) {
  const assetRole = String(node.meta?.assetRole || "");
  return node.kind === "source_video"
    || node.kind === "storyboard"
    || REPLACEABLE_VIDEO_EVIDENCE_ROLES.has(assetRole);
}

function safeInterval(intervalSeconds: number) {
  return Math.max(MIN_SAMPLE_INTERVAL_SECONDS, intervalSeconds);
}

export function sampledFrameCount(durationSeconds: number, intervalSeconds: number) {
  return Math.max(1, Math.ceil(durationSeconds / safeInterval(intervalSeconds)));
}

function formatTimestamp(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return milliseconds ? `${base}.${String(milliseconds).padStart(3, "0")}` : base;
}

export function storyboardCells(durationSeconds: number, intervalSeconds: number): StoryboardCell[] {
  const interval = safeInterval(intervalSeconds);
  return Array.from({ length: sampledFrameCount(durationSeconds, interval) }, (_, index) => {
    const timeSeconds = Math.min(index * interval, Math.max(0, durationSeconds - 0.001));
    return {
      index: index + 1,
      sequence: `S${String(index + 1).padStart(2, "0")}`,
      timeSeconds,
      timestamp: formatTimestamp(timeSeconds),
    };
  });
}

/**
 * Build only the visual evidence missing from a one-second overview: every
 * .5-second interstitial frame plus both observable sides of each hard cut.
 * The two cut-side frames deliberately remain distinct even when very close
 * together because a hard cut is a state discontinuity, not duplicate motion.
 */
export function actionSupplementCells(
  durationSeconds: number,
  sceneCutTimes: number[],
  options: { overviewIntervalSeconds?: number; interstitialIntervalSeconds?: number; cutSideOffsetSeconds?: number } = {},
): ActionSupplementCell[] {
  const duration = Math.max(0.1, durationSeconds);
  const overviewInterval = safeInterval(options.overviewIntervalSeconds ?? 1);
  const interstitialInterval = safeInterval(options.interstitialIntervalSeconds ?? 0.5);
  const cutSideOffset = Math.max(0.01, options.cutSideOffsetSeconds ?? 0.04);
  const candidates: Array<Omit<ActionSupplementCell, "index" | "sequence" | "timestamp">> = [];

  for (let time = interstitialInterval; time < duration - 0.001; time += interstitialInterval) {
    const ratio = time / overviewInterval;
    if (Math.abs(ratio - Math.round(ratio)) <= 0.001) continue;
    candidates.push({
      timeSeconds: Number(time.toFixed(3)),
      evidenceKind: "interstitial",
    });
  }

  const cuts = [...new Set(sceneCutTimes
    .filter((time) => Number.isFinite(time) && time > 0.001 && time < duration - 0.001)
    .map((time) => Number(time.toFixed(3))))]
    .sort((left, right) => left - right);
  for (const cutTimeSeconds of cuts) {
    candidates.push({
      timeSeconds: Number(Math.max(0, cutTimeSeconds - cutSideOffset).toFixed(3)),
      evidenceKind: "cut-outgoing",
      cutTimeSeconds,
    });
    candidates.push({
      timeSeconds: Number(Math.min(duration - 0.001, cutTimeSeconds + 0.001).toFixed(3)),
      evidenceKind: "cut-incoming",
      cutTimeSeconds,
    });
  }

  const kindRank: Record<ActionSupplementCell["evidenceKind"], number> = {
    interstitial: 0,
    "cut-outgoing": 1,
    "cut-incoming": 2,
  };
  return candidates
    .sort((left, right) => left.timeSeconds - right.timeSeconds || kindRank[left.evidenceKind] - kindRank[right.evidenceKind])
    .map((cell, index) => ({
      ...cell,
      index: index + 1,
      sequence: `P${String(index + 1).padStart(3, "0")}`,
      timestamp: formatTimestamp(cell.timeSeconds),
    }));
}

export function sampledFpsFilter(intervalSeconds: number) {
  const interval = safeInterval(intervalSeconds);
  return `fps=fps=1/${interval}:start_time=0:eof_action=pass`;
}

export function resolveEvidenceBoundary(input: {
  sourceDurationSeconds: number;
}): EvidenceBoundary {
  const duration = Math.max(0.1, input.sourceDurationSeconds);
  return { durationSeconds: duration, source: "full-video" };
}

export function actionDetailSheetRanges(durationSeconds: number, groupSeconds = 5) {
  const safeDuration = Math.max(0.1, durationSeconds);
  const safeGroup = Math.max(1, groupSeconds);
  return Array.from({ length: Math.ceil(safeDuration / safeGroup) }, (_, index) => ({
    index: index + 1,
    startSeconds: index * safeGroup,
    endSeconds: Math.min(safeDuration, (index + 1) * safeGroup),
  }));
}

export function actionDetailSheetFilter(input: {
  startSeconds: number;
  endSeconds: number;
  intervalSeconds?: number;
  firstSequenceIndex: number;
}) {
  const interval = safeInterval(input.intervalSeconds ?? 0.5);
  const duration = Math.max(0.1, input.endSeconds - input.startSeconds);
  const frameCount = sampledFrameCount(duration, interval);
  const columns = frameCount <= 10 ? Math.min(5, frameCount) : 6;
  const rows = Math.ceil(frameCount / columns);
  const cellWidth = frameCount <= 12 ? 300 : 260;
  const fontSize = 20;
  const labelHeight = fontSize + 14;
  const start = Number(input.startSeconds.toFixed(3));
  const label = `D%{eif\\:n+${input.firstSequenceIndex}\\:d\\:03} · %{pts\\:hms}`;
  return [
    `trim=start=${start}:end=${input.endSeconds.toFixed(3)}`,
    `setpts=PTS-STARTPTS+${start}/TB`,
    `fps=fps=1/${interval}:start_time=${start}:eof_action=pass`,
    `scale=${cellWidth}:-2`,
    `drawbox=x=0:y=0:w=iw:h=${labelHeight}:color=black@0.68:t=fill`,
    `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${label}':x=8:y=6:fontcolor=white:fontsize=${fontSize}:shadowcolor=black@0.8:shadowx=1:shadowy=1`,
    `tile=${columns}x${rows}:padding=4:margin=4`,
  ].join(",");
}

export function storyboardOverviewFilter(durationSeconds: number, intervalSeconds: number) {
  const frameCount = sampledFrameCount(durationSeconds, intervalSeconds);
  const columns =
    frameCount <= 12 ? 4 :
    frameCount <= 36 ? 6 :
    frameCount <= 96 ? 8 :
    10;
  const cellWidth =
    frameCount <= 36 ? 240 :
    frameCount <= 96 ? 180 :
    140;
  const rows = Math.max(1, Math.ceil(frameCount / columns));
  const fontSize = cellWidth <= 140 ? 14 : cellWidth <= 180 ? 16 : 20;
  const labelHeight = fontSize + 14;
  const label = "S%{eif\\:n+1\\:d\\:02} · %{pts\\:hms}";
  return [
    sampledFpsFilter(intervalSeconds),
    `scale=${cellWidth}:-2`,
    `drawbox=x=0:y=0:w=iw:h=${labelHeight}:color=black@0.68:t=fill`,
    `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${label}':x=8:y=6:fontcolor=white:fontsize=${fontSize}:shadowcolor=black@0.8:shadowx=1:shadowy=1`,
    `tile=${columns}x${rows}:padding=4:margin=4`,
  ].join(",");
}

function drawTextSafe(value: string) {
  return value.replace(/([\\':])/g, "\\$1");
}

/**
 * One compact supplement board. It keeps each P frame visibly labelled and
 * preserves chronological order without re-sending the S overview frames.
 */
export function actionSupplementBoardFilter(cells: ActionSupplementCell[]) {
  if (!cells.length) throw new Error("Action supplement requires at least one cell.");
  const columns = cells.length <= 6 ? 3 : cells.length <= 12 ? 4 : 5;
  const rows = Math.ceil(cells.length / columns);
  const cellWidth = cells.length <= 12 ? 240 : 200;
  const imageHeight = Math.round(cellWidth * 1.78);
  const labelHeight = 30;
  const fontSize = 16;
  const pad = 4;
  const labels = cells.map((cell) => {
    const kind = cell.evidenceKind === "interstitial"
      ? "MID"
      : cell.evidenceKind === "cut-outgoing"
        ? "OUT"
        : "IN";
    return `${cell.sequence} ${kind} ${cell.timestamp}`;
  });
  const splitOutputs = cells.map((_, index) => `[source${index}]`).join("");
  const frameFilters = cells.map((cell, index) => {
    const start = Math.max(0, cell.timeSeconds).toFixed(3);
    const end = (cell.timeSeconds + 0.25).toFixed(3);
    // The cell height is intentionally 397px. For narrow portrait sources,
    // FFmpeg may otherwise produce an odd scaled width and reject the following
    // pad filter. Keep the intermediate frame even; the final JPEG cell size is unchanged.
    return `[source${index}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,select='eq(n\\,0)',setpts=N/30/TB,scale=${cellWidth}:${imageHeight - labelHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${cellWidth}:${imageHeight - labelHeight}:(ow-iw)/2:(oh-ih)/2:color=black,drawbox=x=0:y=0:w=iw:h=${labelHeight}:color=black@0.72:t=fill,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${drawTextSafe(labels[index])}':x=6:y=7:fontcolor=white:fontsize=${fontSize}:shadowcolor=black@0.8:shadowx=1:shadowy=1[frame${index}]`;
  });
  const concatInputs = cells.map((_, index) => `[frame${index}]`).join("");
  return [
    `[0:v]split=${cells.length}${splitOutputs}`,
    ...frameFilters,
    `${concatInputs}concat=n=${cells.length}:v=1:a=0,tile=${columns}x${rows}:padding=${pad}:margin=${pad}`,
  ].join(";");
}
