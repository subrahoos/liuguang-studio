export type QuickCutStoredRow = {
  planId: string;
  output: string;
  outputName?: string;
  cover?: string;
  subtitle?: string;
  sources: string[];
  sourceNames?: string[];
  diversityLevel?: string;
  segments: unknown[];
  duration: number;
  status: "done" | "failed";
  error: string;
};

export type QuickCutRunArchive = {
  id: string;
  taskName: string;
  status: string;
  stage: string;
  rows: QuickCutStoredRow[];
  scan: Record<string, unknown> | null;
  analysisSummary: Record<string, unknown> | null;
  plans: unknown[];
  total: number;
  completed: number;
  failed: number;
  completedAt: string | null;
  outputFolder: string | null;
  exportFolder: string | null;
  runConfig?: Record<string, unknown> | null;
  archivedAt: string;
};

export type QuickCutTaskMetadata = {
  runHistory?: QuickCutRunArchive[];
};

const runningStatuses = new Set(["scanning", "analyzing", "rendering", "processing"]);

type ArchivableTask = {
  name: string;
  status: string;
  stage: string;
  rows: unknown;
  scan: Record<string, unknown> | null;
  analysisSummary: Record<string, unknown> | null;
  plans: unknown[] | null;
  total: number;
  completed: number;
  failed: number;
  completedAt: Date | null;
  settings: Record<string, unknown>;
};

function textSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function quickCutRunHistory(settings: Record<string, unknown> | null | undefined): QuickCutRunArchive[] {
  const candidate = settings?.runHistory;
  return Array.isArray(candidate) ? candidate.filter((item): item is QuickCutRunArchive => Boolean(item && typeof item === "object" && "rows" in item)) : [];
}

export function needsQuickCutRunRecovery(status: string, hasActiveController: boolean) {
  return !hasActiveController && runningStatuses.has(status);
}

export function archiveQuickCutRun(task: ArchivableTask, now = new Date()) {
  const rows = Array.isArray(task.rows) ? task.rows as QuickCutStoredRow[] : [];
  if (!rows.length) return null;
  return {
    id: crypto.randomUUID(),
    taskName: task.name,
    status: task.status,
    stage: task.stage,
    rows,
    scan: task.scan || null,
    analysisSummary: task.analysisSummary || null,
    plans: Array.isArray(task.plans) ? task.plans : [],
    total: Number(task.total || rows.length),
    completed: Number(task.completed || rows.filter((item) => item.status === "done").length),
    failed: Number(task.failed || rows.filter((item) => item.status === "failed").length),
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    outputFolder: textSetting(task.settings, "outputFolder"),
    exportFolder: textSetting(task.settings, "lastExportFolder"),
    runConfig: task.settings.quickCutRunConfig && typeof task.settings.quickCutRunConfig === "object"
      ? task.settings.quickCutRunConfig as Record<string, unknown>
      : null,
    archivedAt: now.toISOString(),
  } satisfies QuickCutRunArchive;
}

export function appendQuickCutRunHistory(settings: Record<string, unknown> | null | undefined, archive: QuickCutRunArchive | null): QuickCutTaskMetadata {
  if (!archive) return settings || {};
  const rest = { ...(settings || {}) };
  delete rest.runHistory;
  return {
    ...rest,
    runHistory: [archive, ...quickCutRunHistory(settings)].slice(0, 20),
  };
}
