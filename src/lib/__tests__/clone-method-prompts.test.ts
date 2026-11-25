import { describe, expect, it } from "vitest";
import {
  buildCloneMethodDistillationPrompt,
  buildCloneMethodEvidencePrompt,
} from "@/lib/clone-method-prompts";

describe("clone-method prompts", () => {
  it("uses the same one-second overview and half-second action evidence contract", () => {
    const prompt = buildCloneMethodEvidencePrompt({
      meta: { durationSeconds: 4.2, hasAudio: true },
      durationSeconds: 4.2,
      storyboardCells: [
        { index: 1, sequence: "S01", timeSeconds: 0, timestamp: "00:00:00" },
        { index: 2, sequence: "S02", timeSeconds: 1, timestamp: "00:00:01" },
      ],
      actionSupplementCells: [
        { index: 1, sequence: "P001", timeSeconds: 0.5, timestamp: "00:00:00.500", evidenceKind: "interstitial" },
        { index: 2, sequence: "P002", timeSeconds: 1.96, timestamp: "00:00:01.960", evidenceKind: "cut-outgoing", cutTimeSeconds: 2 },
        { index: 3, sequence: "P003", timeSeconds: 2.001, timestamp: "00:00:02.001", evidenceKind: "cut-incoming", cutTimeSeconds: 2 },
      ],
      sceneCutTimes: [2],
      transcript: "先看领口，再转身。",
      analysisFocus: "检查切点两侧双手状态。",
    });

    expect(prompt).toContain("每 1 秒一格");
    expect(prompt).toContain("每 0.5 秒动作补证");
    expect(prompt).toContain("切前 0.04 秒与切后 0.001 秒");
    expect(prompt).toContain("S01 00:00:00");
    expect(prompt).toContain("P003 00:00:02.001");
    expect(prompt).toContain("不要直接写方法库记录、导演稿、视频生成命令、资产清单");
    expect(prompt).toContain("没有逐字时间码，不得声称精确声画同步");
    expect(prompt).not.toContain("2fps");
  });

  it("keeps the detailed evidence report and method distillation responsibilities separate", () => {
    const analysis = "## 全片结构\nS01 是开场。\n\n## 音频与节奏\n先看领口，再转身。";
    const prompt = buildCloneMethodDistillationPrompt({
      sourceVideoName: "reference.mp4",
      analysis,
      transcript: "先看领口，再转身。",
      userMethodName: "对镜细节展示",
    });

    expect(prompt).toContain("只输出严格 JSON");
    expect(prompt).toContain("它不连接画板，也不创建导演稿");
    expect(prompt).toContain("同一规则只能进入一个最具体的字段");
    expect(prompt).toContain("directorRules：仅存可复用的视频执行约束");
    expect(prompt).toContain("不生成或连接导演稿");
    expect(prompt).toContain("音频转写已包含在详细证据报告中，不得再次复述");
    expect(prompt).toContain("详细证据报告：\n## 全片结构");
  });
});
