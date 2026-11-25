// v10 makes the contact proof ledger executable: every source S/P cell is
// Each source cell is classified once, while every visible limb in that cell
// remains independently observable and contact cycles stay machine-derived.
export const REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION = 11;
export const ANALYSIS_FOCUS_MAX_CHARS = 400;

const MAX_REFERENCE_ANALYSIS_JSON_CHARS = 200_000;

export interface ReferenceActionAnchor {
  timeRange: string;
  /** Ordered S/P labels that prove the action state or transition. */
  evidenceCells: string[];
  /** Non-anatomical visible-limb continuity ids (L1, L2...) for those cells. */
  contactLimbIds: string[];
  /** Exact product-contact target ids proved by the action; [] when none is proved. */
  contactTargetIds: string[];
  event: string;
  evidenceStatus: string;
}

export interface ReferenceBoundaryState {
  /** First reliable cell that visually belongs to this timeline row. */
  entryEvidence: string;
  /** Last reliable same-composition cell before the next cut or effective end. */
  exitEvidence: string;
  /** The hard-cut rule that prevents invented interpolation. */
  crossCutRule: string;
  /** "none" or the exact boundary-cell conflict that must not become motion. */
  samplingConflict: string;
}

export interface ReferenceProductContactCycle {
  cycleIndex: number;
  /** One or more non-anatomical visible-limb continuity ids. */
  limbIds: string[];
  /** Exact structural product targets contacted during this independently closed cycle. */
  contactTargetIds: string[];
  /** Contact-state cells belonging to this independently closed cycle. */
  evidenceCells: string[];
}

export const REFERENCE_CONTACT_EVIDENCE_STATES = [
  "contact",
  "open_or_neutral",
  "no_contact",
  "not_observable",
] as const;

export type ReferenceContactEvidenceState = typeof REFERENCE_CONTACT_EVIDENCE_STATES[number];

export interface ReferenceContactLimbObservation {
  /** L1/L2... for visible hand continuity; none/one aggregate unknown when no limb is observable. */
  limbId: string;
  state: ReferenceContactEvidenceState;
  /** Exact product target ids. Required only for a visible contact. */
  contactTargetIds: string[];
}

export interface ReferenceContactEvidenceObservation {
  /** Exactly one known S/P label. Each source evidence cell appears once globally. */
  evidenceCell: string;
  /** One entry per visible or explicitly unobservable limb state in this source cell. */
  limbObservations: ReferenceContactLimbObservation[];
}

export interface ReferenceProductContactTarget {
  /** Stable local id such as T1. */
  targetId: string;
  /** Current worn product/object first, then its exact visible structural region. */
  description: string;
}

export interface ReferenceProductContact {
  /** All product targets visible in this timeline row, each defined once. */
  contactTargets: ReferenceProductContactTarget[];
  motionPathAndAmplitude: string;
  /** Compact source of truth for contact/open/no-contact classification. */
  contactEvidenceLedger: ReferenceContactEvidenceObservation[];
  /** [] only where no visible product contact is proved. */
  contactCycleLedger: ReferenceProductContactCycle[];
  limbAndOcclusionEvidence: string;
  excludedTargetsOrInferences: string;
  evidenceStatus: string;
}

export interface ReferenceVisualState {
  /** Composition, apparent image axis, camera progression and subject placement. */
  framingAndCamera: string;
  /** Body direction, weight, hands, gaze, face, expression and mouth state. */
  bodyGazeAndExpression: string;
  /** Visible background relationship, light, exposure, texture and colour. */
  lightAndEnvironment: string;
}

/**
 * A row in the continuous storyboard timeline, not an independent full report.
 * It exists only because a hard cut creates a new executable visual state.
 */
export interface ReferenceTimelineSegment {
  storyboardRange: string;
  timeRange: string;
  visualState: ReferenceVisualState;
  boundary: ReferenceBoundaryState;
  /** Ordered changed states with their proving evidence. Holds may be implicit between evidence events. */
  actionSequence: ReferenceActionAnchor[];
  productContact: ReferenceProductContact;
  reproductionRisks: string;
}

