import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { inspectPlan } = require("./quality-gate") as typeof import("./quality-gate");

function validPlan() {
  return {
    editingMode: "fashion-showcase",
    audioMode: "original",
    totalDuration: 9,
    narrativeDuration: 9,
    narrativeSourceId: "source-001",
    narrativeAudioPath: "source-001.mp4",
    narrativeAudioDuration: 9,
    units: [
      {
        sourceId: "source-001",
        shotId: "shot-001",
        segmentId: "shot-001",
        videoStart: 0,
        duration: 3,
        fashionRole: "opening-full-body",
        visualHash: "0000000000000000",
        semanticTags: ["fashion-role:opening-full-body"],
      },
      {
        sourceId: "source-001",
        shotId: "shot-002",
        segmentId: "shot-002",
        videoStart: 3,
        duration: 3,
        fashionRole: "fabric-detail",
        visualHash: "ffffffffffffffff",
        semanticTags: ["fashion-role:fabric-detail"],
      },
      {
        sourceId: "source-001",
        shotId: "shot-003",
        segmentId: "shot-003",
        videoStart: 6,
        duration: 3,
        fashionRole: "closing-pose",
        visualHash: "3333333333333333",
        semanticTags: ["fashion-role:closing-pose"],
      },
    ],
  };
}

describe("fashion quality gate", () => {
  it("accepts a complete fashion timeline with an original-audio spine", () => {
    expect(inspectPlan(validPlan())).toMatchObject({ valid: true, replacementCount: 0 });
  });

  it("rejects incomplete roles, duplicate windows, and an invalid duration", () => {
    const plan = validPlan();
    plan.totalDuration = 12;
    plan.units[2].shotId = "shot-002";
    plan.units[2].segmentId = "shot-002";
    plan.units[2].fashionRole = "unclassified";
    const result = inspectPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "女装画面时间线与计划总时长不一致",
      "同一女装时间窗口在一条成片中重复使用",
      "女装成片包含未完成语义识别的镜头",
    ]));
  });

  it("rejects an original-audio fashion plan without its continuous audio spine", () => {
    const plan = validPlan();
    plan.narrativeAudioPath = "";
    expect(inspectPlan(plan).errors).toContain("女装成片缺少连续原声主线");
  });

  it("accepts a MMPose-confirmed full-body opening even when its semantic role is not opening", () => {
    const plan = validPlan();
    plan.units[0] = {
      ...plan.units[0],
      timelineRole: "opening-full-body",
      fashionRole: "slimming-silhouette",
      fashionPose: { bodyFrame: "full-body", completeness: 0.9, stability: 0.5 },
    } as typeof plan.units[number];
    expect(inspectPlan(plan)).toMatchObject({ valid: true });
  });

  it("rejects repeated visual hashes across different sources and distant timestamps", () => {
    const plan = validPlan();
    plan.units[1] = {
      ...plan.units[1],
      sourceId: "source-002",
      videoStart: 28,
      visualHash: plan.units[0].visualHash,
    };
    expect(inspectPlan(plan).errors).toContain("女装成片存在重复或近似画面");
  });
});
