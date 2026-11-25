import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// The planner is intentionally kept as CommonJS so the production worker and tests
// exercise the same module boundary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { planFashionShowcase } = require("./fashion-planner") as typeof import("./fashion-planner");

function source(id: string) {
  const transcript = Array.from({ length: 6 }, (_, index) => ({
    start: index * 5,
    end: index * 5 + 4.5,
    text: `${id} 第${index + 1}句穿搭展示`,
  }));
  return {
    id, path: `D:/素材/${id}.mp4`, hasAudio: true, duration: 30, speechDuration: 27,
    transcript, clauses: transcript, segments: [],
    shots: Array.from({ length: 10 }, (_, index) => ({
      id: `${id}-shot-${index + 1}`, start: index * 3.5, duration: 3.2, end: index * 3.5 + 3.2,
      safeStart: index * 3.5 + 0.1, safeDuration: 3,
      fashionRole: ["opening-full-body", "fabric-detail", "slimming-silhouette", "wearing-effect", "movement-drape", "side-back", "closing-pose"][index % 7],
      faceState: "locked-presenter", clarityScore: 0.9, fashionScore: 0.8,
      fashionPose: null as Record<string, unknown> | null,
      visualHash: `${id}-hash-${index + 1}`, visualIntent: "fashion-showcase", intentConfidence: 0.8, semanticTags: [],
    })),
  };
}

function uniqueHash(index: number) {
  return createHash("sha256").update(`fashion-shot-${index}`).digest("hex").slice(0, 16);
}

function poseDrivenSource(id: string, sourceIndex: number, shotCount = 10) {
  const item = source(id);
  item.shots = item.shots.slice(0, shotCount).map((shot, index) => ({
    ...shot,
    fashionRole: index === shotCount - 1 ? "closing-pose" : index % 2 ? "fabric-detail" : "slimming-silhouette",
    fashionPose: {
      completeness: 0.9,
      bodyFrame: "full-body",
      orientation: "front",
      motionMagnitude: 0.08,
      stability: index === shotCount - 1 ? 0.8 : 0.45,
    },
    visualHash: uniqueHash(sourceIndex * 16 + index),
  }));
  return item;
}

describe("fashion showcase planner", () => {
  it("uses one coherent original-audio spine per output and reports truthful capacity", () => {
    const batch = planFashionShowcase({
      sources: [source("look-1"), source("look-2"), source("look-3")], count: 9, countMode: "custom",
      durationMode: "fixed", targetDuration: 30 as never, audioMode: "original", seed: 7,
    });
    expect(batch.plans).toHaveLength(3);
    expect(batch.meaningfulCapacity).toBe(3);
    expect(batch.actualCount).toBe(3);
    expect(batch.warnings[0]).toContain("最终高质量容量 3 条");
    expect(batch.plans.every((plan: { narrativeSourceId: string; narrativeAudioPath: string; narrativeAudioDuration: number }) => plan.narrativeSourceId && plan.narrativeAudioPath && plan.narrativeAudioDuration > 0)).toBe(true);
    expect(batch.plans[0].units.every((unit: { audioPath: string | null }) => unit.audioPath === null)).toBe(true);
    expect(batch.plans.every((plan: { units: Array<{ segmentId: string }> }) => new Set(plan.units.map((unit) => unit.segmentId)).size === plan.units.length)).toBe(true);
  });

  it("supports smart count while keeping a custom request as an upper bound", () => {
    const batch = planFashionShowcase({ sources: [source("look-1"), source("look-2"), source("look-3")], count: 50, countMode: "smart", durationMode: "smart", audioMode: "original", seed: 11 });
    expect(batch.roughEstimatedCount).toBe(3);
    expect(batch.plans).toHaveLength(3);
  });

  it("returns a real shortage when there is no coherent speech spine", () => {
    const item = source("silent"); item.transcript = []; item.clauses = []; item.speechDuration = 0;
    const batch = planFashionShowcase({ sources: [item], count: 1, durationMode: "fixed", targetDuration: 30 as never, audioMode: "original" });
    expect(batch.plans).toEqual([]);
    expect(batch.warnings[0]).toContain("连续原声主线");
  });

  it("uses MMPose evidence to rank the same fashion role and preserves it in the render plan", () => {
    const item = source("pose-evidence");
    item.shots[0].fashionScore = 0.4;
    item.shots[0].fashionPose = {
      completeness: 0.92, bodyFrame: "full-body", orientation: "front", motionMagnitude: 0.08, stability: 0.78,
    };
    item.shots[7].fashionRole = "opening-full-body";
    item.shots[7].fashionScore = 0.4;
    item.shots[7].fashionPose = {
      completeness: 0.2, bodyFrame: "partial", orientation: "unknown", motionMagnitude: 0, stability: 0,
    };

    const batch = planFashionShowcase({
      sources: [item], count: 1, countMode: "custom", durationMode: "fixed", targetDuration: 20 as never, audioMode: "original", seed: 3,
    });

    expect(batch.plans).toHaveLength(1);
    expect(batch.plans[0].units[0]).toMatchObject({
      shotId: "pose-evidence-shot-1",
      fashionPose: { completeness: 0.92, bodyFrame: "full-body" },
    });
  });

  it("uses MMPose full-body evidence as the opening placement instead of capping output by semantic opening labels", () => {
    const batch = planFashionShowcase({
      sources: [poseDrivenSource("pose-1", 1), poseDrivenSource("pose-2", 2), poseDrivenSource("pose-3", 3)],
      count: 3,
      countMode: "custom",
      durationMode: "fixed",
      targetDuration: 30 as never,
      audioMode: "original",
      seed: 21,
    });

    expect(batch.plans).toHaveLength(3);
    expect(batch.plans.every((plan: { units: Array<{ timelineRole: string; fashionRole: string; fashionPose: { bodyFrame: string } }> }) => (
      plan.units[0].timelineRole === "opening-full-body"
      && plan.units[0].fashionPose.bodyFrame === "full-body"
      && plan.units[0].fashionRole !== "opening-full-body"
    ))).toBe(true);
  });

  it("uses a shorter smart duration when that is the only way to provide more non-repeating outputs", () => {
    const batch = planFashionShowcase({
      sources: Array.from({ length: 6 }, (_, index) => poseDrivenSource(`short-${index + 1}`, index + 10, 5)),
      count: 50,
      countMode: "smart",
      durationMode: "smart",
      audioMode: "original",
      seed: 31,
    });

    expect((batch as { selectedDuration?: number }).selectedDuration).toBeLessThan(30);
    expect(batch.plans).toHaveLength(6);
    expect(batch.plans.every((plan: { units: Array<{ visualHash: string }> }) => (
      new Set(plan.units.map((unit) => unit.visualHash)).size === plan.units.length
    ))).toBe(true);
  });
});