export interface ReferenceVideoAnalysis {
  overview: {
    formatAndPacing: string;
    visualBaseline: string;
    /** Written once for the whole reference, never repeated in every timeline row. */
    sourceProductTransferBoundary: string;
  };
  /** Continuous cut-aligned execution table derived from the storyboard. */
  timeline: ReferenceTimelineSegment[];
  audioImitation: {
    narrativeStructure: string;
    deliveryRhythm: string;
    visualSyncPattern: string;
  };
  uncertainties: string[];
}

export interface ReferenceAnalysisValidationContext {
  evidenceDurationSeconds: number;
  sceneCutTimes: number[];
  detailIntervalSeconds: number;
  /** Ordered S/P cells actually supplied to the vision model. */
  evidenceCells?: Array<{ sequence: string; timeSeconds: number }>;
}

function normalizedSceneCutTimes(context: ReferenceAnalysisValidationContext) {
  const duration = Number(context.evidenceDurationSeconds);
  return [...new Set(context.sceneCutTimes
    .filter((time) => Number.isFinite(time) && time > 0 && time < duration)
    .map((time) => Number(time.toFixed(3))))]
    .sort((left, right) => left - right);
}

const REQUIRED_OVERVIEW_FIELDS = ["formatAndPacing", "visualBaseline", "sourceProductTransferBoundary"] as const;
const REQUIRED_TIMELINE_FIELDS = ["storyboardRange", "timeRange", "reproductionRisks"] as const;
const REQUIRED_VISUAL_STATE_FIELDS = ["framingAndCamera", "bodyGazeAndExpression", "lightAndEnvironment"] as const;
const REQUIRED_BOUNDARY_FIELDS = ["entryEvidence", "exitEvidence", "crossCutRule", "samplingConflict"] as const;
const REQUIRED_PRODUCT_CONTACT_FIELDS = [
  "motionPathAndAmplitude",
  "limbAndOcclusionEvidence",
  "excludedTargetsOrInferences",
  "evidenceStatus",
] as const;
const REQUIRED_ACTION_ANCHOR_FIELDS = ["timeRange", "event", "evidenceStatus"] as const;
const REQUIRED_AUDIO_FIELDS = ["narrativeStructure", "deliveryRhythm", "visualSyncPattern"] as const;
const LIMB_ID_PATTERN = /^L[1-9]\d*$/;
const CONTACT_TARGET_ID_PATTERN = /^T[1-9]\d*$/;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function missingStringFields(record: Record<string, unknown>, fields: readonly string[]) {
  return fields.filter((field) => typeof record[field] !== "string" || !String(record[field]).trim());
}

