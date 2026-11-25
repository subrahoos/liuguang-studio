import { describe, expect, it } from "vitest";
import { buildCoreJudgments, buildCoreSchedule } from "@/components/luma-core-workspace";
import type { WorkspaceTaskBucket, WorkspaceTaskItem } from "@/lib/workspace-overview";

function task(id: string, bucket: WorkspaceTaskBucket): WorkspaceTaskItem {
  return {
    id,
    sourceId: id,
    module: "project",
    bucket,
    title: `任务 ${id}`,
    summary: `${bucket} summary`,
    stage: "项目阶段",
    href: `/project/${id}/script`,
    actionLabel: "进入任务",
    updatedAt: "2026-08-05T12:00:00.000Z",
    tags: [bucket],
  };
}

describe("luma core workspace signals", () => {
  it("limits judgments to the first three unfinished signals", () => {
    const judgments = buildCoreJudgments([
      task("blocked", "blocked"),
      task("waiting", "waiting"),
      task("running", "running"),
      task("continue", "continue"),
      task("done", "completed"),
    ]);

    expect(judgments.map((item) => item.id)).toEqual(["blocked", "waiting", "running"]);
    expect(judgments[0]?.label).toBe("阻塞信号");
    expect(judgments[1]?.verb).toBe("需要确认");
  });

  it("maps real task buckets to the now, next and later lanes", () => {
    const lanes = buildCoreSchedule([
      task("blocked", "blocked"),
      task("waiting", "waiting"),
      task("running", "running"),
      task("continue", "continue"),
      task("done", "completed"),
    ]);

    expect(lanes.map((lane) => lane.id)).toEqual(["now", "next", "later"]);
    expect(lanes[0]?.tasks.map((item) => item.id)).toEqual(["blocked", "waiting"]);
    expect(lanes[1]?.tasks.map((item) => item.id)).toEqual(["running", "continue"]);
    expect(lanes[2]?.tasks.map((item) => item.id)).toEqual(["done"]);
  });
});
