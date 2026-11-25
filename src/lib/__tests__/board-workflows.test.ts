import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  MANUAL_BOARD_EDGE_LABEL,
  boardArtifactFileName,
  boardArtifactRelativePath,
  boardFilePublicUrl,
  cancelNodeExecution,
  createBoardWorkflow,
  deleteBoardWorkflow,
  getBoardWorkflow,
  isBoardPersonReferenceNode,
  markNodeExecutionsInterruptedByRestart,
  manualDirectInputNodeIds,
  manualUpstreamNodeIds,
  mergeBoardNodesFromClientPatch,
  removeDeletedNodeReferences,
  saveBoardUploadedFile,
  startNodeExecution,
  updateBoardWorkflow,
  updateNodeExecution,
  type BoardWorkflow,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { manualDirectGeneratedVideoNodes } from "@/lib/board-manual-links";
import {
  boardNodeOutputRecoveryKey,
  boardOutputRecoveryKey,
  isBoardOutputRecoverySuppressed,
} from "@/lib/board-output-recovery";
import {
  completedImageExecutionOutputNodes,
  shouldKeepPollingImageTaskAfterHttpError,
} from "@/lib/board-image-sync";
import { storagePaths } from "@/lib/storage-root";

function node(id: string, assetRole: string): BoardWorkflowNode {
  return {
    id,
    kind: "image_asset",
    title: id,
    meta: { assetRole },
    x: 0,
    y: 0,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

describe("board person-reference authorization", () => {
  it("uses business names and a single encoded path segment for new board artifacts", () => {
    const fileName = boardArtifactFileName(
      { name: "勾花" },
      "任务1-0000-03533",
      ".mp4",
      { timestamp: new Date("2026-07-29T06:30:45.000Z") },
    );
    const fullPath = join(storagePaths.boards("勾花_4d2db5db"), boardArtifactRelativePath("video", fileName));

    expect(fileName).toMatch(/^勾花-任务1-0000-03533-20260729-143045\.mp4$/);
    expect(boardFilePublicUrl("4d2db5db", fullPath)).toContain(`/file/video%2F${encodeURIComponent(fileName)}`);
  });

  it("recognizes person identity image roles without treating product images as people", () => {
    expect(isBoardPersonReferenceNode(node("identity", "identity_image"))).toBe(true);
    expect(isBoardPersonReferenceNode(node("face", "face_front"))).toBe(true);
    expect(isBoardPersonReferenceNode(node("auxiliary", "identity_auxiliary_asset"))).toBe(true);
    expect(isBoardPersonReferenceNode(node("product", "product_image"))).toBe(false);
  });

  it("collects only manual upstream references for a generation node", () => {
    const workflow = {
      edges: [
        { id: "manual", from: "identity", to: "image-node", label: MANUAL_BOARD_EDGE_LABEL },
        { id: "automatic", from: "other-face", to: "image-node", label: "参考图" },
      ],
    } as Pick<BoardWorkflow, "edges">;

    expect(manualUpstreamNodeIds(workflow, ["image-node"])).toEqual(["identity"]);
  });

  it("keeps a director or video node's explicit manual inputs separate from transitive inputs", () => {
    const workflow = {
      edges: [
        { id: "product-to-composite", from: "product", to: "composite", label: MANUAL_BOARD_EDGE_LABEL },
        { id: "composite-to-director", from: "composite", to: "director", label: MANUAL_BOARD_EDGE_LABEL },
        { id: "analysis-to-director", from: "analysis", to: "director", label: MANUAL_BOARD_EDGE_LABEL },
      ],
    } as Pick<BoardWorkflow, "edges">;

    expect(manualDirectInputNodeIds(workflow, "director")).toEqual(["composite", "analysis"]);
    expect(manualUpstreamNodeIds(workflow, ["director"])).toEqual(["composite", "analysis", "product"]);
  });

  it("uses only manually connected generated clips as video composition inputs", () => {
    const generated = {
      ...node("segment-1", "generated_video"),
      kind: "video_clip" as const,
      filePath: "D:\\3100\\segment-1.mp4",
    };
    const unlinked = {
      ...node("segment-2", "generated_video"),
      kind: "video_clip" as const,
      filePath: "D:\\3100\\segment-2.mp4",
    };
    const composed = {
      ...node("old-composition", "composed_video"),
      kind: "video_clip" as const,
      filePath: "D:\\3100\\old-composition.mp4",
    };
    const workflow = {
      edges: [
        { id: "segment-link", from: generated.id, to: "video-generate", label: MANUAL_BOARD_EDGE_LABEL },
        { id: "old-output", from: composed.id, to: "video-generate", label: MANUAL_BOARD_EDGE_LABEL },
        { id: "automatic", from: unlinked.id, to: "video-generate", label: "节点执行输出" },
      ],
    } as Pick<BoardWorkflow, "edges">;

    expect(manualDirectGeneratedVideoNodes(workflow, [generated, unlinked, composed], "video-generate"))
      .toEqual([generated]);
  });
});

describe("board video channel selection persistence", () => {
  it("keeps a generation node's last manually selected channel in the saved workflow", async () => {
    const workflow = await createBoardWorkflow({ name: `video-channel-selection-${Date.now()}` });
    const videoNode: BoardWorkflowNode = {
      id: "video-generate",
      kind: "control",
      title: "生成视频",
      x: 0,
      y: 0,
      createdAt: new Date().toISOString(),
      meta: { controlRole: "video_generate" },
    };
    try {
      const withNode = await updateBoardWorkflow(workflow.id, { nodes: [videoNode] }, workflow.revision ?? 0);
      const saved = await updateBoardWorkflow(workflow.id, {
        nodes: withNode.nodes.map((node) => ({
          ...node,
          meta: { ...node.meta, lastSelectedVideoChannelId: "video-1786422668471" },
        })),
      }, withNode.revision ?? 0);

      expect(saved.nodes.find((node) => node.id === videoNode.id)?.meta?.lastSelectedVideoChannelId)
        .toBe("video-1786422668471");
      await expect(getBoardWorkflow(workflow.id)).resolves.toMatchObject({
        nodes: [expect.objectContaining({
          id: videoNode.id,
          meta: expect.objectContaining({ lastSelectedVideoChannelId: "video-1786422668471" }),
        })],
      });
    } finally {
      const latest = await getBoardWorkflow(workflow.id);
      if (latest) await deleteBoardWorkflow(workflow.id, latest.revision ?? 0).catch(() => undefined);
    }
  });
});

describe("board upload storage", () => {
  it("reuses one managed file for byte-identical repeat uploads", async () => {
    const workflow = await createBoardWorkflow({ name: `dedup-${Date.now()}` });
    const bytes = Buffer.from("same-user-upload");
    const streamFor = () => Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>;

    try {
      const first = await saveBoardUploadedFile({
        id: workflow.id,
        relativeFileName: "assets/source-a.png",
        stream: streamFor(),
      });
      const second = await saveBoardUploadedFile({
        id: workflow.id,
        relativeFileName: "assets/source-b.png",
        stream: streamFor(),
        reusableFilePaths: [first.filePath],
      });

      expect(first.reused).toBe(false);
      expect(second).toMatchObject({ reused: true, filePath: first.filePath, sha256: first.sha256, bytes: bytes.length });
      await expect(readdir(join(workflow.localDir, "assets"))).resolves.toEqual(["source-a.png"]);
    } finally {
      await deleteBoardWorkflow(workflow.id, 0).catch(() => undefined);
    }
  });
});

describe("board execution restart recovery", () => {
  it("does not let a late task write revive a cancelled execution", async () => {
    const workflow = await createBoardWorkflow({ name: `execution-cancel-${Date.now()}` });
    const executor = {
      ...node("video", "video_generate"),
      kind: "control" as const,
      status: "running" as const,
      execution: { status: "running" as const, clientTaskId: "run-a" },
    };
    try {
      const saved = await updateBoardWorkflow(workflow.id, { nodes: [executor] }, workflow.revision ?? 0);
      await cancelNodeExecution(workflow.id, executor.id);
      const afterLateWrite = await updateNodeExecution(workflow.id, executor.id, {
        status: "running",
        summary: "远端任务已提交：late-task",
        error: "",
      }, "running");
      const execution = afterLateWrite?.nodes.find((item) => item.id === executor.id)?.execution;
      expect(execution).toMatchObject({ status: "cancelled", summary: "用户取消，未保留本次输出" });
      expect(saved.id).toBe(workflow.id);
    } finally {
      const current = await getBoardWorkflow(workflow.id);
      await deleteBoardWorkflow(workflow.id, current?.revision ?? 0).catch(() => undefined);
    }
  });

  it("clears a prior video task and Cloudinary audit when a new execution starts", async () => {
    const workflow = await createBoardWorkflow({ name: `execution-reset-${Date.now()}` });
    const executor = {
      ...node("video", "video_generate"),
      kind: "control" as const,
      execution: {
        status: "done" as const,
        referenceCleanup: {
          status: "confirmed" as const,
          total: 4,
          deleted: 4,
          alreadyAbsent: 0,
          failed: 0,
          assets: [],
          errors: [],
          startedAt: "2026-08-08T00:00:00.000Z",
          completedAt: "2026-08-08T00:00:00.000Z",
        },
        videoJob: {
          taskId: "old-task",
          status: "completed" as const,
          channelId: "channel",
          model: "model",
          directorNodeId: "",
          directorSchemaVersion: 0,
          segmentIndex: 1,
          segmentCount: 1,
          segmentStart: 0,
          generationDuration: 15,
          sourceDuration: 9,
          sourceTimeRange: "0-9",
          outputDuration: 15,
          outputTimeRange: "0-15",
          requestedTotalDuration: 15,
          plannedOutputDuration: 15,
          referenceNodeIds: [],
          promptEnglish: "prompt",
          resultTitle: "result",
          resultDescription: "result",
          x: 0,
          y: 0,
          hostedReferences: [],
          referenceTransport: "cloudinary_https" as const,
          submittedAt: "2026-08-08T00:00:00.000Z",
        },
      },
    };
    try {
      await updateBoardWorkflow(workflow.id, { nodes: [executor] }, workflow.revision ?? 0);
      await updateNodeExecution(workflow.id, executor.id, executor.execution!, "done");
      await startNodeExecution(workflow.id, executor.id, ["new-reference"], "new-client-task");
      const execution = (await getBoardWorkflow(workflow.id))?.nodes.find((item) => item.id === executor.id)?.execution;
      expect(execution).toMatchObject({
        status: "running",
        inputNodeIds: ["new-reference"],
      });
      expect(execution?.videoJob).toBeUndefined();
      expect(execution?.referenceCleanup).toBeUndefined();
    } finally {
      await deleteBoardWorkflow(workflow.id, 0).catch(() => undefined);
    }
  });

  it("marks only executions started before the current server process as interrupted", () => {
    const processStartedAtMs = Date.parse("2026-07-22T15:40:00.000Z");
    const oldRunning = {
      ...node("old-running", "image_pipeline"),
      status: "running" as const,
      execution: { status: "running" as const, startedAt: "2026-07-22T15:33:06.000Z" },
    };
    const currentRunning = {
      ...node("current-running", "image_pipeline"),
      status: "running" as const,
      execution: { status: "running" as const, startedAt: "2026-07-22T15:41:00.000Z" },
    };

    const result = markNodeExecutionsInterruptedByRestart(
      [oldRunning, currentRunning],
      processStartedAtMs
    );

    expect(result[0]).toMatchObject({
      status: "failed",
      execution: { status: "failed", summary: "服务重启后已结束遗留任务" },
    });
    expect(result[1]).toEqual(currentRunning);
  });
});

describe("board client snapshot execution merge", () => {
  it("does not let a stale browser snapshot revive a tombstoned node", () => {
    const keep = node("keep", "product_image");
    const deleted = node("deleted", "composite_image");

    const result = mergeBoardNodesFromClientPatch(
      [keep],
      [keep, deleted],
      new Set([deleted.id])
    );

    expect(result?.map((item) => item.id)).toEqual([keep.id]);
  });

  it("clears deleted node ids from execution and task reference metadata", () => {
    const executor = {
      ...node("executor", "video_pipeline"),
      kind: "control" as const,
      execution: {
        status: "done" as const,
        inputNodeIds: ["deleted", "keep-input"],
        outputNodeIds: ["deleted", "keep-output"],
        videoJob: {
          taskId: "task",
          status: "completed" as const,
          channelId: "channel",
          model: "model",
          directorNodeId: "deleted",
          directorSchemaVersion: 1,
          segmentIndex: 1,
          segmentCount: 1,
          segmentStart: 0,
          generationDuration: 10,
          sourceDuration: 10,
          sourceTimeRange: "00:00-00:10",
          outputDuration: 10,
          outputTimeRange: "00:00-00:10",
          requestedTotalDuration: 10,
          plannedOutputDuration: 10,
          referenceNodeIds: ["deleted", "keep-input"],
          promptEnglish: "prompt",
          resultTitle: "result",
          resultDescription: "result",
          x: 0,
          y: 0,
          hostedReferences: [],
          referenceTransport: "cloudinary_https" as const,
          submittedAt: "2026-07-28T00:00:00.000Z",
          outputNodeIds: ["deleted", "keep-output"],
        },
      },
      meta: {
        assetRole: "video_pipeline",
        referenceNodeIds: ["deleted", "keep-input"],
        videoTaskReferenceIds: { "1": ["deleted", "keep-input"] },
      },
    };

    const result = removeDeletedNodeReferences([executor], new Set(["deleted"]))[0];

    expect(result.execution?.inputNodeIds).toEqual(["keep-input"]);
    expect(result.execution?.outputNodeIds).toEqual(["keep-output"]);
    expect(result.execution?.videoJob).toMatchObject({
      directorNodeId: "",
      referenceNodeIds: ["keep-input"],
      outputNodeIds: ["keep-output"],
    });
    expect(result.meta?.referenceNodeIds).toEqual(["keep-input"]);
    expect(result.meta?.videoTaskReferenceIds).toEqual({ "1": ["keep-input"] });
  });

  it("keeps a newer server failure when an old browser snapshot still says running", () => {
    const current = {
      ...node("analyze", "gpt_analyze"),
      status: "failed" as const,
      error: "socket hang up",
      execution: {
        runId: "server-run",
        clientTaskId: "client-task",
        status: "failed" as const,
        startedAt: "2026-07-23T03:37:14.000Z",
        finishedAt: "2026-07-23T03:37:39.000Z",
        error: "socket hang up",
      },
    };
    const stale = {
      ...node("analyze", "gpt_analyze"),
      status: "running" as const,
      error: "",
      execution: {
        clientTaskId: "client-task",
        status: "running" as const,
        startedAt: "2026-07-23T03:37:14.000Z",
        error: "",
      },
    };

    const result = mergeBoardNodesFromClientPatch([current], [stale], new Set());

    expect(result?.[0]).toMatchObject({
      status: "failed",
      error: "socket hang up",
      execution: { runId: "server-run", status: "failed", finishedAt: "2026-07-23T03:37:39.000Z" },
    });
  });

  it("keeps a persisted remote video task when the browser only has the pre-submit running snapshot", () => {
    const current = {
      ...node("video", "video_generate"),
      kind: "control" as const,
      status: "running" as const,
      execution: {
        runId: "same-run",
        clientTaskId: "same-client-task",
        status: "running" as const,
        startedAt: "2026-08-11T11:59:30.000Z",
        videoJob: {
          taskId: "task_saved_by_server",
          status: "submitted" as const,
          channelId: "video-channel",
          model: "sora-v3-pro",
          directorNodeId: "",
          directorSchemaVersion: 0,
          segmentIndex: 1,
          segmentCount: 1,
          segmentStart: 0,
          generationDuration: 10,
          sourceDuration: 9,
          sourceTimeRange: "参考视频 9.00s",
          outputDuration: 10,
          outputTimeRange: "00:00–00:10",
          requestedTotalDuration: 10,
          plannedOutputDuration: 10,
          referenceNodeIds: ["video-reference", "product"],
          promptEnglish: "",
          resultTitle: "参考视频替换成片",
          resultDescription: "",
          x: 0,
          y: 0,
          hostedReferences: [],
          referenceTransport: "cloudinary_https" as const,
          submittedAt: "2026-08-11T11:59:48.000Z",
        },
      },
    };
    const stale = {
      ...current,
      execution: {
        runId: "same-run",
        clientTaskId: "same-client-task",
        status: "running" as const,
        startedAt: "2026-08-11T11:59:30.000Z",
      },
    };

    const result = mergeBoardNodesFromClientPatch([current], [stale], new Set());

    expect(result?.[0].execution?.videoJob?.taskId).toBe("task_saved_by_server");
    expect(result?.[0].execution?.videoJob?.status).toBe("submitted");
  });

  it("keeps an intentional pending reset when the browser already has the same completed run", () => {
    const completed = {
      ...node("analyze", "gpt_analyze"),
      status: "done" as const,
      execution: {
        runId: "server-run",
        status: "done" as const,
        startedAt: "2026-07-23T03:37:14.000Z",
        finishedAt: "2026-07-23T03:37:39.000Z",
      },
    };
    const pendingAfterInputChange = { ...completed, status: "pending" as const };

    const result = mergeBoardNodesFromClientPatch([completed], [pendingAfterInputChange], new Set());

    expect(result?.[0]).toMatchObject({ status: "pending", execution: { status: "done" } });
  });
});

describe("board generated-output deletion suppression", () => {
  it("uses the task, output role, and executor as a stable recovery identity", () => {
    const output = {
      ...node("diagnostic", "video_output_mismatch"),
      meta: {
        assetRole: "video_output_mismatch",
        taskId: "video-task-1",
        executorNodeId: "video-executor",
      },
    };

    expect(boardNodeOutputRecoveryKey(output)).toBe(
      boardOutputRecoveryKey("video_output_mismatch", "video-task-1", "video-executor"),
    );
  });

  it("prevents refresh recovery only for the output the user deleted", () => {
    const suppressedKey = boardOutputRecoveryKey(
      "video_output_mismatch",
      "video-task-1",
      "video-executor",
    );
    const workflow = { suppressedOutputKeys: [suppressedKey] };

    expect(isBoardOutputRecoverySuppressed(
      workflow,
      "video_output_mismatch",
      "video-task-1",
      "video-executor",
    )).toBe(true);
    expect(isBoardOutputRecoverySuppressed(
      workflow,
      "video_output_mismatch",
      "video-task-2",
      "video-executor",
    )).toBe(false);
  });

  it("supports task-wide suppression for older output nodes without an executor id", () => {
    const workflow = {
      suppressedOutputKeys: [
        boardOutputRecoveryKey("video_output_mismatch", "video-task-1"),
      ],
    };

    expect(isBoardOutputRecoverySuppressed(
      workflow,
      "video_output_mismatch",
      "video-task-1",
      "video-executor",
    )).toBe(true);
  });
});

describe("completed image output synchronization", () => {
  it("accepts completion only when the matching run has a persisted image node", () => {
    const executor = {
      ...node("image-pipeline", "image_pipeline"),
      kind: "control" as const,
      execution: {
        clientTaskId: "current-task",
        status: "done" as const,
        outputNodeIds: ["output-image"],
      },
    };
    const output = {
      ...node("output-image", "outfit_front"),
      filePath: "D:\\board\\output.png",
      publicUrl: "/api/board-workflows/board/file/output.png",
    };
    const workflow = { nodes: [executor, output] } as Pick<BoardWorkflow, "nodes">;

    expect(completedImageExecutionOutputNodes(workflow, executor.id, "current-task"))
      .toEqual([output]);
    expect(completedImageExecutionOutputNodes(workflow, executor.id, "old-task"))
      .toBeNull();
  });

  it("rejects a done label when the local image or board output is missing", () => {
    const executor = {
      ...node("image-pipeline", "image_pipeline"),
      kind: "control" as const,
      execution: {
        clientTaskId: "current-task",
        status: "done" as const,
        outputNodeIds: ["missing-image"],
      },
    };
    const workflow = { nodes: [executor] } as Pick<BoardWorkflow, "nodes">;

    expect(completedImageExecutionOutputNodes(workflow, executor.id, "current-task"))
      .toBeNull();
  });

  it("keeps polling after an unconfirmed 5xx transport failure", () => {
    expect(shouldKeepPollingImageTaskAfterHttpError(
      500,
      undefined,
      "image-pipeline",
      "current-task"
    )).toBe(true);
  });

  it("stops polling for validation errors or an explicit terminal execution", () => {
    const failedExecutor = {
      ...node("image-pipeline", "image_pipeline"),
      kind: "control" as const,
      execution: {
        clientTaskId: "current-task",
        status: "failed" as const,
        error: "upstream failed",
      },
    };
    const workflow = { nodes: [failedExecutor] } as Pick<BoardWorkflow, "nodes">;

    expect(shouldKeepPollingImageTaskAfterHttpError(400, undefined, failedExecutor.id, "current-task"))
      .toBe(false);
    expect(shouldKeepPollingImageTaskAfterHttpError(502, workflow, failedExecutor.id, "current-task"))
      .toBe(false);
  });
});