function requiredStringArray(value: unknown, label: string, options: { allowEmpty?: boolean } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a string array.`);
  }
  const normalized = value.map((item) => item.trim());
  if (!options.allowEmpty && normalized.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate values.`);
  }
  return normalized;
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function orderedUnique(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function evidenceCatalog(context?: ReferenceAnalysisValidationContext) {
  if (!context?.evidenceCells) return null;
  const cells = context.evidenceCells.map((cell) => ({
    sequence: String(cell?.sequence || "").trim(),
    timeSeconds: Number(cell?.timeSeconds),
  }));
  if (!cells.length || cells.some((cell) => !/^[SP]\d+$/i.test(cell.sequence) || !Number.isFinite(cell.timeSeconds))) {
    throw new Error("Reference evidence manifest is incomplete.");
  }
  const labels = cells.map((cell) => cell.sequence);
  if (new Set(labels).size !== labels.length) {
    throw new Error("Reference evidence manifest has duplicate S/P labels.");
  }
  return new Map(cells.map((cell) => [cell.sequence, cell]));
}

function evidenceLabelsInText(value: string) {
  return Array.from(value.matchAll(/\b[SP]\d+\b/gi), (match) => match[0]);
}

function assertKnownEvidenceCells(
  cells: string[],
  label: string,
  catalog: Map<string, { sequence: string; timeSeconds: number }> | null,
) {
  if (!catalog) return;
  const unknown = cells.filter((cell) => !catalog.has(cell));
  if (unknown.length) throw new Error(`${label} references unknown evidence cell(s): ${unknown.join(", ")}.`);
}

function assertEvidenceTextReferences(
  value: string,
  label: string,
  catalog: Map<string, { sequence: string; timeSeconds: number }> | null,
  options: { allowNone?: boolean } = {},
) {
  if (!catalog) return;
  if (options.allowNone && value.trim().toLowerCase() === "none") return;
  const labels = evidenceLabelsInText(value);
  if (!labels.length) throw new Error(`${label} must name at least one S/P evidence cell.`);
  assertKnownEvidenceCells(orderedUnique(labels), label, catalog);
}

type ContactObservation = {
  evidenceCell: string;
  limbObservations: ReferenceContactLimbObservation[];
};

type DerivedContactCycle = {
  limbIds: string[];
  contactTargetIds: string[];
  evidenceCells: string[];
};

function sortedLimbIds(values: string[]) {
  return orderedUnique(values).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function sortedContactTargetIds(values: string[]) {
  return orderedUnique(values).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function contactSignature(observation: ContactObservation) {
  return observation.limbObservations
    .filter((limb) => limb.state === "contact")
    .map((limb) => `${limb.limbId}:${sortedContactTargetIds(limb.contactTargetIds).join("+")}`)
    .sort()
    .join("|");
}

function derivedContactCycles(observations: ContactObservation[]): DerivedContactCycle[] {
  const cycles: DerivedContactCycle[] = [];
  let current: DerivedContactCycle | null = null;
  let currentSignature = "";
  for (const observation of observations) {
    const contacts = observation.limbObservations.filter((limb) => limb.state === "contact");
    const signature = contactSignature(observation);
    if (!signature) {
      current = null;
      currentSignature = "";
      continue;
    }
    if (!current || signature !== currentSignature) {
      current = {
        limbIds: sortedLimbIds(contacts.map((limb) => limb.limbId)),
        contactTargetIds: sortedContactTargetIds(contacts.flatMap((limb) => limb.contactTargetIds)),
        evidenceCells: [],
      };
      cycles.push(current);
    }
    current.evidenceCells.push(observation.evidenceCell);
    currentSignature = signature;
  }
  return cycles;
}

function assertContactLedgerIntegrity(analysis: Record<string, unknown>, context?: ReferenceAnalysisValidationContext) {
  const catalog = evidenceCatalog(context);
  const globallyClassified = new Set<string>();
  const timeline = analysis.timeline as Array<Record<string, unknown>>;

  timeline.forEach((segment, segmentIndex) => {
    const productContact = recordOf(segment.productContact)!;
    const rawTargets = productContact.contactTargets;
    if (!Array.isArray(rawTargets)) {
      throw new Error(`Timeline segment ${segmentIndex + 1} is missing contactTargets.`);
    }
    const knownTargetIds = new Set<string>();
    rawTargets.forEach((value, targetIndex) => {
      const target = recordOf(value);
      const targetId = String(target?.targetId || "").trim();
      const description = String(target?.description || "").trim();
      if (!CONTACT_TARGET_ID_PATTERN.test(targetId) || !description) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact target ${targetIndex + 1} is invalid.`);
      }
      if (knownTargetIds.has(targetId)) {
        throw new Error(`Timeline segment ${segmentIndex + 1} repeats contact target ${targetId}.`);
      }
      knownTargetIds.add(targetId);
    });
    const rawObservations = productContact.contactEvidenceLedger;
    if (!Array.isArray(rawObservations)) {
      throw new Error(`Timeline segment ${segmentIndex + 1} is missing contactEvidenceLedger.`);
    }

    const observations: ContactObservation[] = [];
    const usedTargetIds = new Set<string>();
    let previousEvidenceTime = Number.NEGATIVE_INFINITY;
    rawObservations.forEach((value, observationIndex) => {
      const observation = recordOf(value);
      const evidenceCell = String(observation?.evidenceCell || "").trim();
      const rawLimbObservations = observation?.limbObservations;
      if (!evidenceCell || !Array.isArray(rawLimbObservations) || !rawLimbObservations.length) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} is invalid.`);
      }
      const limbIdsInCell = new Set<string>();
      const limbObservations = rawLimbObservations.map((limbValue, limbIndex) => {
        const limb = recordOf(limbValue);
        const limbId = String(limb?.limbId || "").trim();
        const state = String(limb?.state || "").trim() as ReferenceContactEvidenceState;
        const contactTargetIds = requiredStringArray(
          limb?.contactTargetIds,
          `Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} limb ${limbIndex + 1} contactTargetIds`,
          { allowEmpty: true },
        );
        if (!REFERENCE_CONTACT_EVIDENCE_STATES.includes(state)) {
          throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} limb ${limbIndex + 1} has an invalid state.`);
        }
        if (limbIdsInCell.has(limbId)) {
          if (limbId === "unknown") {
            throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} repeats unknown. Each evidence cell may contain only one aggregate unknown observation.`);
          }
          throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} repeats limb id ${limbId}.`);
        }
        limbIdsInCell.add(limbId);
        if (state === "contact" || state === "open_or_neutral") {
          if (!LIMB_ID_PATTERN.test(limbId)) {
            throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} must use an L# continuity id.`);
          }
        } else if ((state === "no_contact" && limbId !== "none") || (state === "not_observable" && limbId !== "unknown")) {
          throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} has an invalid non-contact limb id.`);
        }
        if (state === "contact") {
          if (!contactTargetIds.length || contactTargetIds.some((targetId) => !knownTargetIds.has(targetId))) {
            throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} must cite known contact target ids.`);
          }
          contactTargetIds.forEach((targetId) => usedTargetIds.add(targetId));
        } else if (contactTargetIds.length) {
          throw new Error(`Timeline segment ${segmentIndex + 1} non-contact evidence ${observationIndex + 1} cannot cite a contact target.`);
        }
        return { limbId, state, contactTargetIds };
      });
      if (limbObservations.some((observation) => observation.limbId === "none") && limbObservations.length !== 1) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact evidence ${observationIndex + 1} may use none only as its sole observation.`);
      }
      if (catalog) {
        const known = catalog.get(evidenceCell);
        if (!known) throw new Error(`Timeline segment ${segmentIndex + 1} references unknown evidence cell ${evidenceCell}.`);
        if (globallyClassified.has(evidenceCell)) {
          throw new Error(`Evidence cell ${evidenceCell} is classified more than once in contactEvidenceLedger.`);
        }
        if (known.timeSeconds < previousEvidenceTime - 0.001) {
          throw new Error(`Timeline segment ${segmentIndex + 1} contactEvidenceLedger is not in evidence order.`);
        }
        previousEvidenceTime = known.timeSeconds;
        globallyClassified.add(evidenceCell);
      }
      observations.push({ evidenceCell, limbObservations });
    });

    const unusedTargetIds = Array.from(knownTargetIds).filter((targetId) => !usedTargetIds.has(targetId));
    if (unusedTargetIds.length) {
      throw new Error(`Timeline segment ${segmentIndex + 1} contact target(s) are never observed: ${unusedTargetIds.join(", ")}.`);
    }

    const expectedCycles = derivedContactCycles(observations);
    const rawCycles = productContact.contactCycleLedger;
    if (!Array.isArray(rawCycles) || rawCycles.length !== expectedCycles.length) {
      throw new Error(`Timeline segment ${segmentIndex + 1} contactCycleLedger does not match the classified contact cycles.`);
    }
    rawCycles.forEach((value, cycleOffset) => {
      const cycle = recordOf(value);
      const expected = expectedCycles[cycleOffset]!;
      if (Number(cycle?.cycleIndex) !== cycleOffset + 1) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact cycle indices must start at 1 and remain consecutive.`);
      }
      const limbIds = requiredStringArray(cycle?.limbIds, `Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1} limbIds`);
      const contactTargetIds = requiredStringArray(cycle?.contactTargetIds, `Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1} contactTargetIds`);
      const evidenceCells = requiredStringArray(cycle?.evidenceCells, `Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1} evidenceCells`);
      if (limbIds.some((limbId) => !LIMB_ID_PATTERN.test(limbId))) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1} has an invalid limb id.`);
      }
      if (contactTargetIds.some((targetId) => !knownTargetIds.has(targetId))) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1} has an unknown contact target id.`);
      }
      assertKnownEvidenceCells(evidenceCells, `Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1}`, catalog);
      if (!sameStringArray(limbIds, expected.limbIds)
        || !sameStringArray(contactTargetIds, expected.contactTargetIds)
        || !sameStringArray(evidenceCells, expected.evidenceCells)) {
        throw new Error(`Timeline segment ${segmentIndex + 1} contact cycle ${cycleOffset + 1} does not match its contact evidence ledger.`);
      }
    });

    const observationByCell = new Map(observations.map((observation) => [observation.evidenceCell, observation]));
    const actionSequence = segment.actionSequence as Array<Record<string, unknown>>;
    actionSequence.forEach((value, actionIndex) => {
      const action = recordOf(value)!;
      const evidenceCells = requiredStringArray(action.evidenceCells, `Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} evidenceCells`);
      const contactLimbIds = requiredStringArray(action.contactLimbIds, `Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} contactLimbIds`, { allowEmpty: true });
      const contactTargetIds = requiredStringArray(action.contactTargetIds, `Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} contactTargetIds`, { allowEmpty: true });
      if (contactLimbIds.some((limbId) => !LIMB_ID_PATTERN.test(limbId))) {
        throw new Error(`Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} has an invalid contact limb id.`);
      }
      if (contactTargetIds.some((targetId) => !knownTargetIds.has(targetId))) {
        throw new Error(`Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} has an unknown contact target id.`);
      }
      assertKnownEvidenceCells(evidenceCells, `Timeline segment ${segmentIndex + 1} action ${actionIndex + 1}`, catalog);
      const provingObservations = evidenceCells.flatMap((evidenceCell) => observationByCell.get(evidenceCell)?.limbObservations || []);
      const expectedLimbIds = sortedLimbIds(provingObservations
        .map((observation) => observation.limbId)
        .filter((limbId) => LIMB_ID_PATTERN.test(limbId)));
      const expectedContactTargetIds = sortedContactTargetIds(provingObservations
        .filter((observation) => observation.state === "contact")
        .flatMap((observation) => observation.contactTargetIds));
      if (!sameStringArray(contactLimbIds, expectedLimbIds)) {
        throw new Error(`Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} contactLimbIds do not match its proving evidence.`);
      }
      if (!sameStringArray(contactTargetIds, expectedContactTargetIds)) {
        throw new Error(`Timeline segment ${segmentIndex + 1} action ${actionIndex + 1} contactTargetIds do not match its proving evidence.`);
      }
    });

    assertEvidenceTextReferences(String(segment.storyboardRange || ""), `Timeline segment ${segmentIndex + 1} storyboardRange`, catalog);
    const boundary = recordOf(segment.boundary)!;
    assertEvidenceTextReferences(String(boundary.entryEvidence || ""), `Timeline segment ${segmentIndex + 1} entryEvidence`, catalog);
    assertEvidenceTextReferences(String(boundary.exitEvidence || ""), `Timeline segment ${segmentIndex + 1} exitEvidence`, catalog);
    assertEvidenceTextReferences(String(boundary.samplingConflict || ""), `Timeline segment ${segmentIndex + 1} samplingConflict`, catalog, { allowNone: true });
  });

  if (catalog) {
    const missing = Array.from(catalog.keys()).filter((label) => !globallyClassified.has(label));
    if (missing.length) throw new Error(`contactEvidenceLedger did not classify supplied evidence cell(s): ${missing.join(", ")}.`);
  }
}

