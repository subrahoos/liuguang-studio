import type { VideoShotSegmentPlan } from "@/lib/video-shot-segments";

export const DIRECTOR_EVIDENCE_DOMAINS = [
  { suffix: "FRAMING", path: "visualState.framingAndCamera", heading: "CAMERA DIRECTION" },
  { suffix: "PERFORMANCE", path: "visualState.bodyGazeAndExpression", heading: "CINEMATIC MOTION" },
  { suffix: "ACTION", path: "actionSequence.contactLimbIds/contactTargetIds + productContact.motionPathAndAmplitude + contactEvidenceLedger + contactCycleLedger", heading: "CINEMATIC MOTION" },
  { suffix: "PRODUCT", path: "productContact.contactTargets + overview.sourceProductTransferBoundary", heading: "PRODUCT CONSISTENCY LOCK" },
  { suffix: "LIGHT", path: "visualState.lightAndEnvironment", heading: "LIGHTING AND TEXTURE" },
  { suffix: "BOUNDARY", path: "boundary", heading: "TRANSITION INTENT" },
  { suffix: "END_STATE", path: "boundary.exitEvidence", heading: "CONTINUITY" },
  { suffix: "RISKS", path: "productContact.limbAndOcclusionEvidence + excludedTargetsOrInferences + reproductionRisks", heading: "NEGATIVE CONSTRAINTS" },
] as const;

export type DirectorSegmentEvidenceCoverage = {
  segmentIndex: number;
  evidenceIds: string[];
  assignments: Array<{ evidenceId: string; heading: string }>;
  manifestLines: string[];
};

export type DirectorSegmentEditorialTimingLock = {
  segmentIndex: number;
  text: string;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clockSeconds(value: string) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function timeRange(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(.+?)\s*(?:-|–|—|to)\s*(.+)$/i);
  if (!match) return null;
  const start = clockSeconds(match[1]);
  const end = clockSeconds(match[2]);
  return start === null || end === null || end <= start ? null : { start, end };
}

function segmentRange(segment: VideoShotSegmentPlan) {
  return {
    start: segment.sourceStart,
    end: segment.sourceStart + segment.sourceDuration,
  };
}

function fixedSeconds(value: number) {
  return value.toFixed(3);
}

/**
 * Turns report-owned shot boundaries into a compact instruction that is added
 * to the paid generation request. This keeps cut timing independent from a
 * model's prose choices in the director draft.
 */
export function buildDirectorSegmentEditorialTimingLocks(
  parsedAnalysis: unknown,
  segments: VideoShotSegmentPlan[],
): DirectorSegmentEditorialTimingLock[] {
  const analysis = recordOf(parsedAnalysis);
  const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline : [];
  if (timeline.length === 0) throw new Error("Reference-video breakdown has no timeline for an editorial timing lock.");

  const shotRanges = timeline.map((value, index) => {
    const row = recordOf(value);
    const range = timeRange(row?.timeRange);
    if (!range) throw new Error(`Reference-video breakdown timeline segment ${index + 1} has no usable time range for an editorial timing lock.`);
    return { shotIndex: index + 1, range };
  });

  return segments.map((segment) => {
    const current = segmentRange(segment);
    const windows = shotRanges.flatMap(({ shotIndex, range }) => {
      const start = Math.max(range.start, current.start);
      const end = Math.min(range.end, current.end);
      if (end <= start + 0.001) return [];
      return [{
        shotIndex,
        start: start - current.start,
        end: end - current.start,
      }];
    });
    if (windows.length === 0) {
      throw new Error(`Video task ${segment.index} has no reference shot window for an editorial timing lock.`);
    }
    // The final generated task can outlast its reference-evidence window.
    // The tail remains the outgoing shot's end state; it never borrows the
    // next shot from a different independent video task.
    windows.at(-1)!.end = segment.outputDuration;
    const windowsText = windows
      .map((window) => `${fixedSeconds(window.start)}-${fixedSeconds(window.end)}s=S${window.shotIndex}`)
      .join("; ");
    const cutTimes = windows.slice(1).map((window) => fixedSeconds(window.start));
    const cutText = cutTimes.length ? cutTimes.join(", ") : "none";
    const lastShot = windows.at(-1)!.shotIndex;
    return {
      segmentIndex: segment.index,
      text: `EDIT TIMING LOCK: ${windowsText}; cuts ${cutText}; keep framing/camera; no extra cuts/zooms/crops/switches; no early S${lastShot}.`,
    };
  });
}

