import { mediaExecutable } from "@/lib/runtime-tools";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import {
  boardFilePublicUrl,
  boardArtifactFileName,
  boardArtifactRelativePath,
  createEdge,
  createNode,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  startNodeExecution,
  updateBoardWorkflow,
} from "@/lib/board-workflows";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

type Params = { params: Promise<{ id: string }> };

function mediaTool(name: "ffmpeg") {
  return mediaExecutable(name);
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let inputNodeIds: string[] = [];
  let clientTaskId = "";

  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const user = access.user;
    workflowId = id;
    const workflow = access.workflow;
    if (!workflow.sourceVideoPath || !existsSync(workflow.sourceVideoPath)) {
      return NextResponse.json({ error: "请先上传或登记参考视频。" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    clientTaskId = String(body.clientTaskId || "");
    executorNodeId = String(body.executorNodeId || "");
    const time = Math.max(0, Number(body.time || 0));
    const sourceNode = workflow.nodes.find((node) => node.kind === "source_video");
    inputNodeIds = sourceNode ? [sourceNode.id] : [];
    if (executorNodeId) await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);

    const filePath = join(
      workflow.localDir,
      boardArtifactRelativePath("assets", boardArtifactFileName(workflow, `场景锚点-${time.toFixed(1)}秒`, ".jpg")),
    );
    await mkdir(join(workflow.localDir, "assets"), { recursive: true });
    await execFileAsync(mediaTool("ffmpeg"), [
      "-y",
      "-ss", time.toFixed(3),
      "-i", workflow.sourceVideoPath,
      "-frames:v", "1",
      "-q:v", "2",
      filePath,
    ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });

    const workflowAfterCapture = await getBoardWorkflow(id, user.id) || workflow;
    if (
      isBoardTaskCancelled(id, clientTaskId) ||
      (executorNodeId && isNodeExecutionCancelled(workflowAfterCapture, executorNodeId))
    ) {
      return NextResponse.json({ workflow: workflowAfterCapture, cancelled: true });
    }

    const node = createNode({
      kind: "keyframe",
      title: `人工截图 ${time.toFixed(1)}s`,
      description: "从预览窗口手动选中的参考视频画面，可作为场景提取和构图锚点。",
      filePath,
      publicUrl: boardFilePublicUrl(id, filePath),
      meta: { assetRole: "selected_scene_frame", captureTime: time },
      x: 420,
      y: 360,
    });
    const edge = sourceNode ? [createEdge(sourceNode.id, node.id, "人工截图")] : [];
    const executorEdges = executorNodeId ? [createEdge(executorNodeId, node.id, "鑺傜偣鎵ц杈撳嚭")] : [];
    const latestWorkflow = await getBoardWorkflow(id, user.id) || workflow;
    if (
      isBoardTaskCancelled(id, clientTaskId) ||
      (executorNodeId && isNodeExecutionCancelled(latestWorkflow, executorNodeId))
    ) {
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }

    const next = await updateBoardWorkflow(id, {
      nodes: [...latestWorkflow.nodes, node],
      edges: [...latestWorkflow.edges, ...edge, ...executorEdges],
    }, latestWorkflow.revision ?? 0);
    const finalWorkflow = executorNodeId
      ? await finishNodeExecution(id, executorNodeId, inputNodeIds, [node.id], "画面截取完成") || next
      : next;

    clearBoardTaskCancellation(id, clientTaskId);
    return NextResponse.json({ workflow: finalWorkflow, node });
  } catch (error) {
    if (workflowId && executorNodeId) {
      await failNodeExecution(workflowId, executorNodeId, inputNodeIds, error instanceof Error ? error.message : "鎴浘澶辫触").catch(() => null);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "画面截取失败" },
      { status: 500 }
    );
  }
}