function clockSeconds(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const milliseconds = Number((match[4] || "").padEnd(3, "0") || 0);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + milliseconds / 1000;
}

function timeRangeSeconds(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*(?:-|–|to)\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/i);
  if (!match) return null;
  const start = clockSeconds(match[1]);
  const end = clockSeconds(match[2]);
  return start === null || end === null ? null : { start, end };
}

function assertEvidenceTimeline(analysis: Record<string, unknown>, context: ReferenceAnalysisValidationContext) {
  const timeline = analysis.timeline as Array<Record<string, unknown>>;
  const duration = Number(context.evidenceDurationSeconds);
  const cuts = normalizedSceneCutTimes(context);
  const expectedBoundaries = [0, ...cuts, duration];
  if (timeline.length !== expectedBoundaries.length - 1) {
    throw new Error(`参考视频拆解报告返回 ${timeline.length} 个时间线段，但程序证据要求 ${expectedBoundaries.length - 1} 个连续镜头段。请按真实切点重新拆解。`);
  }

  const boundaryTolerance = 0.12;
  timeline.forEach((segment, index) => {
    const range = timeRangeSeconds(segment.timeRange);
    if (!range || range.end <= range.start) {
      throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 时间范围无效，必须使用 HH:MM:SS.mmm-HH:MM:SS.mmm。`);
    }
    const expectedStart = expectedBoundaries[index];
    const expectedEnd = expectedBoundaries[index + 1];
    if (Math.abs(range.start - expectedStart) > boundaryTolerance || Math.abs(range.end - expectedEnd) > boundaryTolerance) {
      throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 没有遵守程序检测切点（应为 ${expectedStart.toFixed(3)}-${expectedEnd.toFixed(3)}s）。`);
    }

    const actionSequence = Array.isArray(segment.actionSequence) ? segment.actionSequence : [];
    let previousActionEnd = range.start;
    actionSequence.forEach((value, actionIndex) => {
      const action = recordOf(value);
      const actionRange = timeRangeSeconds(action?.timeRange);
      if (!actionRange || actionRange.end <= actionRange.start) {
        throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 动作 ${actionIndex + 1} 时间范围无效。`);
      }
      if (actionRange.start < range.start - boundaryTolerance || actionRange.end > range.end + boundaryTolerance) {
        throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 动作 ${actionIndex + 1} 超出了本段时间范围。`);
      }
      const interval = Math.max(0.1, context.detailIntervalSeconds);
      const startOnBoundary = expectedBoundaries.some((boundary) => Math.abs(actionRange.start - boundary) <= boundaryTolerance);
      const endOnBoundary = expectedBoundaries.some((boundary) => Math.abs(actionRange.end - boundary) <= boundaryTolerance);
      const startAligned = Math.abs(actionRange.start / interval - Math.round(actionRange.start / interval)) <= 0.02;
      const endAligned = Math.abs(actionRange.end / interval - Math.round(actionRange.end / interval)) <= 0.02;
      if ((!startAligned && !startOnBoundary) || (!endAligned && !endOnBoundary)) {
        throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 动作 ${actionIndex + 1} 使用了故事板证据之外的虚构时间精度。`);
      }
      if (actionRange.start < previousActionEnd - 0.02) {
        throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 动作 ${actionIndex + 1} 与前一动作时间重叠。`);
      }
      previousActionEnd = actionRange.end;
    });
  });
}

