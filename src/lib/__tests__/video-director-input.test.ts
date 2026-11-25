import { describe, expect, it } from "vitest";
import {
  assertCleanTranscriptText,
  completeReferenceAnalysisJson,
  formatReferenceVideoAnalysis,
  REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION,
  transcriptEncodingIssue,
  type ReferenceAnalysisValidationContext,
  type ReferenceVideoAnalysis,
} from "@/lib/video-director-input";

function evidenceContext(
  evidenceDurationSeconds: number,
  sceneCutTimes: number[] = [],
): ReferenceAnalysisValidationContext {
  return {
    evidenceDurationSeconds,
    sceneCutTimes,
    detailIntervalSeconds: 1,
    evidenceCells: Array.from({ length: Math.ceil(evidenceDurationSeconds) }, (_, index) => ({
      sequence: `S${String(index + 1).padStart(2, "0")}`,
      timeSeconds: index,
    })),
  };
}

function completeAnalysis(): ReferenceVideoAnalysis {
  return {
    overview: {
      formatAndPacing: "Three hard-cut product-proof states with an even, short-form rhythm.",
      visualBaseline: "Natural outdoor light, stable subject placement and restrained handheld texture.",
      sourceProductTransferBoundary: "Reuse only compatible demonstration mechanics; source appearance never transfers.",
    },
    timeline: [{
      storyboardRange: "S01-S03",
      timeRange: "00:00:00-00:00:03",
      visualState: {
        framingAndCamera: "Stable full-body side view with the subject held in the right half of frame.",
        bodyGazeAndExpression: "Profile stance, one hand at the upper-garment side hem, gaze moves from garment to lens.",
        lightAndEnvironment: "Soft natural side light, foliage background and modest phone-video texture.",
      },
      boundary: {
        entryEvidence: "S01: profile full body and hand already at the upper-garment side hem.",
        exitEvidence: "S03: same profile state and same contact immediately before the cut.",
        crossCutRule: "Hard cut: retain the outgoing profile state until 3.000s; do not interpolate toward the next framing.",
        samplingConflict: "none",
      },
      actionSequence: [{
        timeRange: "00:00:00-00:00:03",
        evidenceCells: ["S01", "S02", "S03"],
        contactLimbIds: ["L1"],
        contactTargetIds: ["T1"],
        event: "Maintain the upper-garment side-hem contact while the gaze settles from garment to lens.",
        evidenceStatus: "observed",
      }],
      productContact: {
        contactTargets: [{
          targetId: "T1",
          description: "current upper garment's visible side hem at waist/hip height",
        }],
        motionPathAndAmplitude: "one hand stays at the side hem with only a small presentation adjustment",
        contactEvidenceLedger: [
          { evidenceCell: "S01", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
          { evidenceCell: "S02", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
          { evidenceCell: "S03", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
        ],
        contactCycleLedger: [{
          cycleIndex: 1,
          limbIds: ["L1"],
          contactTargetIds: ["T1"],
          evidenceCells: ["S01", "S02", "S03"],
        }],
        limbAndOcclusionEvidence: "One visible arm-to-hand chain; no second-hand contact is proved.",
        excludedTargetsOrInferences: "Do not move contact to trousers, waistband, legs or empty lower body space.",
        evidenceStatus: "observed",
      },
      reproductionRisks: "Do not release, recenter or push in before the hard cut.",
    }],
    audioImitation: {
      narrativeStructure: "opening hook, proof beat and concise close",
      deliveryRhythm: "short phrases with one natural pause",
      visualSyncPattern: "Speech timing may align to visible proof beats but never creates visual facts.",
    },
    uncertainties: [],
  };
}

function twoSegmentAnalysis() {
  const source = completeAnalysis();
  source.timeline = [
    {
      ...source.timeline[0],
      timeRange: "00:00:00-00:00:02",
      actionSequence: [{
        timeRange: "00:00:00-00:00:02",
        evidenceCells: ["S01", "S02"],
        contactLimbIds: ["L1"],
        contactTargetIds: ["T1"],
        event: "Maintain the upper-garment side-hem contact until the cut.",
        evidenceStatus: "observed",
      }],
      productContact: {
        ...source.timeline[0].productContact,
        contactEvidenceLedger: [
          { evidenceCell: "S01", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
          { evidenceCell: "S02", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
        ],
        contactCycleLedger: [{ cycleIndex: 1, limbIds: ["L1"], contactTargetIds: ["T1"], evidenceCells: ["S01", "S02"] }],
      },
    },
    {
      ...source.timeline[0],
      storyboardRange: "S03-S04",
      timeRange: "00:00:02-00:00:04",
      boundary: {
        ...source.timeline[0].boundary,
        entryEvidence: "S03: incoming frontal medium-long composition already present at the cut.",
        exitEvidence: "S04: frontal composition remains before the effective end.",
      },
      actionSequence: [{
        timeRange: "00:00:02-00:00:04",
        evidenceCells: ["S03", "S04"],
        contactLimbIds: ["L1"],
        contactTargetIds: ["T1"],
        event: "Hold the incoming frontal presentation state.",
        evidenceStatus: "observed",
      }],
      productContact: {
        ...source.timeline[0].productContact,
        contactEvidenceLedger: [
          { evidenceCell: "S03", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
          { evidenceCell: "S04", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
        ],
        contactCycleLedger: [{ cycleIndex: 1, limbIds: ["L1"], contactTargetIds: ["T1"], evidenceCells: ["S03", "S04"] }],
      },
    },
  ];
  return source;
}

describe("reference-video execution summary", () => {
  it("uses the compact storyboard-led schema", () => {
    expect(REFERENCE_VIDEO_ANALYSIS_SCHEMA_VERSION).toBe(11);
    expect(() => completeReferenceAnalysisJson(completeAnalysis(), evidenceContext(3))).not.toThrow();
  });

  it("keeps evidence-derived shot purpose in existing overview and action fields", () => {
    const source = completeAnalysis();
    source.overview.formatAndPacing = "Opening establishes the visible profile; the proof action shows the side hem; the close ends on the same observable detail. No marketing claim is inferred.";
    source.timeline[0].actionSequence[0].event = "The visible hand maintains contact with T1 at the side hem, leaving the observable hem edge in view.";

    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).not.toThrow();
    const formatted = formatReferenceVideoAnalysis(source, "english");
    expect(formatted).toContain("Opening establishes the visible profile");
    expect(formatted).toContain("observable hem edge");
  });

  it("requires the timeline visual state rather than repeated photographic fields", () => {
    const source = completeAnalysis() as unknown as Record<string, unknown> & { timeline: Array<Record<string, unknown>> };
    delete source.timeline[0].visualState;
    expect(() => completeReferenceAnalysisJson(source)).toThrow("视觉状态");
  });

  it("matches supplied hard cuts with the continuous timeline", () => {
    expect(() => completeReferenceAnalysisJson(twoSegmentAnalysis(), evidenceContext(4, [2]))).not.toThrow();
  });

  it("rejects a timeline range that contradicts a program-detected cut", () => {
    const source = twoSegmentAnalysis();
    source.timeline[0].timeRange = "00:00:00-00:00:03";
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(4, [2]))).toThrow("程序检测切点");
  });

  it("rejects invented sub-evidence action timestamps", () => {
    const source = completeAnalysis();
    source.timeline[0].actionSequence[0].timeRange = "00:00:00.200-00:00:02.700";
    const context = { ...evidenceContext(3), detailIntervalSeconds: 0.5 };
    expect(() => completeReferenceAnalysisJson(source, context)).toThrow("虚构时间精度");
  });

  it("rejects overlapping action entries but permits an implicit hold between changed states", () => {
    const source = completeAnalysis();
    source.timeline[0].actionSequence = [
      { timeRange: "00:00:00-00:00:02", evidenceCells: ["S01", "S02"], contactLimbIds: ["L1"], contactTargetIds: ["T1"], event: "first state", evidenceStatus: "observed" },
      { timeRange: "00:00:01-00:00:03", evidenceCells: ["S02", "S03"], contactLimbIds: ["L1"], contactTargetIds: ["T1"], event: "overlap", evidenceStatus: "observed" },
    ];
    expect(() => completeReferenceAnalysisJson(source, {
      evidenceDurationSeconds: 3,
      sceneCutTimes: [],
      detailIntervalSeconds: 1,
    })).toThrow("时间重叠");

    source.timeline[0].actionSequence = [
      { timeRange: "00:00:00-00:00:01", evidenceCells: ["S01"], contactLimbIds: ["L1"], contactTargetIds: ["T1"], event: "first changed state", evidenceStatus: "observed" },
      { timeRange: "00:00:02-00:00:03", evidenceCells: ["S03"], contactLimbIds: ["L1"], contactTargetIds: ["T1"], event: "second changed state", evidenceStatus: "observed" },
    ];
    expect(() => completeReferenceAnalysisJson(source, {
      evidenceDurationSeconds: 3,
      sceneCutTimes: [],
      detailIntervalSeconds: 1,
    })).not.toThrow();
  });

  it("requires a structured contact evidence ledger", () => {
    const source = completeAnalysis() as unknown as Record<string, unknown> & { timeline: Array<Record<string, unknown>> };
    delete (source.timeline[0].productContact as Record<string, unknown>).contactEvidenceLedger;
    expect(() => completeReferenceAnalysisJson(source)).toThrow("contactEvidenceLedger");
  });

  it("requires proving evidence cells for every action entry", () => {
    const source = completeAnalysis() as unknown as Record<string, unknown> & { timeline: Array<Record<string, unknown>> };
    const action = ((source.timeline[0].actionSequence as Array<unknown>)[0]) as Record<string, unknown>;
    delete action.evidenceCells;
    expect(() => completeReferenceAnalysisJson(source)).toThrow("evidenceCells");
  });

  it("rejects unknown evidence labels and incomplete cell classification", () => {
    const unknown = completeAnalysis();
    unknown.timeline[0].actionSequence[0].evidenceCells = ["S01", "P999"];
    expect(() => completeReferenceAnalysisJson(unknown, evidenceContext(3))).toThrow("unknown evidence");

    const incomplete = completeAnalysis();
    incomplete.timeline[0].productContact.contactEvidenceLedger.pop();
    expect(() => completeReferenceAnalysisJson(incomplete, evidenceContext(3))).toThrow("contact cycle");
  });

  it("rejects repeated unknown placeholders in one evidence cell", () => {
    const source = completeAnalysis();
    source.timeline[0].productContact.contactEvidenceLedger[1] = {
      evidenceCell: "S02",
      limbObservations: [
        { limbId: "unknown", state: "not_observable", contactTargetIds: [] },
        { limbId: "unknown", state: "not_observable", contactTargetIds: [] },
      ],
    };
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).toThrow("only one aggregate unknown");
  });

  it("rejects none when it is combined with an identifiable limb", () => {
    const source = completeAnalysis();
    source.timeline[0].productContact.contactEvidenceLedger[1] = {
      evidenceCell: "S02",
      limbObservations: [
        { limbId: "none", state: "no_contact", contactTargetIds: [] },
        { limbId: "L1", state: "open_or_neutral", contactTargetIds: [] },
      ],
    };
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).toThrow("none only as its sole observation");
  });

  it("derives separate contact cycles and rejects a flattened hold", () => {
    const source = completeAnalysis();
    source.timeline[0].productContact.contactEvidenceLedger = [
      { evidenceCell: "S01", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
      { evidenceCell: "S02", limbObservations: [{ limbId: "L1", state: "open_or_neutral", contactTargetIds: [] }] },
      { evidenceCell: "S03", limbObservations: [{ limbId: "L1", state: "contact", contactTargetIds: ["T1"] }] },
    ];
    source.timeline[0].productContact.contactCycleLedger = [
      { cycleIndex: 1, limbIds: ["L1"], contactTargetIds: ["T1"], evidenceCells: ["S01", "S03"] },
    ];
    source.timeline[0].actionSequence[0].evidenceCells = ["S01", "S02", "S03"];
    source.timeline[0].actionSequence[0].contactLimbIds = ["L1"];
    source.timeline[0].actionSequence[0].contactTargetIds = ["T1"];
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).toThrow("does not match the classified contact cycles");
  });

  it("rejects an action that changes an evidenced continuous limb id", () => {
    const source = completeAnalysis();
    source.timeline[0].actionSequence[0].contactLimbIds = ["L2"];
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).toThrow("contactLimbIds do not match");
  });

  it("preserves bilateral contact and binds both limbs to their exact structural targets", () => {
    const source = completeAnalysis();
    source.timeline[0].actionSequence[0] = {
      timeRange: "00:00:00-00:00:03",
      evidenceCells: ["S01", "S02", "S03"],
      contactLimbIds: ["L1", "L2"],
      contactTargetIds: ["T1", "T2"],
      event: "Both visible hands hold the two exact side-hem targets, then release open together.",
      evidenceStatus: "observed",
    };
    source.timeline[0].productContact = {
      ...source.timeline[0].productContact,
      contactTargets: [
        { targetId: "T1", description: "current upper garment's first visible side hem" },
        { targetId: "T2", description: "current upper garment's second visible side hem" },
      ],
      contactEvidenceLedger: [
        { evidenceCell: "S01", limbObservations: [
          { limbId: "L1", state: "contact", contactTargetIds: ["T1"] },
          { limbId: "L2", state: "contact", contactTargetIds: ["T2"] },
        ] },
        { evidenceCell: "S02", limbObservations: [
          { limbId: "L1", state: "contact", contactTargetIds: ["T1"] },
          { limbId: "L2", state: "contact", contactTargetIds: ["T2"] },
        ] },
        { evidenceCell: "S03", limbObservations: [
          { limbId: "L1", state: "open_or_neutral", contactTargetIds: [] },
          { limbId: "L2", state: "open_or_neutral", contactTargetIds: [] },
        ] },
      ],
      contactCycleLedger: [{
        cycleIndex: 1,
        limbIds: ["L1", "L2"],
        contactTargetIds: ["T1", "T2"],
        evidenceCells: ["S01", "S02"],
      }],
    };
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).not.toThrow();
  });

  it("rejects an action whose target ids do not match its proving contact cells", () => {
    const source = completeAnalysis();
    source.timeline[0].actionSequence[0].contactTargetIds = [];
    expect(() => completeReferenceAnalysisJson(source, evidenceContext(3))).toThrow("contactTargetIds do not match");
  });

  it("formats the report as one execution summary with a continuous timeline", () => {
    const english = formatReferenceVideoAnalysis(completeAnalysis(), "english");
    const chinese = formatReferenceVideoAnalysis(completeAnalysis(), "chinese");
    expect(english).toContain("# Reference Video Execution Summary");
    expect(english).toContain("## Continuous Storyboard Timeline");
    expect(english).toContain("**Product-Contact Cycle Ledger:**");
    expect(chinese).toContain("# 参考视频执行总表");
    expect(chinese).toContain("## 连续故事板时间线");
  });
});

describe("transcript encoding guard", () => {
  it("accepts clean Chinese and English UTF-8 transcript text", () => {
    expect(transcriptEncodingIssue("[00:00-00:02] 这是一件上衣。This is a top.")).toBe("");
    expect(() => assertCleanTranscriptText("干净文本", "音频原文转写")).not.toThrow();
  });

  it.each(["损坏�文本", "损坏茂驴陆文本", "损坏锟斤拷文本", "损坏\u0378文本"])("rejects mojibake: %s", (text) => {
    expect(transcriptEncodingIssue(text)).not.toBe("");
    expect(() => assertCleanTranscriptText(text, "音频原文转写")).toThrow("包含乱码");
  });

  it("rejects encoding corruption anywhere in the structured summary", () => {
    const source = completeAnalysis();
    source.timeline[0].visualState.lightAndEnvironment = "damaged \u0378 visual state";
    expect(() => completeReferenceAnalysisJson(source)).toThrow("参考视频拆解报告包含乱码");
  });
});
