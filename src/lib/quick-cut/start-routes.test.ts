import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  handleAuthRouteError: vi.fn(),
  startQuickCutTask: vi.fn(),
  startQuickCutMaterialProcessing: vi.fn(),
  toPublicQuickCutTask: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: mocks.requireUser,
  handleAuthRouteError: mocks.handleAuthRouteError,
}));

vi.mock("@/lib/quick-cut", () => ({
  startQuickCutTask: mocks.startQuickCutTask,
  startQuickCutMaterialProcessing: mocks.startQuickCutMaterialProcessing,
  toPublicQuickCutTask: mocks.toPublicQuickCutTask,
}));

import { POST as startQuickCut } from "@/app/api/quick-cut/tasks/[id]/start/route";
import { POST as startMaterialProcessing } from "@/app/api/quick-cut/tasks/[id]/processing/start/route";

const privateTask = { id: "task-001", ownerId: "user-001", status: "analyzing" };
const publicTask = {
  id: "task-001",
  status: "analyzing",
  stage: "正在检查运行环境与素材",
  progress: 1,
};

function request(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("流光快剪启动接口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-001" });
    mocks.handleAuthRouteError.mockReturnValue(null);
    mocks.toPublicQuickCutTask.mockResolvedValue(publicTask);
  });

  it("启动混剪后返回可直接驱动前端轮询的真实任务", async () => {
    const startRequest = {
      taskName: "流光快剪",
      count: 2,
      durationMode: "fixed",
      targetDuration: 30,
      editingMode: "auto",
      settings: { audioMode: "original" },
    };
    mocks.startQuickCutTask.mockResolvedValue(privateTask);

    const response = await startQuickCut(
      request("http://localhost/api/quick-cut/tasks/task-001/start", startRequest),
      { params: Promise.resolve({ id: "task-001" }) },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true, task: publicTask });
    expect(mocks.startQuickCutTask).toHaveBeenCalledWith("user-001", "task-001", startRequest);
    expect(mocks.toPublicQuickCutTask).toHaveBeenCalledWith(privateTask);
  });

  it("启动本地素材处理后同样返回真实任务", async () => {
    mocks.startQuickCutMaterialProcessing.mockResolvedValue({ ...privateTask, status: "processing" });

    const response = await startMaterialProcessing(
      request("http://localhost/api/quick-cut/tasks/task-001/processing/start", { mode: "metadata-cleanup" }),
      { params: Promise.resolve({ id: "task-001" }) },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true, task: publicTask });
    expect(mocks.startQuickCutMaterialProcessing).toHaveBeenCalledWith("user-001", "task-001", "metadata-cleanup");
    expect(mocks.toPublicQuickCutTask).toHaveBeenCalledWith({ ...privateTask, status: "processing" });
  });
});
