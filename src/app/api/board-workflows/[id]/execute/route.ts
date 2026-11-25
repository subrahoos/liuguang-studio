import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const ACTION_BY_ROLE: Record<string, string[]> = {
  input_assets: ["upload_video", "extract_audio"],
  select_frame: ["capture_frame"],
  gpt_analyze: ["gpt_analyze"],
  gpt_director: ["gpt_director"],
  image_pipeline: ["image_task"],
};

async function appendExecuteDebugLog(workflowLocalDir: string, event: string, payload: Record<string, unknown> = {}) {
  if (!workflowLocalDir) return;
  const diagnosticsDir = path.join(workflowLocalDir, "diagnostics");
  await mkdir(diagnosticsDir, { recursive: true }).catch(() => undefined);
  const logPath = path.join(diagnosticsDir, "execute.log");
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  await appendFile(logPath, `${line}\n`, "utf8").catch(() => undefined);
}

function controlRoleOf(node: { meta?: Record<string, unknown> }) {
  return String(node.meta?.controlRole || "");
}

function assertAllowed(role: string, action: string) {
  const allowed = ACTION_BY_ROLE[role] || [];
  if (!allowed.includes(action)) {
    throw new Error(`节点角色 ${role || "未知"} 不能执行动作 ${action}`);
  }
}

function targetPath(id: string, action: string) {
  const encodedId = encodeURIComponent(id);
  if (action === "upload_video") return `/api/board-workflows/${encodedId}/video`;
  if (action === "extract_audio") return `/api/board-workflows/${encodedId}/audio`;
  if (action === "capture_frame") return `/api/board-workflows/${encodedId}/capture-frame`;
  if (action === "gpt_analyze") return `/api/board-workflows/${encodedId}/analyze`;
  if (action === "gpt_voiceover") return `/api/board-workflows/${encodedId}/voiceover`;
  if (action === "gpt_director") return `/api/board-workflows/${encodedId}/director`;
  if (action === "image_task") return `/api/board-workflows/${encodedId}/image`;
  throw new Error(`未知节点动作：${action}`);
}

async function readMultipart(req: NextRequest) {
  const form = await req.formData();
  return {
    nodeId: String(form.get("nodeId") || ""),
    action: String(form.get("action") || ""),
    form,
  };
}

async function readJson(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return {
    nodeId: String(body.nodeId || ""),
    action: String(body.action || ""),
    payload: body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {},
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const contentType = req.headers.get("content-type") || "";
    const workflow = access.workflow;

    if (contentType.includes("multipart/form-data")) {
      const { nodeId, action, form } = await readMultipart(req);
      const node = workflow.nodes.find((item) => item.id === nodeId);
      if (!node) return NextResponse.json({ error: "找不到执行节点" }, { status: 404 });
      assertAllowed(controlRoleOf(node), action);
      form.set("executorNodeId", nodeId);
      const route = targetPath(id, action);
      await appendExecuteDebugLog(workflow.localDir, "dispatch", {
        contentType: "multipart",
        nodeId,
        action,
        controlRole: controlRoleOf(node),
        route,
      });
      const res = await fetch(new URL(route, req.nextUrl.origin), {
        method: "POST",
        headers: { Cookie: req.headers.get("cookie") || "" },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      await appendExecuteDebugLog(workflow.localDir, "dispatch_result", {
        nodeId,
        action,
        route,
        status: res.status,
        hasWorkflow: Boolean(data.workflow),
        error: data.error,
      });
      return NextResponse.json(data, { status: res.status });
    }

    const { nodeId, action, payload } = await readJson(req);
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) return NextResponse.json({ error: "找不到执行节点" }, { status: 404 });
    assertAllowed(controlRoleOf(node), action);
    const route = targetPath(id, action);
    await appendExecuteDebugLog(workflow.localDir, "dispatch", {
      contentType: "json",
      nodeId,
      action,
      controlRole: controlRoleOf(node),
      route,
      payloadKeys: Object.keys(payload),
    });
    const res = await fetch(new URL(route, req.nextUrl.origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: req.headers.get("cookie") || "",
      },
      body: JSON.stringify({
        ...payload,
        executorNodeId: nodeId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    await appendExecuteDebugLog(workflow.localDir, "dispatch_result", {
      nodeId,
      action,
      route,
      status: res.status,
      hasWorkflow: Boolean(data.workflow),
      error: data.error,
    });
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "画板节点执行失败" },
      { status: 500 }
    );
  }
}
