import { describe, expect, it } from "vitest";
import {
  actionSupplementBoardFilter,
  actionSupplementCells,
  actionDetailSheetFilter,
  actionDetailSheetRanges,
  isReplaceableVideoEvidenceNode,
  resolveEvidenceBoundary,
  sampledFpsFilter,
  sampledFrameCount,
  storyboardCells,
  storyboardOverviewFilter,
} from "@/lib/video-evidence";

describe("video evidence sampling", () => {
  it("keeps the final partial-interval storyboard sample", () => {
    expect(sampledFrameCount(14.360998, 1)).toBe(15);
    expect(storyboardCells(14.360998, 1).at(-1)).toEqual({
      index: 15,
      sequence: "S15",
      timeSeconds: 14,
      timestamp: "00:00:14",
    });
  });

  it("uses FFmpeg EOF pass-through so the visual sheet matches the manifest", () => {
    expect(sampledFpsFilter(1)).toBe("fps=fps=1/1:start_time=0:eof_action=pass");
    expect(storyboardOverviewFilter(14.360998, 1)).toContain(
      "fps=fps=1/1:start_time=0:eof_action=pass",
    );
  });

  it("does not add a sample when the duration ends exactly on the interval", () => {
    expect(sampledFrameCount(14, 1)).toBe(14);
    expect(storyboardCells(14, 1).at(-1)?.sequence).toBe("S14");
  });

  it("supports half-second action evidence with millisecond labels", () => {
    expect(sampledFrameCount(15.1, 0.5)).toBe(31);
    expect(storyboardCells(15.1, 0.5)[1]).toMatchObject({
      timeSeconds: 0.5,
      timestamp: "00:00:00.500",
    });
    expect(storyboardCells(15.1, 0.5).at(-1)?.timestamp).toBe("00:00:15");
    expect(sampledFpsFilter(0.5)).toBe("fps=fps=1/0.5:start_time=0:eof_action=pass");
  });

  it("builds a compact supplement from only missing half-second frames and cut sides", () => {
    const cells = actionSupplementCells(15.1, [3.533333, 9.1]);
    expect(cells).toHaveLength(19);
    expect(cells.filter((cell) => cell.evidenceKind === "interstitial")).toHaveLength(15);
    expect(cells.filter((cell) => cell.evidenceKind === "cut-outgoing")).toHaveLength(2);
    expect(cells.filter((cell) => cell.evidenceKind === "cut-incoming")).toHaveLength(2);
    expect(cells[0]).toMatchObject({ sequence: "P001", timeSeconds: 0.5, evidenceKind: "interstitial" });
    expect(cells.find((cell) => cell.evidenceKind === "cut-outgoing" && cell.cutTimeSeconds === 3.533))
      .toMatchObject({ timeSeconds: 3.493 });
    expect(actionSupplementBoardFilter(cells)).toContain("split=19");
    expect(actionSupplementBoardFilter(cells)).toContain("force_original_aspect_ratio=decrease:force_divisible_by=2");
    expect(actionSupplementBoardFilter(cells)).toContain("OUT");
    expect(actionSupplementBoardFilter(cells)).toContain("IN");
  });

  it("always keeps the source-video tail in the evidence timeline", () => {
    expect(resolveEvidenceBoundary({
      sourceDurationSeconds: 18.110998,
    })).toEqual({
      durationSeconds: 18.110998,
      source: "full-video",
    });
  });

  it("splits detailed evidence into five-second sheets without dropping the tail", () => {
    expect(actionDetailSheetRanges(15.1)).toEqual([
      { index: 1, startSeconds: 0, endSeconds: 5 },
      { index: 2, startSeconds: 5, endSeconds: 10 },
      { index: 3, startSeconds: 10, endSeconds: 15 },
      { index: 4, startSeconds: 15, endSeconds: 15.1 },
    ]);
    const filter = actionDetailSheetFilter({
      startSeconds: 5,
      endSeconds: 10,
      intervalSeconds: 0.5,
      firstSequenceIndex: 11,
    });
    expect(filter).toContain("fps=fps=1/0.5:start_time=5:eof_action=pass");
    expect(filter).toContain("D%{eif\\:n+11\\:d\\:03}");
  });

  it("replaces only automatic video evidence and preserves manually selected frames", () => {
    expect(isReplaceableVideoEvidenceNode({
      kind: "keyframe",
      meta: { assetRole: "selected_scene_frame" },
    })).toBe(false);
    expect(isReplaceableVideoEvidenceNode({
      kind: "keyframe",
      meta: { assetRole: "action_detail_storyboard_collection" },
    })).toBe(true);
    expect(isReplaceableVideoEvidenceNode({
      kind: "keyframe",
      meta: { assetRole: "action_supplement_storyboard_collection" },
    })).toBe(true);
    expect(isReplaceableVideoEvidenceNode({
      kind: "keyframe",
      meta: { assetRole: "keyframe_collection" },
    })).toBe(true);
    expect(isReplaceableVideoEvidenceNode({
      kind: "keyframe",
      meta: { assetRole: "scene_change_collection" },
    })).toBe(true);
  });
});
