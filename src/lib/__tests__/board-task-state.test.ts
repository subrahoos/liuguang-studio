import { describe, expect, it } from "vitest";
import {
  beginBoardClientExecution,
  boardVideoRemoteTaskId,
  boardNodeExecutionStatus,
  boardNodeVisibleExecutionStatus,
  runningBoardExecutionNodes,
} from "@/lib/board-task-state";
import type { BoardVideoJob, BoardWorkflow, BoardWorkflowNode } from "@/lib/board-workflows";

function node(input: Partial<BoardWorkflowNode> & Pick<BoardWorkflowNode, "id" | "kind">): BoardWorkflowNode {
  return {
    title: input.id,
    x: 0,
    y: 0,
    createdAt: "2026-07-25T00:00:00.000Z",
    ...input,
  };
}

function workflow(nodes: BoardWorkflowNode[]) {
  return { nodes } as Pick<BoardWorkflow, "nodes">;
}

describe("board task state", () => {
  it("uses execution status as the task truth", () => {
    const task = node({
      id: "task",
      kind: "control",
      status: "done",
      execution: { status: "failed", error: "upstream failed" },
    });
    expect(boardNodeExecutionStatus(task)).toBe("failed");
  });

  it("does not expose done while the persisted output is missing", () => {
    const task = node({
      id: "task",
      kind: "control",
      execution: { status: "done", outputNodeIds: ["missing"] },
    });
    expect(boardNodeVisibleExecutionStatus(workflow([task]), task)).toBe("syncing");
  });

  it("accepts a locally persisted image output", () => {
    const output = node({
      id: "image",
      kind: "image_asset",
      filePath: "D:\\board\\image.png",
      publicUrl: "/api/board/image.png",
    });
    const task = node({
      id: "task",
      kind: "control",
      execution: { status: "done", outputNodeIds: [output.id] },
    });
    expect(boardNodeVisibleExecutionStatus(workflow([task, output]), task)).toBe("done");
  });

  it("finds every running execution after a page reload", () => {
    const first = node({ id: "first", kind: "control", execution: { status: "running" } });
    const second = node({ id: "second", kind: "audio", execution: { status: "running" } });
    const done = node({ id: "done", kind: "control", execution: { status: "done", outputNodeIds: ["result"] } });
    expect(runningBoardExecutionNodes(workflow([first, second, done])).map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("does not treat a submitting video execution as a remote task before a task ID exists", () => {
    expect(boardVideoRemoteTaskId({ taskId: "" } as BoardVideoJob)).toBe("");
    expect(boardVideoRemoteTaskId({ taskId: " task-remote-1 " } as BoardVideoJob)).toBe("task-remote-1");
  });

  it("clears prior execution records before the browser submits a new run", () => {
    const previous = node({
      id: "video",
      kind: "control",
      status: "failed",
      error: "old failure",
      execution: {
        status: "failed",
        runId: "old-run",
        inputNodeIds: ["old-input"],
        outputNodeIds: ["old-output"],
        summary: "old task",
        error: "old failure",
        videoJob: { taskId: "old-task" } as BoardVideoJob,
        referenceCleanup: { status: "confirmed", total: 1 } as NonNullable<BoardWorkflowNode["execution"]>["referenceCleanup"],
      },
    });

    const current = beginBoardClientExecution(previous, {
      clientTaskId: "current-client-task",
      startedAt: "2026-08-11T03:00:00.000Z",
      summary: "正在执行：本次视频",
      inputNodeIds: ["current-input", "current-input", ""],
    });

    expect(current).toMatchObject({
      status: "running",
      error: "",
      execution: {
        clientTaskId: "current-client-task",
        status: "running",
        inputNodeIds: ["current-input"],
        outputNodeIds: [],
        summary: "正在执行：本次视频",
        error: "",
      },
    });
    expect(current.execution?.runId).toBeUndefined();
    expect(current.execution?.videoJob).toBeUndefined();
    expect(current.execution?.referenceCleanup).toBeUndefined();
  });
});
