import { describe, expect, it } from "vitest";
import { validateBoardVideoOutput } from "@/lib/board-video-output-contract";

const portrait720 = { aspectRatio: "9:16" as const, resolution: "720p" as const };

describe("board video output contract", () => {
  it("accepts a returned 10-second 720p portrait Grok video", () => {
    expect(validateBoardVideoOutput(portrait720, 10, {
      durationSeconds: 10.04,
      width: 720,
      height: 1280,
      hasAudio: true,
    })).toMatchObject({ valid: true, violations: [] });
  });

  it("rejects a six-second landscape result for a requested 10-second portrait task", () => {
    const validation = validateBoardVideoOutput(portrait720, 10, {
      durationSeconds: 6.041667,
      width: 1280,
      height: 720,
    });

    expect(validation.valid).toBe(false);
    expect(validation.violations).toContain("请求 10 秒，实际回传 6.04 秒。");
    expect(validation.violations).toContain("请求 9:16，实际为 1280×720。");
  });

  it("rejects a silent return when the director segment contains dialogue", () => {
    const validation = validateBoardVideoOutput(portrait720, 10, {
      durationSeconds: 10,
      width: 720,
      height: 1280,
      hasAudio: false,
    }, { requiresAudio: true });

    expect(validation.valid).toBe(false);
    expect(validation.violations).toContain("当前任务包含口播，但回传文件没有可读取的音轨。");
  });

  it("rejects a non-720 short edge for a requested 720p task", () => {
    const validation = validateBoardVideoOutput(portrait720, 10, {
      durationSeconds: 10,
      width: 640,
      height: 1138,
      hasAudio: false,
    });

    expect(validation.valid).toBe(false);
    expect(validation.violations).toContain("请求 720p，实际短边为 640px。");
  });
});
