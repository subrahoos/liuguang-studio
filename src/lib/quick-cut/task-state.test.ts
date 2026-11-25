import { describe, expect, it } from "vitest";
import { appendQuickCutRunHistory, archiveQuickCutRun, needsQuickCutRunRecovery } from "@/lib/quick-cut/task-state";

describe("流光快剪运行批次归档", () => {
  const row = {
    planId: "mix-001",
    output: "output/first/videos/001.mp4",
    sources: ["input/source.mp4"],
    segments: [],
    duration: 15,
    status: "done" as const,
    error: "",
  };

  it("保留上一批成片，并让下一批使用独立的空成片状态", () => {
    const archive = archiveQuickCutRun({
      name: "流光快剪",
      status: "completed",
      stage: "成片已生成",
      rows: [row],
      scan: { validCount: 1 },
      analysisSummary: { detectedType: "presenter" },
      plans: [{ id: "mix-001" }],
      total: 1,
      completed: 1,
      failed: 0,
      completedAt: new Date("2026-07-29T00:00:00.000Z"),
      settings: {},
    }, new Date("2026-07-29T01:00:00.000Z"));

    const settings = appendQuickCutRunHistory({}, archive);
    expect(settings.runHistory).toHaveLength(1);
    expect(settings.runHistory?.[0]).toMatchObject({ taskName: "流光快剪", rows: [row], completed: 1 });
  });

  it("没有成片时不制造空历史批次", () => {
    const archive = archiveQuickCutRun({
      name: "流光快剪",
      status: "ready",
      stage: "等待开始",
      rows: [],
      scan: null,
      analysisSummary: null,
      plans: [],
      total: 0,
      completed: 0,
      failed: 0,
      completedAt: null,
      settings: {},
    });
    expect(archive).toBeNull();
    expect(appendQuickCutRunHistory({}, archive)).toEqual({});
  });
});

describe("流光快剪中断恢复", () => {
  it("只有没有活动控制器的运行中任务才需要安全收尾", () => {
    expect(needsQuickCutRunRecovery("rendering", false)).toBe(true);
    expect(needsQuickCutRunRecovery("processing", false)).toBe(true);
    expect(needsQuickCutRunRecovery("analyzing", true)).toBe(false);
    expect(needsQuickCutRunRecovery("ready", false)).toBe(false);
  });
});