export function buildDirectorEvidenceCoverage(
  parsedAnalysis: unknown,
  segments: VideoShotSegmentPlan[],
): DirectorSegmentEvidenceCoverage[] {
  const analysis = recordOf(parsedAnalysis);
  const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline : [];
  if (timeline.length === 0) throw new Error("参考视频拆解报告没有 timeline，无法建立导演稿证据覆盖合同。");

  const shotRanges = timeline.map((value, index) => {
    const row = recordOf(value);
    const range = timeRange(row?.timeRange);
    if (!row || !range) {
      throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 没有可用时间范围，无法建立导演稿证据覆盖合同。`);
    }
    return { shotIndex: index + 1, range };
  });

  return segments.map((segment) => {
    const current = segmentRange(segment);
    const overlapping = shotRanges.filter(({ range }) =>
      range.start < current.end - 0.001 && range.end > current.start + 0.001
    );
    if (overlapping.length === 0) {
      throw new Error(`视频任务 ${segment.index} 没有匹配到任何参考镜头证据。`);
    }
    const evidenceIds = overlapping.flatMap(({ shotIndex }) =>
      DIRECTOR_EVIDENCE_DOMAINS.map((domain) => `SHOT_${String(shotIndex).padStart(2, "0")}_${domain.suffix}`)
    );
    const assignments = overlapping.flatMap(({ shotIndex }) =>
      DIRECTOR_EVIDENCE_DOMAINS.map((domain) => ({
        evidenceId: `SHOT_${String(shotIndex).padStart(2, "0")}_${domain.suffix}`,
        heading: domain.heading,
      }))
    );
    const manifestLines = overlapping.flatMap(({ shotIndex }) =>
      DIRECTOR_EVIDENCE_DOMAINS.map((domain) => {
        const id = `SHOT_${String(shotIndex).padStart(2, "0")}_${domain.suffix}`;
        return `${id} → timeline[${shotIndex - 1}].${domain.path} → ${domain.heading}`;
      })
    );
    return { segmentIndex: segment.index, evidenceIds, assignments, manifestLines };
  });
}

function promptSections(prompt: string) {
  const sections = new Map<string, string>();
  // The model may put the first sentence on the same line as `HEADING:` or
  // start it on the next line. Both forms are valid for the fixed director
  // heading contract, so detect the colon only and retain inline content.
  const matches = Array.from(prompt.matchAll(/^([A-Z][A-Z ]+):(?=\s|$)/gm));
  matches.forEach((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = matches[index + 1]?.index ?? prompt.length;
    sections.set(match[1].trim(), prompt.slice(start, end).trim());
  });
  return sections;
}

export function assertDirectorCoverageMarkers(
  prompt: string,
  expected: DirectorSegmentEvidenceCoverage,
) {
  const sections = promptSections(prompt);
  const known = new Set(expected.evidenceIds);
  const returnedMarkers = Array.from(prompt.matchAll(/\[([A-Z0-9_]+)\]/g), (match) => match[1]);
  const unknown = returnedMarkers.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(`任务 ${expected.segmentIndex} 的执行稿包含未知证据标记：${Array.from(new Set(unknown)).join("、")}。`);
  }
  for (const assignment of expected.assignments) {
    const section = sections.get(assignment.heading) || "";
    const marker = `[${assignment.evidenceId}]`;
    const count = section.split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`任务 ${expected.segmentIndex} 的 ${assignment.evidenceId} 必须在 ${assignment.heading} 中出现且只出现一次。`);
    }
    const markerIndex = section.indexOf(marker);
    const contentAfterMarker = section.slice(markerIndex + marker.length);
    const nextMarkerIndex = contentAfterMarker.search(/\[[A-Z0-9_]+\]/);
    const markedClause = (nextMarkerIndex === -1
      ? contentAfterMarker
      : contentAfterMarker.slice(0, nextMarkerIndex)
    ).trim();
    if (
      markedClause.length < 18
      || (markedClause.match(/[A-Za-z0-9]+/g) || []).length < 3
      || !/[.!?](?:\s|$)/.test(markedClause)
    ) {
      throw new Error(`任务 ${expected.segmentIndex} 的 ${assignment.evidenceId} 必须紧跟一条完整的可执行事实句。`);
    }
  }
}

export function stripDirectorCoverageMarkers(prompt: string) {
  return prompt
    .replace(/\[SHOT_\d{2}_[A-Z0-9_]+\]\s*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Evidence IDs are temporary output annotations. The executable prompt is
 * persisted only after each annotation has been tied to its assigned heading
 * and a complete instruction, then the annotation is removed.
 */
export function validateAndStripDirectorCoverageMarkers(
  prompt: string,
  expected: DirectorSegmentEvidenceCoverage,
) {
  assertDirectorCoverageMarkers(prompt, expected);
  return stripDirectorCoverageMarkers(prompt);
}
