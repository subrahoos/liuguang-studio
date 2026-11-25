import { workspaceModuleHref } from "@/lib/workspace-navigation";

export type WorkspaceTaskModule = "project" | "board" | "quick-cut" | "analytics";
export type WorkspaceTaskBucket = "blocked" | "waiting" | "running" | "continue" | "completed";

type TimestampValue = string | number | Date | null | undefined;

export type WorkspaceTaskItem = {
  id: string;
  sourceId: string;
  module: WorkspaceTaskModule;
  bucket: WorkspaceTaskBucket;
  title: string;
  summary: string;
  stage: string;
  href: string;
  actionLabel: string;
  updatedAt: string;
  progress?: number;
  tags: string[];
};

export type WorkspaceTaskCounts = Record<WorkspaceTaskBucket, number> & { total: number };

export type WorkspaceProjectInput = {
  id: string;
  name: string;
  status: string;
  sourceType?: string | null;
  currentVersionId?: string | null;
  productName?: string | null;
  updatedAt?: TimestampValue;
  scriptCount: number;
  assetCount: number;
  assetDoneCount: number;
  assetFailedCount: number;
  assetRunningCount: number;
  clipCount: number;
  clipDoneCount: number;
  clipFailedCount: number;
  clipRunningCount: number;
  compositionCount: number;
  compositionDoneCount: number;
  compositionFailedCount: number;
  compositionRunningCount: number;
};

export type WorkspaceBoardInput = {
  id: string;
  name: string;
  status: string;
  description?: string;
  updatedAt?: TimestampValue;
  nodes: Array<{
    status?: string;
    execution?: { status?: string };
  }>;
};

export type WorkspaceQuickCutInput = {
  id: string;
  name: string;
  status: string;
  stage: string;
  progress: number;
  total: number;
  completed: number;
  failed: number;
  updatedAt?: TimestampValue;
};

export type WorkspaceAnalyticsInput = {
  id: string;
  fileName: string;
  status: string;
  stage: string;
  progress: number;
  reconciliationStatus: string;
  issueCount: number;
  updatedAt?: TimestampValue;
};

const bucketPriority: Record<WorkspaceTaskBucket, number> = {
  blocked: 0,
  waiting: 1,
  running: 2,
  continue: 3,
  completed: 4,
};

const projectStageLabels: Record<string, string> = {
  draft: "项目草稿",
  scripting: "脚本与分镜",
  assets: "素材生成",
  video: "视频生成",
  composing: "成片合成",
  done: "成片归档",
};

const boardStageLabels: Record<string, string> = {
  draft: "画板草稿",
  evidence: "证据整理",
  analyzed: "拆解完成",
  assets: "静态资产",
  video: "视频执行",
  done: "画板完成",
};

