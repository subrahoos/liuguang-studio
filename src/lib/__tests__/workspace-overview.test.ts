import { describe, expect, it } from "vitest";
import {
  analyticsWorkspaceTask,
  boardWorkspaceTask,
  buildWorkspaceOverview,
  projectWorkspaceTask,
  quickCutWorkspaceTask,
  type WorkspaceProjectInput,
} from "@/lib/workspace-overview";

function project(overrides: Partial<WorkspaceProjectInput> = {}): WorkspaceProjectInput {
  return {
    id: "project-1",
    name: "测试项目",
    status: "draft",
    sourceType: "manual",
    currentVersionId: "version-1",
    productName: "测试商品",
    updatedAt: "2026-08-05T08:00:00.000Z",
    scriptCount: 0,
    assetCount: 0,
    assetDoneCount: 0,
    assetFailedCount: 0,
    assetRunningCount: 0,
    clipCount: 0,
    clipDoneCount: 0,
    clipFailedCount: 0,
    clipRunningCount: 0,
    compositionCount: 0,
    compositionDoneCount: 0,
    compositionFailedCount: 0,
    compositionRunningCount: 0,
    ...overrides,
  };
}

describe("workspace overview task priority", () => {
  it("sorts blocked, waiting, running, continue, then completed", () => {
    const result = buildWorkspaceOverview({
      projects: [project()],
      boards: [{
        id: "board-running",
        name: "运行画板",
        status: "video",
        updatedAt: "2026-08-05T08:05:00.000Z",
        nodes: [{ execution: { status: "running" } }],
      }],
      quickCuts: [
        {
          id: "quick-failed",
          name: "失败快剪",
          status: "failed",
          stage: "渲染失败",
          progress: 70,
          total: 10,
          completed: 6,
          failed: 1,
          updatedAt: "2026-08-05T08:10:00.000Z",
        },
        {
          id: "quick-completed",
          name: "完成快剪",
          status: "completed",
          stage: "交付完成",
          progress: 100,
          total: 5,
          completed: 5,
          failed: 0,
          updatedAt: "2026-08-05T08:20:00.000Z",
        },
      ],
      analytics: [{
        id: "analytics-warning",
        fileName: "利润表.xlsx",
        status: "completed",
        stage: "对账完成",
        progress: 100,
        reconciliationStatus: "warning",
        issueCount: 2,
        updatedAt: "2026-08-05T08:15:00.000Z",
      }],
    });

    expect(result.tasks.map((task) => task.bucket)).toEqual(["blocked", "waiting", "running", "continue", "completed"]);
    expect(result.counts).toEqual({ blocked: 1, waiting: 1, running: 1, continue: 1, completed: 1, total: 5 });
  });

  it("uses real project stage links without inventing in-stage progress", () => {
    const task = projectWorkspaceTask(project({ status: "assets", assetCount: 4, assetDoneCount: 2 }));

    expect(task.href).toBe("/project/project-1/assets?versionId=version-1");
    expect(task.summary).toContain("2/4");
    expect(task.progress).toBeUndefined();
  });

  it("sends a board failure to the exact workflow", () => {
    const task = boardWorkspaceTask({
      id: "board-1",
      name: "问题画板",
      status: "video",
      nodes: [{ status: "failed" }, { execution: { status: "done" } }],
      updatedAt: "2026-08-05T08:00:00.000Z",
    });

    expect(task.bucket).toBe("blocked");
    expect(task.href).toBe("/workspace?module=board&boardId=board-1");
  });

  it("sends a quick-cut item to the exact task", () => {
    const task = quickCutWorkspaceTask({
      id: "quick-1",
      name: "快剪任务",
      status: "ready",
      stage: "等待开始",
      progress: 0,
      total: 0,
      completed: 0,
      failed: 0,
      updatedAt: "2026-08-05T08:00:00.000Z",
    });

    expect(task.bucket).toBe("continue");
    expect(task.href).toBe("/workspace?module=quick-cut&taskId=quick-1");
  });

  it("keeps an in-progress analytics import running before reconciliation exists", () => {
    const task = analyticsWorkspaceTask({
      id: "analytics-1",
      fileName: "利润表.xlsx",
      status: "processing",
      stage: "正在重算",
      progress: 42,
      reconciliationStatus: "fail",
      issueCount: 0,
      updatedAt: "2026-08-05T08:00:00.000Z",
    });

    expect(task.bucket).toBe("running");
  });

  it("keeps local material processing in the running task bucket", () => {
    const task = quickCutWorkspaceTask({
      id: "quick-processing",
      name: "流光快剪",
      status: "processing",
      stage: "正在清理元数据 1/2",
      progress: 40,
      total: 2,
      completed: 0,
      failed: 0,
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    expect(task.bucket).toBe("running");
    expect(task.progress).toBe(40);
  });
});
