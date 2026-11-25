import { describe, expect, it } from "vitest";
import { isAnchorWithinSegment, parseDirectorSegmentRange, resolveVideoShotAnchor } from "@/lib/video-shot-anchor";

describe("video shot anchor", () => {
  it("follows a repaired image back to its one manually captured source frame", () => {
    const anchor = resolveVideoShotAnchor([
      { id: "frame-34", meta: { assetRole: "selected_scene_frame", captureTime: 3.4 } },
      { id: "composite", meta: { assetRole: "composite_image", referenceNodeIds: ["frame-34"] } },
      { id: "repair", meta: { assetRole: "repaired_image", referenceNodeIds: ["composite"] } },
    ], "repair");

    expect(anchor).toEqual({ sceneFrameNodeId: "frame-34", captureTime: 3.4 });
  });

  it("rejects ambiguous source-frame lineage", () => {
    const anchor = resolveVideoShotAnchor([
      { id: "frame-1", meta: { assetRole: "selected_scene_frame", captureTime: 1 } },
      { id: "frame-2", meta: { assetRole: "selected_scene_frame", captureTime: 2 } },
      { id: "composite", meta: { assetRole: "composite_image", referenceNodeIds: ["frame-1", "frame-2"] } },
    ], "composite");

    expect(anchor).toBeNull();
  });

  it("parses canonical segment ranges and checks the selected-frame time", () => {
    expect(parseDirectorSegmentRange("00:10-00:14.4")).toEqual({ start: 10, end: 14.4 });
    expect(isAnchorWithinSegment({ sceneFrameNodeId: "frame", captureTime: 10.2 }, "00:10-00:14.4")).toBe(true);
    expect(isAnchorWithinSegment({ sceneFrameNodeId: "frame", captureTime: 3.4 }, "00:10-00:14.4")).toBe(false);
  });
});