function toIso(value: TimestampValue) {
  const date = value instanceof Date ? value : new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function projectHref(project: WorkspaceProjectInput) {
  const stage = project.status === "assets"
    ? "assets"
    : project.status === "video"
      ? "video"
      : project.status === "composing" || project.status === "done"
        ? "export"
        : "script";
  const version = project.currentVersionId?.trim()
    ? `?versionId=${encodeURIComponent(project.currentVersionId.trim())}`
    : "";
  return `/project/${encodeURIComponent(project.id)}/${stage}${version}`;
}

export function projectWorkspaceTask(project: WorkspaceProjectInput): WorkspaceTaskItem {
  const failedCount = project.assetFailedCount + project.clipFailedCount + project.compositionFailedCount;
  const runningCount = project.assetRunningCount + project.clipRunningCount + project.compositionRunningCount;
  const isCompleted = project.status === "done";
  const bucket: WorkspaceTaskBucket = failedCount > 0
    ? "blocked"
    : runningCount > 0
      ? "running"
      : isCompleted
        ? "completed"
        : "continue";

  let summary = "尚未生成脚本，等待继续创建。";
  if (failedCount > 0) summary = `${failedCount} 个生成环节失败，需要进入项目检查。`;
  else if (runningCount > 0) summary = `${runningCount} 个生成任务正在处理中。`;
  else if (project.status === "scripting") summary = project.scriptCount > 0 ? `已有 ${project.scriptCount} 份脚本，等待确认并推进素材。` : "项目已进入脚本阶段，等待继续处理。";
  else if (project.status === "assets") summary = `素材已完成 ${project.assetDoneCount}/${Math.max(project.assetCount, project.assetDoneCount)} 项。`;
  else if (project.status === "video") summary = `视频片段已完成 ${project.clipDoneCount}/${Math.max(project.clipCount, project.clipDoneCount)} 条。`;
  else if (project.status === "composing") summary = project.compositionDoneCount > 0 ? "已有成片输出，等待检查与归档。" : "视频片段已进入成片合成阶段。";
  else if (isCompleted) summary = `${project.compositionDoneCount} 条成片已完成归档。`;

  return {
    id: `project:${project.id}`,
    sourceId: project.id,
    module: "project",
    bucket,
    title: project.name,
    summary,
    stage: projectStageLabels[project.status] || project.status || "项目",
    href: projectHref(project),
    actionLabel: bucket === "blocked" ? "检查失败" : bucket === "running" ? "查看运行" : bucket === "completed" ? "查看成片" : "继续推进",
    updatedAt: toIso(project.updatedAt),
    progress: isCompleted ? 100 : undefined,
    tags: [project.sourceType === "clone" ? "爆款复刻" : "标准项目", project.productName || "未绑定商品"],
  };
}

export function boardWorkspaceTask(board: WorkspaceBoardInput): WorkspaceTaskItem {
  const trackedNodes = board.nodes.filter((node) => node.status || node.execution?.status);
  const failedCount = trackedNodes.filter((node) => node.status === "failed" || node.execution?.status === "failed").length;
  const runningCount = trackedNodes.filter((node) => node.status === "running" || node.execution?.status === "running").length;
  const doneCount = trackedNodes.filter((node) => node.status === "done" || node.execution?.status === "done").length;
  const isCompleted = board.status === "done";
  const bucket: WorkspaceTaskBucket = failedCount > 0
    ? "blocked"
    : runningCount > 0
      ? "running"
      : isCompleted
        ? "completed"
        : "continue";

  const summary = failedCount > 0
    ? `${failedCount} 个节点失败，需要进入画板检查。`
    : runningCount > 0
      ? `${runningCount} 个节点正在运行。`
      : isCompleted
        ? `${doneCount || trackedNodes.length} 个任务节点已完成。`
        : trackedNodes.length > 0
          ? `${doneCount}/${trackedNodes.length} 个可跟踪节点已完成。`
          : board.description || "画板等待继续编排。";

  return {
    id: `board:${board.id}`,
    sourceId: board.id,
    module: "board",
    bucket,
    title: board.name,
    summary,
    stage: boardStageLabels[board.status] || board.status || "画板工作流",
    href: workspaceModuleHref("board", board.id),
    actionLabel: bucket === "blocked" ? "检查节点" : bucket === "running" ? "查看运行" : bucket === "completed" ? "查看结果" : "继续画板",
    updatedAt: toIso(board.updatedAt),
    progress: isCompleted ? 100 : trackedNodes.length > 0 ? clampProgress((doneCount / trackedNodes.length) * 100) : undefined,
    tags: ["画板工作流", `${board.nodes.length} 个节点`],
  };
}

export function quickCutWorkspaceTask(task: WorkspaceQuickCutInput): WorkspaceTaskItem {
  const isRunning = ["scanning", "analyzing", "rendering", "processing"].includes(task.status);
  const bucket: WorkspaceTaskBucket = task.status === "failed"
    ? "blocked"
    : task.status === "partial" || task.status === "stopped"
      ? "waiting"
      : isRunning
        ? "running"
        : task.status === "completed"
          ? "completed"
          : "continue";

  const summary = task.status === "failed"
    ? `${task.failed || 1} 个输出失败，进入快剪查看任务记录。`
    : task.status === "partial"
      ? `已完成 ${task.completed}/${Math.max(task.total, task.completed + task.failed)} 条，${task.failed} 条失败。`
      : task.status === "stopped"
        ? "任务已停止，等待决定是否继续。"
        : isRunning
          ? `${task.stage}，当前进度 ${clampProgress(task.progress)}%。`
          : task.status === "completed"
            ? `${task.completed} 个处理结果已完成。`
            : task.status === "ready"
              ? "素材扫描完成，等待开始混剪。"
              : task.stage || "等待导入素材。";

  return {
    id: `quick-cut:${task.id}`,
    sourceId: task.id,
    module: "quick-cut",
    bucket,
    title: task.name,
    summary,
    stage: task.stage || "流光快剪",
    href: workspaceModuleHref("quick-cut", task.id),
    actionLabel: bucket === "blocked" || bucket === "waiting" ? "检查任务" : bucket === "running" ? "查看运行" : bucket === "completed" ? "查看输出" : "继续快剪",
    updatedAt: toIso(task.updatedAt),
    progress: clampProgress(task.progress),
    tags: ["流光快剪", task.total > 0 ? `${task.completed}/${task.total} 条完成` : "等待素材"],
  };
}

export function analyticsWorkspaceTask(item: WorkspaceAnalyticsInput): WorkspaceTaskItem {
  const isRunning = ["queued", "processing"].includes(item.status);
  const isWaiting = item.status === "preview_ready" || (item.status === "completed" && item.reconciliationStatus === "warning");
  const isBlocked = item.status === "failed" || (item.status === "completed" && item.reconciliationStatus === "fail");
  const bucket: WorkspaceTaskBucket = isBlocked
    ? "blocked"
    : isWaiting
      ? "waiting"
      : isRunning
        ? "running"
        : "completed";

  const summary = isBlocked
    ? `对账未通过，发现 ${item.issueCount} 个数据问题。`
    : isWaiting
      ? `对账结果需要确认，共 ${item.issueCount} 个提示。`
      : isRunning
        ? `${item.stage}，当前进度 ${clampProgress(item.progress)}%。`
        : "经营数据已完成对账。";

  return {
    id: `analytics:${item.id}`,
    sourceId: item.id,
    module: "analytics",
    bucket,
    title: "经营数据对账",
    summary,
    stage: item.stage || "经营诊断",
    href: workspaceModuleHref("analytics"),
    actionLabel: bucket === "blocked" || bucket === "waiting" ? "检查对账" : bucket === "running" ? "查看导入" : "查看诊断",
    updatedAt: toIso(item.updatedAt),
    progress: clampProgress(item.progress),
    tags: ["经营诊断", item.fileName],
  };
}

export function buildWorkspaceOverview(input: {
  projects: WorkspaceProjectInput[];
  boards: WorkspaceBoardInput[];
  quickCuts: WorkspaceQuickCutInput[];
  analytics: WorkspaceAnalyticsInput[];
}) {
  const tasks = [
    ...input.projects.map(projectWorkspaceTask),
    ...input.boards.map(boardWorkspaceTask),
    ...input.quickCuts.map(quickCutWorkspaceTask),
    ...input.analytics.map(analyticsWorkspaceTask),
  ].sort((left, right) => {
    const priorityDifference = bucketPriority[left.bucket] - bucketPriority[right.bucket];
    if (priorityDifference !== 0) return priorityDifference;
    return right.updatedAt.localeCompare(left.updatedAt);
  });

  const counts: WorkspaceTaskCounts = {
    blocked: 0,
    waiting: 0,
    running: 0,
    continue: 0,
    completed: 0,
    total: tasks.length,
  };
  for (const task of tasks) counts[task.bucket] += 1;

  return { tasks, counts };
}