function codePointLabel(character: string) {
  return `U+${(character.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

export function transcriptEncodingIssue(text: string) {
  if (text.includes("\uFFFD")) return "Unicode replacement character U+FFFD";
  if (text.includes("茂驴陆")) return "mis-decoded UTF-8 replacement sequence";
  if (text.includes("锟斤拷")) return "common replacement-text mojibake";
  for (const character of text) {
    const codePoint = character.codePointAt(0) || 0;
    if (codePoint === 0x0378 || codePoint === 0x0379) return `unassigned Unicode character ${codePointLabel(character)}`;
    if ((codePoint & 0xffff) >= 0xfffe) return `Unicode noncharacter ${codePointLabel(character)}`;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return `unpaired surrogate ${codePointLabel(character)}`;
    if (codePoint < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") {
      return `control character ${codePointLabel(character)}`;
    }
  }
  return "";
}

export function assertCleanTranscriptText(text: string, label: string) {
  const issue = transcriptEncodingIssue(text);
  if (issue) throw new Error(`${label}包含乱码（${issue}），本次结果不会保存或发送。请从完整音频节点重新执行“中文音频转写”。`);
}

export function completeReferenceAnalysisJson(parsed: unknown, context?: ReferenceAnalysisValidationContext) {
  const analysis = recordOf(parsed);
  if (!analysis) throw new Error("参考视频拆解报告没有完整的结构化数据，请重新拆解参考视频后再生成完整导演稿。");

  const overview = recordOf(analysis.overview);
  const overviewMissing = overview ? missingStringFields(overview, REQUIRED_OVERVIEW_FIELDS) : [...REQUIRED_OVERVIEW_FIELDS];
  if (overviewMissing.length) throw new Error(`参考视频拆解报告的总览不完整（缺少 ${overviewMissing.join("、")}），请重新拆解参考视频。`);

  if (!Array.isArray(analysis.timeline) || analysis.timeline.length === 0) {
    throw new Error("参考视频拆解报告没有完整的 timeline 连续时间线，请重新拆解参考视频。");
  }

  analysis.timeline.forEach((value, index) => {
    const segment = recordOf(value);
    if (!segment) throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 不是有效的结构化对象，请重新拆解参考视频。`);
    const missing = missingStringFields(segment, REQUIRED_TIMELINE_FIELDS);
    if (missing.length) throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 不完整（缺少 ${missing.join("、")}），请重新拆解参考视频。`);

    const visualState = recordOf(segment.visualState);
    const visualMissing = visualState ? missingStringFields(visualState, REQUIRED_VISUAL_STATE_FIELDS) : [...REQUIRED_VISUAL_STATE_FIELDS];
    if (visualMissing.length) throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 视觉状态不完整（缺少 ${visualMissing.join("、")}），请重新拆解参考视频。`);

    const boundary = recordOf(segment.boundary);
    const boundaryMissing = boundary ? missingStringFields(boundary, REQUIRED_BOUNDARY_FIELDS) : [...REQUIRED_BOUNDARY_FIELDS];
    if (boundaryMissing.length) throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 切点两侧状态不完整（缺少 ${boundaryMissing.join("、")}），请重新拆解参考视频。`);

    const productContact = recordOf(segment.productContact);
    const productMissing = productContact
      ? missingStringFields(productContact, REQUIRED_PRODUCT_CONTACT_FIELDS)
      : [...REQUIRED_PRODUCT_CONTACT_FIELDS];
    if (productMissing.length) throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 商品相对动作不完整（缺少 ${productMissing.join("、")}），请重新拆解参考视频。`);
    const actionSequence = segment.actionSequence;
    if (!Array.isArray(actionSequence) || actionSequence.length === 0) {
      throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 缺少按时间排序的动作链，请重新拆解参考视频。`);
    }
    actionSequence.forEach((anchor, actionIndex) => {
      const action = recordOf(anchor);
      const actionMissing = action ? missingStringFields(action, REQUIRED_ACTION_ANCHOR_FIELDS) : [...REQUIRED_ACTION_ANCHOR_FIELDS];
      if (actionMissing.length) throw new Error(`参考视频拆解报告的时间线段 ${index + 1} 动作 ${actionIndex + 1} 不完整（缺少 ${actionMissing.join("、")}），请重新拆解参考视频。`);
    });
  });

  const audioImitation = recordOf(analysis.audioImitation);
  const audioMissing = audioImitation ? missingStringFields(audioImitation, REQUIRED_AUDIO_FIELDS) : [...REQUIRED_AUDIO_FIELDS];
  if (audioMissing.length) throw new Error(`参考视频拆解报告的音频仿写规律不完整（缺少 ${audioMissing.join("、")}），请重新拆解参考视频。`);
  if (!Array.isArray(analysis.uncertainties) || analysis.uncertainties.some((item) => typeof item !== "string")) {
    throw new Error("参考视频拆解报告的证据不确定项结构不完整，请重新拆解参考视频。");
  }
  assertContactLedgerIntegrity(analysis, context);
  if (context) assertEvidenceTimeline(analysis, context);

  const serialized = JSON.stringify(analysis, null, 2);
  const encodingIssue = transcriptEncodingIssue(serialized);
  if (encodingIssue) throw new Error(`参考视频拆解报告包含乱码（${encodingIssue}），本次结果不会保存或发送。请重新转写音频并重新拆解参考视频。`);
  if (serialized.length > MAX_REFERENCE_ANALYSIS_JSON_CHARS) {
    throw new Error(`完整结构化拆解报告共 ${serialized.length} 字符，超过 ${MAX_REFERENCE_ANALYSIS_JSON_CHARS} 字符安全上限；系统没有截断，请缩短参考视频后重新拆解。`);
  }
  return serialized;
}

export function formatReferenceVideoAnalysis(parsed: ReferenceVideoAnalysis, language: "english" | "chinese") {
  const chinese = language === "chinese";
  const labels = chinese
    ? {
        title: "参考视频执行总表",
        overview: "全片总览",
        visual: "全局视觉基线",
        productBoundary: "商品迁移边界",
        timeline: "连续故事板时间线",
        visualState: "该段画面状态",
        action: "动作链",
        product: "商品接触锁定",
        cycles: "商品接触轮次账本",
        boundary: "硬切两侧状态",
        risks: "复刻风险",
        audio: "音频仿写规律",
        uncertainties: "证据不确定项",
      }
    : {
        title: "Reference Video Execution Summary",
        overview: "Whole-Video Overview",
        visual: "Global Visual Baseline",
        productBoundary: "Source-Product Transfer Boundary",
        timeline: "Continuous Storyboard Timeline",
        visualState: "Visual State",
        action: "Action Sequence",
        product: "Product Contact Lock",
        cycles: "Product-Contact Cycle Ledger",
        boundary: "Hard-Cut Side States",
        risks: "Reproduction Risks",
        audio: "Audio Imitation Pattern",
        uncertainties: "Evidence Uncertainties",
      };

  const timeline = parsed.timeline.map((segment, index) => {
    const visualState = chinese
      ? `构图/机位：${segment.visualState.framingAndCamera}；身体/视线/表情：${segment.visualState.bodyGazeAndExpression}；光线/环境：${segment.visualState.lightAndEnvironment}`
      : `framing/camera: ${segment.visualState.framingAndCamera}; body/gaze/expression: ${segment.visualState.bodyGazeAndExpression}; light/environment: ${segment.visualState.lightAndEnvironment}`;
    return [
    `### ${chinese ? "时间线段" : "Timeline Segment"} ${index + 1} · ${segment.storyboardRange} · ${segment.timeRange}`,
    `**${labels.visualState}:** ${visualState}`,
    `**${labels.action}:** ${segment.actionSequence.map((action) => `[${action.timeRange}; ${action.evidenceCells.join(", ")}; limbs ${action.contactLimbIds.join(", ") || "none"}; targets ${action.contactTargetIds.join(", ") || "none"}; ${action.evidenceStatus}] ${action.event}`).join(" → ")}`,
    `**${labels.product}:** targets: ${segment.productContact.contactTargets.map((target) => `${target.targetId}=${target.description}`).join(" | ") || "none"}; path/amplitude: ${segment.productContact.motionPathAndAmplitude}; contact evidence: ${segment.productContact.contactEvidenceLedger.map((item) => `${item.evidenceCell}=[${item.limbObservations.map((limb) => `${limb.limbId}=${limb.state}${limb.contactTargetIds.length ? `(${limb.contactTargetIds.join(",")})` : ""}`).join("; ")}]`).join(", ")}; limb/occlusion: ${segment.productContact.limbAndOcclusionEvidence}; exclusions: ${segment.productContact.excludedTargetsOrInferences}; evidence: ${segment.productContact.evidenceStatus}`,
    `**${labels.cycles}:** ${segment.productContact.contactCycleLedger.length ? segment.productContact.contactCycleLedger.map((cycle) => `cycle ${cycle.cycleIndex} (limbs ${cycle.limbIds.join(", ")}; targets ${cycle.contactTargetIds.join(", ")}): ${cycle.evidenceCells.join(", ")}`).join(" | ") : (chinese ? "未观察到商品接触轮次" : "no visible product-contact cycle")}`,
    `**${labels.boundary}:** entry: ${segment.boundary.entryEvidence}; exit: ${segment.boundary.exitEvidence}; rule: ${segment.boundary.crossCutRule}; sampling conflict: ${segment.boundary.samplingConflict}`,
    `**${labels.risks}:** ${segment.reproductionRisks}`,
    ].join("\n");
  }).join("\n\n");

  return [
    `# ${labels.title}`,
    `## ${labels.overview}\n${parsed.overview.formatAndPacing}`,
    `## ${labels.visual}\n${parsed.overview.visualBaseline}`,
    `## ${labels.productBoundary}\n${parsed.overview.sourceProductTransferBoundary}`,
    `## ${labels.timeline}\n${timeline}`,
    [
      `## ${labels.audio}`,
      `**${chinese ? "叙事结构" : "Narrative Structure"}:** ${parsed.audioImitation.narrativeStructure}`,
      `**${chinese ? "语速、停顿与重音" : "Delivery Rhythm"}:** ${parsed.audioImitation.deliveryRhythm}`,
      `**${chinese ? "声画规律" : "Visual Sync Pattern"}:** ${parsed.audioImitation.visualSyncPattern}`,
    ].join("\n"),
    parsed.uncertainties.length
      ? `## ${labels.uncertainties}\n${parsed.uncertainties.map((item) => `- ${item}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n").trim();
}
