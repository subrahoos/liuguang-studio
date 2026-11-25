import { describe, expect, it } from "vitest";
import {
  boardVideoSaveFileName,
  isBoardVideoSaveCandidate,
  wasBoardVideoCreatedAfterSaveLocationSelection,
} from "@/lib/board-video-save-location";
import type { BoardWorkflowNode } from "@/lib/board-workflows";

function videoNode(overrides: Partial<BoardWorkflowNode> = {}): BoardWorkflowNode {
  return {
    id: "output-1",
    kind: "video_clip",
    title: "视频输出",
    x: 0,
    y: 0,
    createdAt: "2026-08-04T00:00:00.000Z",
    filePath: "D:\\3100\\boards\\勾花\\video\\成片.mp4",
    publicUrl: "/api/board-workflows/board/file/video%2F%E6%88%90%E7%89%87.mp4",
    meta: { assetRole: "generated_video" },
    ...overrides,
  };
}

describe("board video save location", () => {
  it("only accepts completed board video outputs", () => {
    expect(isBoardVideoSaveCandidate(videoNode())).toBe(true);
    expect(isBoardVideoSaveCandidate(videoNode({ meta: { assetRole: "composed_video" } }))).toBe(true);
    expect(isBoardVideoSaveCandidate(videoNode({ meta: { assetRole: "source_video" } }))).toBe(false);
    expect(isBoardVideoSaveCandidate(videoNode({ kind: "source_video" }))).toBe(false);
    expect(isBoardVideoSaveCandidate(videoNode({ filePath: undefined }))).toBe(false);
    expect(isBoardVideoSaveCandidate(videoNode({ publicUrl: undefined }))).toBe(false);
  });

  it("uses the source filename and removes Windows-invalid characters", () => {
    expect(boardVideoSaveFileName({
      id: "output-1",
      filePath: "D:\\3100\\boards\\video\\成片:第一版?.mp4",
    })).toBe("成片-第一版-.mp4");
  });

  it("falls back to a stable MP4 filename when no valid source filename exists", () => {
    expect(boardVideoSaveFileName({ id: "output-1", filePath: "D:\\3100\\boards\\video\\" }))
      .toBe("画板视频-output-1.mp4");
    expect(boardVideoSaveFileName({ id: "output-2", filePath: "result.mov" }))
      .toBe("画板视频-output-2.mp4");
  });

  it("only auto-saves outputs created after the folder was selected", () => {
    expect(wasBoardVideoCreatedAfterSaveLocationSelection(
      videoNode({ createdAt: "2026-08-04T08:01:00.000Z" }),
      "2026-08-04T08:00:00.000Z",
    )).toBe(true);
    expect(wasBoardVideoCreatedAfterSaveLocationSelection(
      videoNode({ createdAt: "2026-08-04T07:59:59.000Z" }),
      "2026-08-04T08:00:00.000Z",
    )).toBe(false);
    expect(wasBoardVideoCreatedAfterSaveLocationSelection(videoNode(), "not-a-date")).toBe(false);
  });
});
