import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { resolveLLMSetting, resolveVideoChannel } from "@/lib/server-model-settings";
import { NextRequest, NextResponse } from "next/server";
import {
  createEdge,
  createNode,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  manualDirectInputNodeIds,
  startNodeExecution,
  updateBoardWorkflow,
  uniqueNodeIds,
  type BoardWorkflow,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import { generatedOutputPosition } from "@/lib/board-node-placement";
import { extractLongJsonError, postOpenAiChatJsonWithLongTimeout } from "@/lib/server/long-json-request";
import { auditModelApiCall } from "@/lib/model-api-audit";
import {
  channelSpecificDirectorText,
  REQUIRED_VIDEO_DIRECTOR_HEADINGS,
  VIDEO_DIRECTOR_SCHEMA_VERSION,
  videoDirectorHeadings,
} from "@/lib/video-director-contract";
import {
  buildDirectorEvidenceCoverage,
  buildDirectorSegmentEditorialTimingLocks,
  validateAndStripDirectorCoverageMarkers,
  type DirectorSegmentEvidenceCoverage,
  type DirectorSegmentEditorialTimingLock,
} from "@/lib/video-director-coverage";
import {
  assertCleanTranscriptText,
  completeReferenceAnalysisJson,
  REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION,
} from "@/lib/video-director-input";
import {
  normalizedBoardVideoTargetDuration,
  splitTargetDurationIntoVideoSegments,
  type VideoShotSegmentPlan,
} from "@/lib/video-shot-segments";
import { getBoardVideoProfile } from "@/lib/board-video-protocol";
import {
  referenceEvidenceDurationForAnalysis,
  referenceTargetDurationSeconds,
  type BoardVideoDurationSource,
} from "@/lib/board-video-duration";
import {
  allocateVoiceoverPhrases,
  parseTimestampedVoiceoverPhrases,
  type VoiceoverTaskAllocation,
  type TimestampedVoiceoverPhrase,
} from "@/lib/voiceover-task-allocation";
import {
  directorVoiceoverCharacterLimit,
  validateDirectorVoiceoverRewrite,
  type DirectorVoiceoverMode,
} from "@/lib/director-voiceover-rewrite";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
const FULL_DIRECTOR_WORD_TARGET = 450;
const SEGMENT_DIRECTOR_WORD_TARGET = 190;
// The execution layer adds a reference-contract header before the segment.
// Budget in UTF-8 bytes because Grok enforces its 4096-byte prompt limit.
const SEGMENT_DIRECTOR_UTF8_BYTE_LIMIT = 3400;
const SEGMENT_DIRECTOR_RETRY_TARGET = 2800;
const DIRECTOR_GENERATION_ATTEMPTS = 3;
const DIRECTOR_LLM_TIMEOUT_MS = 10 * 60 * 1000;
interface DirectorPlan {
  fullDirectorPromptEnglish?: string;
  rewrittenVoiceoverChinese?: string;
  rewrittenVoiceoverPhrases?: Array<{
    phraseIndex?: number;
    sourceTimeRange?: string;
    spokenLine?: string;
  }>;
  segmentPrompts?: Array<{
    segmentIndex?: number;
    /** Exact reference-video evidence range, injected by the server. */
    timeRange?: string;
    /** Exact delivered-video timeline range, injected by the server. */
    outputTimeRange?: string;
    duration?: number;
    promptEnglish?: string;
    evidenceCoverageIds?: string[];
    /** Server-owned exact shot-boundary timing lock for the generation request. */
    editorialTimingLock?: string;
    conflictResolution?: string;
  }>;
}

function directorResponseFormat(segmentCount: number, voiceoverPhraseCount: number) {
  return {
    type: "json_schema",
    json_schema: {
      name: "board_video_director_plan",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "fullDirectorPromptEnglish",
          "rewrittenVoiceoverPhrases",
          "segmentPrompts",
        ],
        properties: {
          fullDirectorPromptEnglish: { type: "string" },
          rewrittenVoiceoverPhrases: {
            type: "array",
            minItems: voiceoverPhraseCount,
            maxItems: voiceoverPhraseCount,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["spokenLine"],
              properties: {
                spokenLine: { type: "string" },
              },
            },
          },
          segmentPrompts: {
            type: "array",
            minItems: segmentCount,
            maxItems: segmentCount,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["promptEnglish", "conflictResolution"],
              properties: {
                promptEnglish: { type: "string" },
                conflictResolution: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
}

function endpoint(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}/v1${path.startsWith("/") ? path : `/${path}`}`;
}

function extractText(payload: unknown): string {
  const body = payload as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    output_text?: string;
  };
  if (typeof body.output_text === "string") return body.output_text;
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text || "").join("").trim();
  return "";
}

function extractJson(text: string): DirectorPlan | null {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const candidates = [cleaned, cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    try {
      return JSON.parse(candidate) as DirectorPlan;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function roleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

function voiceoverRole(node: BoardWorkflowNode) {
  return roleOf(node) === "product_voiceover_script";
}

function timestampedVoiceoverTextForNode(node?: BoardWorkflowNode) {
  if (!node) return "";
  const sourceText = String(node.meta?.sourceText || "").trim();
  if (sourceText) return sourceText;
  const parsed = node.meta?.parsed as { timedVoiceover?: Array<{ timeRange?: unknown; spokenLine?: unknown }> } | undefined;
  const timed = Array.isArray(parsed?.timedVoiceover)
    ? parsed.timedVoiceover
      .map((item) => {
        const timeRange = String(item?.timeRange || "").trim();
        const spokenLine = String(item?.spokenLine || "").trim();
        return timeRange && spokenLine ? `[${timeRange}] ${spokenLine}` : "";
      })
      .filter(Boolean)
      .join("\n")
    : "";
  return timed;
}

function referenceMandarinTranscript(workflow: Pick<BoardWorkflow, "nodes">, analysisNode: BoardWorkflowNode) {
  const transcript = analysisNode.meta?.transcript as {
    language?: unknown;
    text?: unknown;
  } | undefined;
  const language = String(transcript?.language || "").toLowerCase();
  const embedded = String(transcript?.text || "").trim();
  if (embedded && /^(?:zh|zh-cn|chinese|mandarin)$/.test(language)) return embedded;

  const transcriptNodeId = String(analysisNode.meta?.transcriptNodeId || "");
  const transcriptNode = workflow.nodes.find((node) => node.id === transcriptNodeId);
  return String(transcriptNode?.meta?.sourceText || transcriptNode?.text || "").trim();
}

function requireExactlyOne(nodes: BoardWorkflowNode[], label: string) {
  if (nodes.length === 1) return nodes[0];
  if (nodes.length === 0) throw new Error(`请手动连线 1 个${label}到完整视频导演稿节点。`);
  throw new Error(`完整视频导演稿节点只可连线 1 个${label}；请保留本次要使用的那一个。`);
}

function selectManualDirectorInputs(workflow: Pick<BoardWorkflow, "nodes" | "edges">, executorNodeId: string) {
  if (!executorNodeId) {
    throw new Error("请将“完整视频导演稿”功能拖到画板，并手动连线输入后再生成。侧栏不会自动读取最新资产。");
  }
  const executorNode = workflow.nodes.find((node) => node.id === executorNodeId);
  if (String(executorNode?.meta?.controlRole || "") !== "gpt_director") {
    throw new Error("只能从“完整视频导演稿”功能节点执行本次生成。");
  }

  const directInputIds = manualDirectInputNodeIds(workflow, executorNodeId);
  const directInputNodes = directInputIds
    .map((nodeId) => workflow.nodes.find((node) => node.id === nodeId))
    .filter((node): node is BoardWorkflowNode => Boolean(node));
  const analysisNode = requireExactlyOne(
    directInputNodes.filter((node) => roleOf(node) === "reference_method_analysis"),
    "参考视频拆解报告"
  );
  const voiceoverNodes = directInputNodes.filter(voiceoverRole);
  if (voiceoverNodes.length > 1) {
    throw new Error("完整视频导演稿一次只能连线 1 个口播输入；请保留本次要使用的口播稿。");
  }
  const unsupportedInputs = directInputNodes.filter((node) => node.id !== analysisNode.id && !voiceoverNodes.some((voiceover) => voiceover.id === node.id));
  if (unsupportedInputs.length > 0) {
    throw new Error(`完整视频导演稿只接“参考视频拆解报告”和可选的 1 份“当前商品口播”；请移除：${unsupportedInputs.map((node) => node.title).join("、")}。参考中文转写已封装在拆解报告中，无需重复连接；单镜头合成图及其它五类图片只连到对应的视频生成节点。`);
  }

  return {
    executorNode,
    directInputIds,
    analysisNode,
    voiceoverNode: voiceoverNodes[0],
  };
}

function formatSegmentLine(segment: VideoShotSegmentPlan) {
  const evidenceEnd = segment.sourceDuration.toFixed(3);
  const hasPadding = segment.outputDuration - segment.sourceDuration > 0.001;
  return [
    `Task ${segment.index}: reference evidence window ${segment.sourceTimeRange}`,
    `delivered timeline window ${segment.outputTimeRange}`,
    `map reference evidence one-to-one to local 0.0-${evidenceEnd}s`,
    hasPadding
      ? `local ${evidenceEnd}-${segment.outputDuration.toFixed(3)}s is an outgoing end-state hold; do not borrow the next reference shot`
      : "the reference evidence fills the full local task",
    "keep the complete local task in the final delivery",
  ].join(", ");
}

function numericSceneCuts(value: unknown) {
  return Array.isArray(value)
    ? value.map(Number).filter((time) => Number.isFinite(time) && time > 0)
    : [];
}

function voiceoverRewriteSlotsPrompt(
  allocations: VoiceoverTaskAllocation[],
  sourcePhrases: TimestampedVoiceoverPhrase[],
  mode: DirectorVoiceoverMode,
) {
  if (sourcePhrases.length === 0) return "No Mandarin spoken lines are available. Return empty rewritten voiceover fields and add no dialogue.";
  const phraseIndexByTimeRange = new Map(
    sourcePhrases.map((phrase, index) => [phrase.sourceTimeRange, index + 1]),
  );
  const instruction = mode === "use_exact"
    ? "copy the original Mandarin line exactly"
    : "rewrite the original into one current-product-safe Mandarin line for the same speaking slot";
  return allocations.map((allocation) => [
    `Task ${allocation.segmentIndex}, local 0.0-${allocation.outputDuration.toFixed(1)}s:`,
    ...allocation.phrases.map((phrase) =>
      `- phraseIndex ${phraseIndexByTimeRange.get(phrase.sourceTimeRange) || 0}; local ${phrase.localStart.toFixed(1)}-${phrase.localEnd.toFixed(1)}s; source ${phrase.sourceTimeRange}; original “${phrase.text}”; ${instruction}; use no more than ${directorVoiceoverCharacterLimit(phrase)} spoken Chinese characters.`,
    ),
    allocation.pauseDuration > 0.05
      ? `- keep ${allocation.pauseDuration.toFixed(1)}s for natural breath, visible action, or nonverbal continuation; do not add words.`
      : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}

function buildPrompt(input: {
  analysisText: string;
  voiceoverSourceText: string;
  voiceoverMode: DirectorVoiceoverMode;
  sourceVoiceoverPhrases: TimestampedVoiceoverPhrase[];
  targetDuration: number;
  segments: VideoShotSegmentPlan[];
  generationSeconds: number;
  resolution: string;
  aspectRatio: string;
  voiceoverTaskAllocation: VoiceoverTaskAllocation[];
  evidenceCoverage: DirectorSegmentEvidenceCoverage[];
  editorialTimingLocks: DirectorSegmentEditorialTimingLock[];
  directorPreference?: string;
  transportRepairAttempt?: boolean;
}) {
  const segmentLines = input.segments.length
    ? input.segments.map(formatSegmentLine).join("\n")
    : `Task 1: reference evidence window 00:00-00:${String(input.generationSeconds).padStart(2, "0")}, local task clock 0.0-${input.generationSeconds}.0s, keep the complete local task in the final delivery`;

  return [
    `Create the latest English director plan from ${input.targetDuration} seconds of reference evidence. The delivered video keeps every complete listed task: write the full-video master in the delivered timeline shown in SEGMENT PLAN, so a padded end-state hold remains in its current task and the following hard-cut entry begins at the next task's delivery start. Make one full-video master plan and one executable English prompt for every task.`,
    "DIRECTOR SHOT SPECIFICATION is the sole authority for camera, framing, subject placement, pose, action, hand contact, gaze, expression, mouth state, lighting, exposure, atmosphere, timing, and transition. Reproduce the reference video shot for shot while replacing only the source person and product during later execution.",
    "Use every supplied evidence field as binding. When a field says not observable, preserve that uncertainty; never invent a substitute or overwrite a precise value with generic wording such as cinematic, natural, premium, or emotional.",
    "EVIDENCE COVERAGE CONTRACT is server-owned. In each segment promptEnglish, use every listed [SHOT_*] marker exactly once, only immediately before a complete evidence-derived execution sentence in its mapped heading. A marker may not be a coverage list, stand alone, or precede generic wording. These are temporary server-only validation tokens: the server removes them before saving the director prompt or sending it to a video model. Never use them in fullDirectorPromptEnglish or invent another bracketed evidence id.",
    "For each task, conflictResolution must state 'none' when no conflict exists, or name the conflicting facts and the winning authority. Evidence and uncertainty markers outrank the optional director preference; the preference may choose only among alternatives the evidence leaves open.",
    "The reference analysis is one global execution summary plus cut-aligned timeline rows. Each row is binding for its own time range: preserve visualState, ordered actionSequence, boundary, productContact and reproductionRisks. Overview rules are global and must not be weakened or rewritten as per-shot guesses.",
    "Each timeline boundary is authoritative at its edit. Treat a hard cut as an instantaneous state discontinuity: keep exitEvidence unchanged until the server-owned cut and begin the next row already in entryEvidence. Never animate, zoom, turn, release, reach, change contact, or change gaze between those states. A sample listed in samplingConflict belongs only to the visually matching side of the cut.",
    "productContact is authoritative for hands. Preserve each T# contactTargets definition, the per-cell limbObservations states and target ids, actionSequence.contactLimbIds/contactTargetIds, motion path, evidence-scaled amplitude, and each contact-cycle ledger item's exact count, limbIds, contactTargetIds and order. A cell can prove several visible hands at once: preserve every listed L# and its T# mapping; never collapse bilateral contact to one hand. A contact cycle is one continuous active limb-target combination: end it when that combination changes or becomes open/no-contact/unobservable; an unknown observation for another limb does not erase a separately visible active contact. Later contact is a new cycle even within the same task; preserve its evidence order and never assign it an earlier cycle label. Each T# is one distinct target and may not be described as shared with, identical to, or substituted for another T#. Never reduce a T# target to lower area, lower side, side area, around the hips, or another generic body-space phrase.",
    "Use productContact.limbAndOcclusionEvidence and non-anatomical L# continuity ids literally. A visible shoulder-to-forearm-to-hand chain keeps the same L# id even when it crosses the torso; do not create an opposite-hand grip, sleeve gather, rub, pinch, pull, or second contact when the report says that hand or contact is occluded or unproved.",
    "A source transcript or audio-imitation field is non-visual authority. It may describe speech timing and reusable delivery order only. Never use its wording or semantics to infer, alter, or override camera, framing, pose, action, product contact, gaze, expression, lighting, environment, transition, visible shot purpose, or end state; those picture facts come only from the structured visual evidence fields and timeline rows.",
    "Treat visualState.framingAndCamera as a visible image-axis and perspective target, not a measured camera setup. Never convert an apparent near-level, upward, or downward relationship into a definite physical camera height, distance, or focal length when the report marks those values unobservable.",
    "Write only the directing and performance specification. Do not mention providers, API fields, reference-image numbers, reference-image counts, or transport modes; the execution layer attaches the fixed current visual references separately.",
    "The execution request already owns seconds, resolution, aspect ratio, and canvas orientation. Do not repeat those values in a segment prompt, especially not inside IMPORTANT. IMPORTANT may state only evidenced cut times or other shot constraints that are not request fields.",
    "Within one task, define each T# target once in PRODUCT CONSISTENCY LOCK and refer to it only by that existing id in later headings; keep distinct targets distinct and do not alias, share, merge, or substitute T1 and T2. Do not duplicate the same T# definition or restate its full description.",
    "NEGATIVE CONSTRAINTS are local to this task and its time intervals. State a prohibition only while its evidence applies; never write a global ban that contradicts a later evidenced state, such as banning L1/L2 contact for the whole task when a later interval requires bilateral contact.",
    "The reference video proves only demonstration mechanics: contact locations, proof purpose, timing, body direction, framing, and visible action sequence. This director does not receive the current product image. Inside PRODUCT CONSISTENCY LOCK, never describe the reference video's garment construction, material, color, pattern, trim, label, logo, decoration, sleeve, hem, opening, closure, panel, back design, or styling as a fact about the current product. State only the required proof action and require the later execution task to derive every visible product attribute exclusively from its attached current product image. Adapt contact only as the real product structure requires; do not invent an unseen feature or styling layer.",
    "If a source action conflicts with the replacement product's real structure, preserve the source shot purpose, timing, camera, figure placement, body direction, and action logic while adapting only the minimum hand contact or local pose required by the real product.",
    "Inside CINEMATIC MOTION, map visualState.bodyGazeAndExpression, actionSequence including its L#/T# mappings, and productContact.motionPathAndAmplitude/contactEvidenceLedger/contactCycleLedger into a timed visible state, exact product contact path and amplitude, every separately proved release/open/re-contact cycle, and stable exit state. Do not collapse two ledger items into one longer hold, drop a listed hand or target, skip their intervening open/neutral state, or switch an uninterrupted L# limb to a different hand.",
    input.voiceoverMode === "rewrite_reference"
      ? "Rewrite every source Mandarin phrase one-for-one into a new Mandarin product voiceover. Preserve phraseIndex, sourceTimeRange, sentence order, selling-logic order, approximate spoken length, and natural duration. Each rewritten line must retain the original line's concrete selling job: hook, visual proof, audience relevance, presenter bridge, silhouette observation, proof payoff, selection cue, audience qualifier, desired impression, detail cue, or concise close. Change the wording, but never copy source-specific product attributes, pattern, material, measurements, body claims, or benefits into the current product. Because the current product image is attached only later, use neutral product-safe wording and do not invent any current-product fact. Do not turn several consecutive lines into vague placeholders such as 'overall effect', 'overall feeling', or 'detail presentation'; name the evidenced viewing angle, visible area, action purpose, or wearing observation instead."
      : input.voiceoverMode === "use_exact"
        ? "The user supplied the current-product Mandarin voiceover. Preserve every supplied line exactly; do not rewrite, shorten, expand, correct, or reorder it."
      : "There is no Mandarin voiceover source. Return an empty rewrittenVoiceoverPhrases array and add no dialogue.",
    "VOICEOVER REWRITE SLOTS below are mandatory and already account for natural speaking duration. Return rewrittenVoiceoverPhrases strictly in the listed order; every entry contains only its new Mandarin spokenLine. The server attaches time slots and indices. In every task's AUDIO AND TEXT section, quote exactly and only the final Mandarin spokenLine values allocated to that task, in listed order and local slots. Do not move, duplicate, shorten, paraphrase again, speed up, or add dialogue.",
    "Whenever a task has Mandarin dialogue, AUDIO AND TEXT must direct audible Mandarin speech with natural, intelligible articulation and visible mouth movements synchronized to the exact spoken words and local timing. The model speaks the line; it must not render subtitles, captions, labels, or any other on-screen text. When no line is allocated, require no speech and no speech-like mouth motion.",
    `Each final segment promptEnglish, after the server removes its temporary [SHOT_*] markers, must be ${SEGMENT_DIRECTOR_UTF8_BYTE_LIMIT} UTF-8 bytes or fewer including headings. This total byte cap overrides every suggestion. Use exactly these plain all-caps headings in this order and exact HEADING: form: IMPORTANT; SHOT PURPOSE; CINEMATIC MOTION; CAMERA DIRECTION; LIGHTING AND TEXTURE; PRODUCT CONSISTENCY LOCK; CONTINUITY; TRANSITION INTENT; AUDIO AND TEXT; NEGATIVE CONSTRAINTS. Do not number, markdown-format, rename, omit, duplicate, or add headings. Use terse English clauses, no rationale, recap, preamble, or descriptive flourish. Excluding headings and exact quoted Mandarin, use no more than ${SEGMENT_DIRECTOR_WORD_TARGET} English words. A fact belongs in one heading only: IMPORTANT has task-specific timing or cut constraints; SHOT PURPOSE has the proof goal; CINEMATIC MOTION has ordered time, action, pose, gaze, L#/T# mapping, contact path, release/re-contact and exit state; CAMERA DIRECTION has framing or camera movement only; LIGHTING AND TEXTURE has visible light or environment only; PRODUCT CONSISTENCY LOCK has distinct T# definitions and the source-product boundary only; CONTINUITY has entry/exit handoff only; TRANSITION INTENT has cut behavior only; AUDIO AND TEXT has exact assigned speech and mouth timing only; NEGATIVE CONSTRAINTS has only task-unique risks. Keep each heading to one compact sentence or semicolon-separated clause; target approximately IMPORTANT 15 words; SHOT PURPOSE 12; CINEMATIC MOTION 45; CAMERA DIRECTION 18; LIGHTING AND TEXTURE 14; PRODUCT CONSISTENCY LOCK 24; CONTINUITY 14; TRANSITION INTENT 12; AUDIO AND TEXT 18 plus exact quoted Mandarin; NEGATIVE CONSTRAINTS 14. Leave room for the exact quoted Mandarin lines in AUDIO AND TEXT. If a heading has no task-specific fact, write one short evidence-grounded clause instead of repeating another heading.`,
    "Within CINEMATIC MOTION, carry the observed pose, hand position, gaze path, eyes, mouth and expression from visualState.bodyGazeAndExpression once, alongside the ordered action and contact evidence. Coordinate facial and mouth changes with the evidenced action or spoken beat instead of replacing them with a generic expression.",
    "Inside PRODUCT CONSISTENCY LOCK, define each active T# target once before any screen-side or body-height locator, preserve distinct target ids exactly, and preserve overview.sourceProductTransferBoundary; do not repeat motion, contact paths, or state changes there. Inside CONTINUITY, state only boundary.entryEvidence and exitEvidence handoff states. A separately generated next task never inherits this state: it starts only from its own row's entryEvidence at a hard cut.",
    "Inside CAMERA DIRECTION, map visualState.framingAndCamera. Inside LIGHTING AND TEXTURE, map visualState.lightAndEnvironment. These compact fields contain execution facts, not generic style adjectives.",
    "Inside TRANSITION INTENT, map boundary.entryEvidence, exitEvidence, crossCutRule and samplingConflict into executable cut behavior without cross-cut interpolation; do not restate the states. Inside NEGATIVE CONSTRAINTS, state only task-unique risks from productContact.limbAndOcclusionEvidence/excludedTargetsOrInferences and the row's concrete reproductionRisks, such as wrong garment region, invented second-hand contact, enlarged amplitude, recentering, face-light drift, or lost product proof. Do not repeat generic platform restrictions or motion already specified elsewhere.",
    "SHOT PURPOSE must be evidence-grounded. Do not infer seasonal recommendation, sales claim, body-shaping claim, product benefit, or any other marketing meaning unless it is explicitly observable or spoken in the supplied evidence.",
    "Each task covers one continuous reference-timeline window. This delivery-timeline rule applies to both the full master and its segment prompts: when a full model task extends beyond its assigned evidence window, keep that task's final evidenced state through the delivery end and do not describe the next hard cut inside the padded tail; the next task starts at its own delivery start from its mapped hard-cut entry state. Reproduce every evidenced cut, camera change, scene change, and action transition inside the assigned window at the correct local task time. Do not add a cut that is absent from the reference evidence.",
    "The server will attach an EDIT TIMING LOCK to each final generation request. Its interval boundaries are mandatory: retain the current reference shot's framing and camera progression within each interval, and perform no discrete edit, jump zoom, abrupt crop, coverage switch, or early entry into a later reference shot between boundaries.",
    `Use a local 0.0-${input.generationSeconds}.0s clock inside every task prompt. Convert the assigned global reference timestamps one-to-one into that local task clock; never slow, stretch, redistribute, or move an evidenced action to fill unused task time. Every task is delivered in full. If the assigned evidence ends before the full task, preserve the last observed end state for the remaining local time with only imperceptible natural stillness: no new cut, reach, contact, release, gesture cycle, claim, dialogue, or post-evidence action. The next independently generated task begins from its own hard-cut entry state, never from a presumed inherited frame.`,
    "Do not repeat the full master plan inside each segment. Remove only cross-heading repetition; retain every distinct visible action, product boundary, spoken phrase, timing fact, continuity handoff, and task-unique concrete risk needed for this segment.",
    input.transportRepairAttempt
      ? `A prior draft did not pass automated draft validation. Regenerate every segment with every required heading complete and ending in a complete English sentence. Preserve every distinct evidenced action, timing, product boundary, continuity handoff, spoken line, and task-unique risk, but delete any fact repeated across headings. Prefer compact ids and semicolon clauses over explanatory prose. Keep English directing prose to 165 words or fewer and aim for ${SEGMENT_DIRECTOR_RETRY_TARGET} UTF-8 bytes per segment so the video request has transport headroom.`
      : "",
    "Return STRICT JSON only. All JSON property values must be English except rewrittenVoiceoverPhrases.spokenLine and the identical quoted Mandarin lines inside AUDIO AND TEXT.",
    "Return the segment objects in SEGMENT PLAN order. The server, not the model, owns task number, source time range, delivered time range, duration, evidence coverage, phrase indices, and phrase time slots.",
    JSON.stringify({
      fullDirectorPromptEnglish: "Compact English full-video director master plan; aim for about " + FULL_DIRECTOR_WORD_TARGET + " words.",
      rewrittenVoiceoverPhrases: input.sourceVoiceoverPhrases.map((phrase) => ({
        spokenLine: input.voiceoverMode === "use_exact" ? phrase.text : "该时间槽对应的仿写中文口播",
      })),
      segmentPrompts: [{
        promptEnglish: "Compact English executable segment prompt; aim for about " + SEGMENT_DIRECTOR_WORD_TARGET + " words and never exceed " + SEGMENT_DIRECTOR_UTF8_BYTE_LIMIT + " UTF-8 bytes, with the required headings and quoted Mandarin spoken words.",
        conflictResolution: "none, or a concise statement of the conflict and the winning authority",
      }],
    }, null, 2),
    "REFERENCE VIDEO SHOT SPECIFICATION:",
    input.analysisText,
    input.voiceoverSourceText
      ? `MANDARIN VOICEOVER SOURCE (${input.voiceoverMode}):\n${input.voiceoverSourceText}`
      : "",
    "VOICEOVER REWRITE SLOTS:",
    voiceoverRewriteSlotsPrompt(input.voiceoverTaskAllocation, input.sourceVoiceoverPhrases, input.voiceoverMode),
    "EVIDENCE COVERAGE CONTRACT:",
    input.evidenceCoverage
      .map((coverage) => [
        `Task ${coverage.segmentIndex}:`,
        ...coverage.manifestLines,
      ].join("\n"))
      .join("\n"),
    "SERVER-OWNED EDIT TIMING LOCKS:",
    input.editorialTimingLocks.map((lock) => `Task ${lock.segmentIndex}: ${lock.text}`).join("\n"),
    input.directorPreference
      ? "OPTIONAL DIRECTOR PREFERENCE (lowest authority; apply only where evidence is genuinely open and never override evidence, uncertainty, timing, dialogue, product boundaries, or execution protocol):\n" + input.directorPreference
      : "",
    "SEGMENT PLAN:",
    segmentLines,
  ].filter(Boolean).join("\n");
}

function quotedAudioLines(prompt: string) {
  const audioSection = prompt.match(/AUDIO AND TEXT:\s*([\s\S]*?)(?=\nNEGATIVE CONSTRAINTS:|$)/i)?.[1] || "";
  return Array.from(audioSection.matchAll(/[“\"]([^”\"]+)[”\"]/g), (match) => match[1].trim()).filter(Boolean);
}

function hasTargetAliasWording(prompt: string) {
  const productLock = prompt.match(/^PRODUCT CONSISTENCY LOCK:\s*(.*)$/im)?.[1] || "";
  return /\b(?:reuse|reused|shared with|same as|identical to|substitut(?:e|ed) for)\s+T\d+\b/i.test(productLock)
    || /\bT\d+\s+(?:is|as)\s+(?:the\s+)?same\s+as\s+T\d+\b/i.test(productLock);
}

function masterMentionsPaddedSourceCut(master: string, segments: VideoShotSegmentPlan[]) {
  return segments.some((segment, index) => {
    if (index === 0) return false;
    const previous = segments[index - 1];
    if (
      previous.outputDuration - previous.sourceDuration <= 0.001
      || Math.abs(segment.sourceStart - segment.start) <= 0.001
    ) return false;
    const timeForms = [...new Set([
      segment.sourceStart.toFixed(3),
      segment.sourceStart.toFixed(1),
      String(segment.sourceStart),
    ])];
    return timeForms.some((time) => {
      const escaped = time.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = master.matchAll(new RegExp(`\\b${escaped}\\s*(?:s|seconds?)?\\b`, "gi"));
      return Array.from(matches).some((match) => {
        const start = Math.max(0, (match.index || 0) - 80);
        const end = Math.min(master.length, (match.index || 0) + match[0].length + 80);
        return /\b(?:hard\s+)?cuts?\b/i.test(master.slice(start, end));
      });
    });
  });
}

class DirectorPromptTransportRetryError extends Error {
  constructor(segmentIndex: number, promptBytes: number) {
    super(`任务 ${segmentIndex} 的分段 Prompt 为 ${promptBytes} UTF-8 字节，超过 ${SEGMENT_DIRECTOR_UTF8_BYTE_LIMIT} 字节预算，需要自动重新生成。`);
    this.name = "DirectorPromptTransportRetryError";
  }
}

function validateDirectorPlan(
  parsed: DirectorPlan | null,
  segments: VideoShotSegmentPlan[],
  generationSeconds: number,
  voiceoverTaskAllocation: VoiceoverTaskAllocation[],
  evidenceCoverage: DirectorSegmentEvidenceCoverage[],
  editorialTimingLocks: DirectorSegmentEditorialTimingLock[],
) {
  if (!parsed?.fullDirectorPromptEnglish?.trim() || !Array.isArray(parsed.segmentPrompts) || parsed.segmentPrompts.length === 0) {
    throw new Error("LLM 未按英文完整导演稿结构返回结果，请重试。");
  }
  if (parsed.segmentPrompts.length !== segments.length) {
    throw new Error(`LLM 返回了 ${parsed.segmentPrompts.length} 个任务 Prompt，但当前计划严格需要 ${segments.length} 个。`);
  }
  if (parsed.segmentPrompts.some((segment) => !segment.promptEnglish?.trim())) {
    throw new Error("LLM 返回的分段导演稿缺少英文执行 Prompt，请重试。");
  }
  if (/\[SHOT_\d{2}_[A-Z0-9_]+\]/.test(parsed.fullDirectorPromptEnglish)) {
    throw new Error("LLM 将临时证据标记写入了完整导演稿；标记只能用于分段执行稿的服务端校验，请重试。");
  }
  if (masterMentionsPaddedSourceCut(parsed.fullDirectorPromptEnglish, segments)) {
    throw new Error("完整导演母稿把填充尾部的参考切点写成了实际交付切点，需要按 SEGMENT PLAN 的交付时间线重写。");
  }
  const normalizedSegmentPrompts = parsed.segmentPrompts.map((returned, offset) => {
    const expected = segments[offset];
    // The LLM writes creative direction, not scheduling data. It is easy for a
    // short final evidence window (for example 00:12-00:15) to be confused with
    // its full delivered task window (00:12-00:18). Persist all scheduling fields
    // from the server-owned plan so they can never drift from the actual request.
    const normalized = {
      ...returned,
      segmentIndex: expected.index,
      timeRange: expected.sourceTimeRange,
      outputTimeRange: expected.outputTimeRange,
      duration: generationSeconds,
    };
    return normalized;
  });
  for (const [offset, returned] of normalizedSegmentPrompts.entries()) {
    const expectedCoverage = evidenceCoverage.find((item) => item.segmentIndex === returned.segmentIndex);
    if (!expectedCoverage) {
      throw new Error(`任务 ${offset + 1} 缺少服务端证据覆盖计划。`);
    }
    // Coverage membership is deterministic from the verified report and
    // server-owned segment plan. Never make a model-generated audit list a
    // reason to reject an otherwise executable director prompt.
    returned.evidenceCoverageIds = [...expectedCoverage.evidenceIds];
    const timingLock = editorialTimingLocks.find((item) => item.segmentIndex === returned.segmentIndex);
    if (!timingLock) throw new Error(`Task ${offset + 1} is missing the server-owned editorial timing lock.`);
    returned.editorialTimingLock = timingLock.text;
    const headings = videoDirectorHeadings(returned.promptEnglish!);
    if (headings.length !== REQUIRED_VIDEO_DIRECTOR_HEADINGS.length || headings.some((heading, index) => heading !== REQUIRED_VIDEO_DIRECTOR_HEADINGS[index])) {
      throw new Error("LLM 返回的分段导演稿标题不符合固定执行结构，请重试。");
    }
    returned.promptEnglish = validateAndStripDirectorCoverageMarkers(returned.promptEnglish!, expectedCoverage);
    if (hasTargetAliasWording(returned.promptEnglish)) {
      throw new Error(`任务 ${offset + 1} 将不同 T# 目标写成别名或复用关系，需要保留各自独立的目标 id。`);
    }
    const promptBytes = Buffer.byteLength(returned.promptEnglish, "utf8");
    if (promptBytes > SEGMENT_DIRECTOR_UTF8_BYTE_LIMIT) {
      throw new DirectorPromptTransportRetryError(returned.segmentIndex!, promptBytes);
    }
    const expectedSpokenLines = voiceoverTaskAllocation.find((allocation) => allocation.segmentIndex === returned.segmentIndex)?.phrases.map((phrase) => phrase.text) || [];
    const actualSpokenLines = quotedAudioLines(returned.promptEnglish!);
    if (expectedSpokenLines.length > 0 && JSON.stringify(actualSpokenLines) !== JSON.stringify(expectedSpokenLines)) {
      throw new Error(`LLM 返回的任务 ${offset + 1} 口播没有严格按本次自然时长分配表编排，请重试。`);
    }
    if (expectedSpokenLines.length === 0 && actualSpokenLines.length > 0) {
      throw new Error(`LLM 为任务 ${offset + 1} 添加了未分配口播，请重试。`);
    }
    if (!returned.conflictResolution?.trim()) {
      throw new Error(`LLM 返回的任务 ${offset + 1} 缺少冲突处理结论。`);
    }
  }
  const normalizedPlan: DirectorPlan = {
    ...parsed,
    segmentPrompts: normalizedSegmentPrompts,
  };
  const channelSpecificPattern = channelSpecificDirectorText([
    normalizedPlan.fullDirectorPromptEnglish,
    ...normalizedSegmentPrompts.map((segment) => segment.promptEnglish || ""),
  ].join("\n"));
  if (channelSpecificPattern) {
    throw new Error("LLM 返回的导演稿包含模型或参考图通道专属内容，请重新生成。");
  }
  return normalizedPlan;
}

function formatEnglishPrompt(parsed: DirectorPlan, rawText: string) {
  const segments = (parsed.segmentPrompts || [])
    .map((segment) => [
      "Segment " + (segment.segmentIndex || "")
        + " evidence " + (segment.timeRange || "")
        + " → delivery " + (segment.outputTimeRange || ""),
      segment.promptEnglish || "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  return [
    "FULL VIDEO DIRECTOR MASTER",
    parsed.fullDirectorPromptEnglish || rawText,
    parsed.rewrittenVoiceoverChinese
      ? "REWRITTEN MANDARIN VOICEOVER\n" + parsed.rewrittenVoiceoverChinese
      : "",
    segments ? "SEGMENT EXECUTION PROMPTS\n" + segments : "",
  ].filter(Boolean).join("\n\n").trim();
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let inputNodeIds: string[] = [];
  let clientTaskId = "";
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const user = access.user;
    workflowId = id;
    const workflow = access.workflow;
    if (!workflow) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });

    const body = await req.json();
    clientTaskId = String(body.clientTaskId || "");
    executorNodeId = String(body.executorNodeId || "");
    const llm = await resolveLLMSetting(req);
    const directorPreference = String(body.directorPreference || "").trim();
    const durationSource: BoardVideoDurationSource = body.durationSource === "reference_video" ? "reference_video" : "manual";
    const requestedManualDuration = Number(body.targetDuration || 20);
    const videoChannelId = String(body.videoChannelId || "").trim();
    let targetDuration = normalizedBoardVideoTargetDuration(requestedManualDuration);
    let sourceEvidenceDuration = targetDuration;
    let videoModel = String(body.videoModel || "").trim();
    let videoProfile: ReturnType<typeof getBoardVideoProfile> = null;
    let segments: VideoShotSegmentPlan[] = [];

    if (!llm?.baseUrl || !llm.apiKey || !llm.model) {
      return NextResponse.json({ error: "请先配置可用的 LLM。" }, { status: 400 });
    }

    const {
      directInputIds,
      analysisNode,
      voiceoverNode,
    } = selectManualDirectorInputs(workflow, executorNodeId);
    if (Number(analysisNode.meta?.analysisSchemaVersion || 0) !== REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION) {
      throw new Error("当前参考视频拆解报告不是最新结构，请重新转写音频并重新拆解参考视频后再生成完整导演稿。");
    }
    if (!videoChannelId) throw new Error("请先选择视频模型通道，再生成完整视频导演稿。");
    const videoChannel = await resolveVideoChannel(req, undefined, videoChannelId, "full_video");
    if (!videoChannel || videoChannel.id !== videoChannelId) {
      throw new Error("当前视频模型通道不可用，请在模型池检查后重新选择。");
    }
    videoModel = videoChannel.model;
    videoProfile = getBoardVideoProfile(videoChannel);
    if (!videoProfile) {
      throw new Error("当前视频模型没有有效的单任务可用时长，请先在视频模型池填写该模型支持的秒数。");
    }
    if (durationSource === "reference_video") {
      const evidenceDuration = referenceEvidenceDurationForAnalysis(workflow.nodes, analysisNode);
      if (evidenceDuration === null) {
        throw new Error("当前拆解报告没有可用的参考视频证据时长，请选择人工输入，或重新抽帧并拆解参考视频。");
      }
      sourceEvidenceDuration = evidenceDuration;
      targetDuration = normalizedBoardVideoTargetDuration(referenceTargetDurationSeconds(evidenceDuration));
    }
    segments = splitTargetDurationIntoVideoSegments(
      targetDuration,
      videoProfile.generationSeconds,
      numericSceneCuts(analysisNode.meta?.sceneCutTimes),
      sourceEvidenceDuration,
    );
    const analysisText = completeReferenceAnalysisJson(analysisNode.meta?.parsed);
    const evidenceCoverage = buildDirectorEvidenceCoverage(analysisNode.meta?.parsed, segments);
    const editorialTimingLocks = buildDirectorSegmentEditorialTimingLocks(analysisNode.meta?.parsed, segments);
    const voiceoverSourceText = voiceoverNode
      ? timestampedVoiceoverTextForNode(voiceoverNode)
      : referenceMandarinTranscript(workflow, analysisNode);
    if (voiceoverSourceText) assertCleanTranscriptText(voiceoverSourceText, "中文口播");
    const voiceoverMode: DirectorVoiceoverMode = voiceoverNode
      ? "use_exact"
      : voiceoverSourceText
        ? "rewrite_reference"
        : "none";
    const sourceVoiceoverPhrases = parseTimestampedVoiceoverPhrases(voiceoverSourceText);
    if (voiceoverSourceText && sourceVoiceoverPhrases.length === 0) {
      throw new Error("中文口播缺少可解析的时间码分句，无法在不截断、不乱序的前提下分配到视频任务。请重新执行中文转写或口播生成。");
    }
    const sourceVoiceoverTaskAllocation = allocateVoiceoverPhrases(segments, sourceVoiceoverPhrases);

    inputNodeIds = uniqueNodeIds(directInputIds);
    await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);

    let rawText = "";
    let rewrittenVoiceover: ReturnType<typeof validateDirectorVoiceoverRewrite> | null = null;
    let voiceoverTaskAllocation: VoiceoverTaskAllocation[] = [];
    let parsed: DirectorPlan | null = null;
    let lastDraftValidationError: Error | null = null;
    for (let attempt = 0; attempt < DIRECTOR_GENERATION_ATTEMPTS; attempt += 1) {
      const prompt = buildPrompt({
        analysisText,
        voiceoverSourceText,
        voiceoverMode,
        sourceVoiceoverPhrases,
        targetDuration,
        segments,
        generationSeconds: videoProfile.generationSeconds,
        resolution: videoProfile.resolution,
        aspectRatio: videoProfile.aspectRatio,
        voiceoverTaskAllocation: sourceVoiceoverTaskAllocation,
        evidenceCoverage,
        editorialTimingLocks,
        directorPreference,
        transportRepairAttempt: attempt > 0,
      });
      const payload = await auditModelApiCall({
        userId: user.id,
        callType: "llm",
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        model: llm.model,
        source: "board.director.generate",
        boardWorkflowId: id,
        boardNodeId: executorNodeId,
      }, () => postOpenAiChatJsonWithLongTimeout(endpoint(llm.baseUrl, "/chat/completions"), {
        model: llm.model,
        messages: [{
          role: "user",
          content: prompt,
        }],
        temperature: attempt > 0 ? 0.15 : 0.25,
        max_tokens: Math.min(6800, 1000 + segments.length * 900),
        response_format: directorResponseFormat(segments.length, sourceVoiceoverPhrases.length),
      }, {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "daihuo-jianshou/1.0",
      }, DIRECTOR_LLM_TIMEOUT_MS), {
        toResult: (result) => ({ httpStatus: result.status }),
        toError: (result) => result.ok ? undefined : { errorCode: "API_ERROR" },
      });

      if (!payload.ok) throw new Error(extractLongJsonError(payload));
      rawText = extractText(payload.payload).trim();
      if (!rawText) throw new Error("LLM 没有返回导演稿。");
      try {
        const draft = extractJson(rawText);
        const candidateVoiceover = validateDirectorVoiceoverRewrite(
          draft?.rewrittenVoiceoverChinese,
          draft?.rewrittenVoiceoverPhrases,
          sourceVoiceoverPhrases,
          voiceoverMode,
        );
        const candidateAllocation = allocateVoiceoverPhrases(segments, candidateVoiceover.phrases);
        const candidatePlan = validateDirectorPlan(
          draft,
          segments,
          videoProfile.generationSeconds,
          candidateAllocation,
          evidenceCoverage,
          editorialTimingLocks,
        );
        candidatePlan.rewrittenVoiceoverChinese = candidateVoiceover.fullText;
        candidatePlan.rewrittenVoiceoverPhrases = candidateVoiceover.phrases.map((phrase, index) => ({
          phraseIndex: index + 1,
          sourceTimeRange: phrase.sourceTimeRange,
          spokenLine: phrase.text,
        }));
        rewrittenVoiceover = candidateVoiceover;
        voiceoverTaskAllocation = candidateAllocation;
        parsed = candidatePlan;
        break;
      } catch (error) {
        if (error instanceof Error && attempt + 1 < DIRECTOR_GENERATION_ATTEMPTS) {
          lastDraftValidationError = error;
          continue;
        }
        throw error;
      }
    }
    if (!parsed || !rewrittenVoiceover) {
      throw lastDraftValidationError || new Error("完整导演稿未能生成可用于视频任务的完整执行稿。");
    }
    const latestWorkflow = await getBoardWorkflow(id, user.id) || workflow;
    if (
      isBoardTaskCancelled(id, clientTaskId) ||
      (executorNodeId && isNodeExecutionCancelled(latestWorkflow, executorNodeId))
    ) {
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }
    const replaceableNodes = latestWorkflow.nodes
      .filter((node) => node.kind === "prompt" && String(node.meta?.assetRole || "") === "video_director_prompt");
    const replacedNodeIds = new Set(replaceableNodes.map((node) => node.id));
    const previousDirectorNode = replaceableNodes.at(-1);
    const executorNode = latestWorkflow.nodes.find((node) => node.id === executorNodeId);
    const outputPosition = generatedOutputPosition({
      nodes: latestWorkflow.nodes,
      anchor: executorNode,
      outputKind: "prompt",
      outputRole: "video_director_prompt",
      previousOutput: previousDirectorNode,
      excludedNodeIds: replacedNodeIds,
    });
    const directorNode = createNode({
      kind: "prompt",
      title: "完整视频导演稿",
      description: "仅根据参考视频拆解和可选口播生成的英文完整导演稿；单镜头图片只在视频任务中发送。",
      promptEnglish: formatEnglishPrompt(parsed, rawText),
      meta: {
        assetRole: "video_director_prompt",
        rawText,
        parsed,
        targetDuration,
        plannedOutputDuration: segments[0]?.plannedOutputDuration || targetDuration,
        videoDurationSource: durationSource,
        videoChannelId: videoChannel.id,
        videoModel,
        videoDurationOptions: videoProfile.durationOptions,
        videoGenerationSeconds: videoProfile.generationSeconds,
        videoCapabilitySignature: videoProfile.capabilitySignature,
        aspectRatio: videoProfile.aspectRatio,
        resolution: videoProfile.resolution,
        segmentPlan: segments,
        directorSchemaVersion: VIDEO_DIRECTOR_SCHEMA_VERSION,
        analysisNodeId: analysisNode.id,
        analysisSchemaVersion: REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION,
        analysisInputMode: "complete-structured-json",
        analysisInputChars: analysisText.length,
        voiceoverNodeId: voiceoverNode?.id || "",
        voiceoverMode,
        voiceoverSourceText,
        rewrittenVoiceoverChinese: rewrittenVoiceover.fullText,
        rewrittenVoiceoverPhrases: rewrittenVoiceover.phrases,
        voiceoverTaskAllocation,
        evidenceCoverage,
        directorPreference,
        manualInputNodeIds: directInputIds,
      },
      x: outputPosition.x,
      y: outputPosition.y,
    });

    const retainedNodes = latestWorkflow.nodes.filter((node) => !replacedNodeIds.has(node.id));
    const retainedEdges = latestWorkflow.edges.filter((edge) => !replacedNodeIds.has(edge.from) && !replacedNodeIds.has(edge.to));
    const newEdges = [
      createEdge(analysisNode.id, directorNode.id, "method analysis"),
      ...(voiceoverNode ? [createEdge(voiceoverNode.id, directorNode.id, "voiceover")] : []),
      ...(executorNodeId ? [createEdge(executorNodeId, directorNode.id, "node execution output")] : []),
    ];

    const next = await updateBoardWorkflow(id, {
      status: "analyzed",
      nodes: [...retainedNodes, directorNode],
      edges: [...retainedEdges, ...newEdges],
    }, latestWorkflow.revision ?? 0);
    let finalWorkflow = executorNodeId
      ? await finishNodeExecution(id, executorNodeId, inputNodeIds, [directorNode.id], "完整导演稿已生成") || next
      : next;
    if (!finalWorkflow.nodes.some((node) => node.id === directorNode.id)) {
      const currentWorkflow = await getBoardWorkflow(id, user.id) || finalWorkflow;
      const currentNodeIds = new Set(currentWorkflow.nodes.map((node) => node.id));
      const currentEdgeIds = new Set(currentWorkflow.edges.map((edge) => edge.id));
      const missingEdges = newEdges.filter((edge) => !currentEdgeIds.has(edge.id));
      finalWorkflow = await updateBoardWorkflow(id, {
        status: "analyzed",
        nodes: currentNodeIds.has(directorNode.id) ? currentWorkflow.nodes : [...currentWorkflow.nodes, directorNode],
        edges: [...currentWorkflow.edges, ...missingEdges],
      }, currentWorkflow.revision ?? 0);
      if (executorNodeId) {
        finalWorkflow = await finishNodeExecution(id, executorNodeId, inputNodeIds, [directorNode.id], "完整导演稿已生成") || finalWorkflow;
      }
    }
    clearBoardTaskCancellation(id, clientTaskId);

    return NextResponse.json({ workflow: finalWorkflow, parsed });
  } catch (error) {
    console.error("board director failed:", error);
    let failedWorkflow: BoardWorkflow | null = null;
    if (workflowId && executorNodeId) {
      failedWorkflow = await failNodeExecution(
        workflowId,
        executorNodeId,
        inputNodeIds,
        error instanceof Error ? error.message : "完整导演稿生成失败",
      ).catch(() => null);
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "完整视频导演稿生成失败",
        workflow: failedWorkflow,
      },
      { status: 500 }
    );
  }
}

