"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Package,
  RefreshCw,
  Scissors,
  Search,
  Sparkles,
  UserRound,
  Video,
  X,
} from "lucide-react";
import { LumaCoreScene, type LumaCoreSceneNode } from "@/components/luma-core-scene";
import type {
  WorkspaceTaskBucket,
  WorkspaceTaskCounts,
  WorkspaceTaskItem,
  WorkspaceTaskModule,
} from "@/lib/workspace-overview";

export type LumaCorePanelId = "new" | "clone" | "board" | "quick-cut" | "products" | "methods" | "identity" | "analytics";

type CoreTone = "cyan" | "violet" | "amber" | "rose";

type CoreNodeDefinition = {
  id: string;
  label: string;
  module?: LumaCorePanelId;
  taskModule?: WorkspaceTaskModule;
  tone: CoreTone;
  position: { left: string; top: string };
};

export type CoreJudgment = {
  id: string;
  task: WorkspaceTaskItem;
  label: string;
  tone: CoreTone;
  verb: string;
};

export type CoreScheduleLane = {
  id: "now" | "next" | "later";
  label: string;
  kicker: string;
  tasks: WorkspaceTaskItem[];
};

const coreNodes: CoreNodeDefinition[] = [
  { id: "product", label: "商品", module: "products", tone: "cyan", position: { left: "50%", top: "14%" } },
  { id: "person", label: "人物", module: "identity", tone: "violet", position: { left: "16%", top: "30%" } },
  { id: "method", label: "方法", module: "methods", tone: "violet", position: { left: "15%", top: "69%" } },
  { id: "board", label: "画板", module: "board", taskModule: "board", tone: "cyan", position: { left: "32%", top: "86%" } },
  { id: "video", label: "视频", module: "new", taskModule: "project", tone: "amber", position: { left: "68%", top: "86%" } },
  { id: "quick-cut", label: "快剪", module: "quick-cut", taskModule: "quick-cut", tone: "cyan", position: { left: "85%", top: "69%" } },
  { id: "operations", label: "经营", module: "analytics", taskModule: "analytics", tone: "amber", position: { left: "84%", top: "30%" } },
];

const toneClasses: Record<CoreTone, { border: string; bg: string; text: string; dot: string }> = {
  cyan: { border: "border-cyan-100/24", bg: "bg-cyan-200/10", text: "text-cyan-50", dot: "bg-cyan-200" },
  violet: { border: "border-violet-200/24", bg: "bg-violet-300/10", text: "text-violet-50", dot: "bg-violet-200" },
  amber: { border: "border-amber-200/24", bg: "bg-amber-300/10", text: "text-amber-50", dot: "bg-amber-200" },
  rose: { border: "border-rose-200/28", bg: "bg-rose-300/10", text: "text-rose-50", dot: "bg-rose-200" },
};

const bucketMeta: Record<WorkspaceTaskBucket, { label: string; tone: CoreTone; verb: string; icon: typeof CircleAlert }> = {
  blocked: { label: "阻塞信号", tone: "rose", verb: "先检查", icon: CircleAlert },
  waiting: { label: "人工判断", tone: "amber", verb: "需要确认", icon: Clock3 },
  running: { label: "运行信号", tone: "cyan", verb: "查看运行", icon: LoaderCircle },
  continue: { label: "推进信号", tone: "violet", verb: "可以继续", icon: ArrowRight },
  completed: { label: "已完成", tone: "cyan", verb: "查看结果", icon: CheckCircle2 },
};

const moduleOptions: Array<{ id: "all" | WorkspaceTaskModule; label: string }> = [
  { id: "all", label: "全部" },
  { id: "project", label: "视频" },
  { id: "board", label: "画板" },
  { id: "quick-cut", label: "快剪" },
  { id: "analytics", label: "经营" },
];

const bucketOptions: Array<{ id: "all" | WorkspaceTaskBucket; label: string }> = [
  { id: "all", label: "全部" },
  { id: "blocked", label: "阻塞" },
  { id: "waiting", label: "待判断" },
  { id: "running", label: "运行中" },
  { id: "continue", label: "可推进" },
];

function formatCoreTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function buildCoreJudgments(tasks: WorkspaceTaskItem[]): CoreJudgment[] {
  return tasks
    .filter((task) => task.bucket !== "completed")
    .slice(0, 3)
    .map((task) => ({
      id: task.id,
      task,
      label: bucketMeta[task.bucket].label,
      tone: bucketMeta[task.bucket].tone,
      verb: bucketMeta[task.bucket].verb,
    }));
}

export function buildCoreSchedule(tasks: WorkspaceTaskItem[]): CoreScheduleLane[] {
  const used = new Set<string>();
  const pick = (predicate: (task: WorkspaceTaskItem) => boolean, limit: number) => tasks
    .filter((task) => !used.has(task.id) && predicate(task))
    .slice(0, limit)
    .map((task) => {
      used.add(task.id);
      return task;
    });

  let nowTasks = pick((task) => task.bucket === "blocked" || task.bucket === "waiting", 2);
  if (nowTasks.length === 0) nowTasks = pick((task) => task.bucket === "running", 2);
  const nextTasks = pick((task) => task.bucket === "running" || task.bucket === "continue", 3);
  const laterTasks = pick((task) => task.bucket === "completed", 2);

  return [
    { id: "now", label: "现在", kicker: "IMMEDIATE", tasks: nowTasks },
    { id: "next", label: "接下来", kicker: "NEXT SIGNAL", tasks: nextTasks },
    { id: "later", label: "稍后", kicker: "LOW PRESSURE", tasks: laterTasks },
  ];
}

function getNodeStatus(node: CoreNodeDefinition, tasks: WorkspaceTaskItem[]): LumaCoreSceneNode["status"] {
  if (!node.taskModule) return "idle";
  const related = tasks.filter((task) => task.module === node.taskModule);
  if (related.some((task) => task.bucket === "blocked" || task.bucket === "waiting")) return "attention";
  if (related.some((task) => task.bucket === "running")) return "running";
  return "idle";
}

function moduleIcon(nodeId: string) {
  if (nodeId === "product") return Package;
  if (nodeId === "person") return UserRound;
  if (nodeId === "method") return Sparkles;
  if (nodeId === "board") return GitBranch;
  if (nodeId === "video") return Video;
  if (nodeId === "quick-cut") return Scissors;
  return Activity;
}

export function LumaCoreWorkspace({
  tasks,
  counts,
  search,
  isLoading,
  error,
  generatedAt,
  needsProviderSetup,
  onRefresh,
  onSearch,
  onNavigate,
}: {
  tasks: WorkspaceTaskItem[];
  counts: WorkspaceTaskCounts;
  search: string;
  isLoading: boolean;
  error: string;
  generatedAt: string;
  needsProviderSetup: boolean;
  onRefresh: () => void;
  onSearch: (value: string) => void;
  onNavigate: (panel: LumaCorePanelId) => void;
}) {
  const [moduleFilter, setModuleFilter] = useState<"all" | WorkspaceTaskModule>("all");
  const [bucketFilter, setBucketFilter] = useState<"all" | WorkspaceTaskBucket>("all");
  const [focusedNodeId, setFocusedNodeId] = useState("video");
  const [expandedJudgmentId, setExpandedJudgmentId] = useState<string | null>(null);
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");

  const scopedTasks = useMemo(() => tasks.filter((task) => {
    if (moduleFilter !== "all" && task.module !== moduleFilter) return false;
    if (!normalizedSearch) return true;
    return [task.title, task.summary, task.stage, ...task.tags]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(normalizedSearch);
  }), [moduleFilter, normalizedSearch, tasks]);

  const filteredTasks = useMemo(
    () => bucketFilter === "all" ? scopedTasks : scopedTasks.filter((task) => task.bucket === bucketFilter),
    [bucketFilter, scopedTasks],
  );
  const judgments = useMemo(() => buildCoreJudgments(filteredTasks), [filteredTasks]);
  const schedule = useMemo(() => buildCoreSchedule(filteredTasks), [filteredTasks]);
  const sceneNodes = useMemo<LumaCoreSceneNode[]>(() => coreNodes.map((node) => ({
    id: node.id,
    label: node.label,
    tone: node.tone,
    status: getNodeStatus(node, filteredTasks),
  })), [filteredTasks]);
  const focusedDefinition = coreNodes.find((node) => node.id === focusedNodeId) || coreNodes[0];
  const scopedCounts = useMemo(() => scopedTasks.reduce<WorkspaceTaskCounts>((result, task) => {
    result[task.bucket] += 1;
    result.total += 1;
    return result;
  }, { blocked: 0, waiting: 0, running: 0, continue: 0, completed: 0, total: 0 }), [scopedTasks]);

  function selectNode(nodeId: string) {
    setFocusedNodeId(nodeId);
  }

  function enterFocusedNode() {
    if (focusedDefinition.module) onNavigate(focusedDefinition.module);
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-cyan-100/16 bg-white/[0.018] shadow-[0_24px_90px_rgba(0,0,0,0.22)] backdrop-blur-[12px]">
      <header className="shrink-0 border-b border-cyan-100/12 bg-[#061019]/28 px-3 py-3 lg:px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-100/62">LUMA CORE</p>
              <span className="text-[10px] font-semibold text-slate-500">判断调度中枢</span>
            </div>
            <h1 className="mt-1 text-xl font-black tracking-tight text-slate-50">流光核心</h1>
          </div>
          <div className="flex items-center gap-2">
            {needsProviderSetup && (
              <Link href="/settings" className="hidden items-center gap-1.5 rounded-md border border-amber-200/20 bg-amber-300/8 px-2.5 py-1.5 text-[10px] font-semibold text-amber-100 transition hover:bg-amber-300/14 sm:inline-flex">
                <CircleAlert className="h-3.5 w-3.5" />
                AI 通道待配置
              </Link>
            )}
            <span className="hidden items-center gap-1.5 rounded-md border border-emerald-200/16 bg-emerald-300/8 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-100 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
              只读同步
            </span>
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-semibold text-slate-400">
              {counts.total} 条信号
            </span>
            <button type="button" onClick={onRefresh} disabled={isLoading} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.045] text-cyan-100 transition hover:border-cyan-100/28 hover:bg-cyan-100/9 disabled:opacity-50" title="刷新核心信号" aria-label="刷新核心信号">
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex min-w-0 flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto" role="group" aria-label="按模块筛选核心信号">
            {moduleOptions.map((option) => (
              <button key={option.id} type="button" onClick={() => setModuleFilter(option.id)} aria-pressed={moduleFilter === option.id} className={`h-7 shrink-0 rounded-md px-2.5 text-[10px] font-semibold transition ${moduleFilter === option.id ? "bg-cyan-200/13 text-cyan-50" : "text-slate-400 hover:bg-white/[0.045] hover:text-slate-100"}`}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex max-w-full items-center gap-1 overflow-x-auto" role="group" aria-label="按信号筛选核心判断">
            {bucketOptions.map((option) => {
              const count = option.id === "all" ? scopedCounts.total : scopedCounts[option.id];
              return (
                <button key={option.id} type="button" onClick={() => setBucketFilter(option.id)} aria-pressed={bucketFilter === option.id} className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] font-semibold transition ${bucketFilter === option.id ? "bg-white/10 text-cyan-50" : "text-slate-400 hover:bg-white/[0.045] hover:text-slate-100"}`}>
                  {option.label}<span className="text-[9px] opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="relative mt-3 lg:hidden">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cyan-100/55" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            className="h-9 w-full rounded-md border border-white/10 bg-black/20 pl-9 pr-9 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-100/35 focus:bg-cyan-100/8"
            placeholder="搜索任务、阶段或模块..."
            aria-label="搜索核心信号"
          />
          {search && (
            <button type="button" onClick={() => onSearch("")} className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/[0.06] hover:text-cyan-50" title="清除搜索" aria-label="清除搜索">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[minmax(230px,0.76fr)_minmax(330px,1.5fr)_minmax(250px,0.86fr)] lg:p-4 xl:overflow-hidden">
        <CorePanel title="规则判断" kicker="SIGNAL REVIEW" count={judgments.length} className="min-h-[280px] xl:min-h-0">
          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-rose-200/20 bg-rose-300/8 px-2.5 py-2 text-[10px] leading-4 text-rose-100">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">{error}</span>
            </div>
          )}
          {isLoading && tasks.length === 0 ? (
            <LoadingSignal />
          ) : judgments.length === 0 ? (
            <EmptySignal text={filteredTasks.length === 0 ? "当前筛选没有可判断信号" : "当前没有新的阻塞信号"} />
          ) : (
            <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
              {judgments.map((judgment, index) => (
                <JudgmentItem key={judgment.id} judgment={judgment} index={index} expanded={expandedJudgmentId === judgment.id} onToggle={() => setExpandedJudgmentId((current) => current === judgment.id ? null : judgment.id)} />
              ))}
            </div>
          )}
          <div className="mt-auto border-t border-white/[0.07] pt-3 text-[10px] text-slate-500">
            {generatedAt ? `上次同步 ${formatCoreTime(generatedAt)}` : "等待首次同步"}
          </div>
        </CorePanel>

        <section className="relative flex min-h-[440px] min-w-0 flex-col overflow-hidden rounded-lg border border-cyan-100/18 bg-[#04131b]/42 shadow-[inset_0_1px_0_rgba(165,243,252,0.06),0_0_46px_rgba(34,211,238,0.07)] xl:min-h-0">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-cyan-100/10 px-3 py-2 text-[9px] font-bold uppercase tracking-[0.22em] text-cyan-100/52">
            <span>CORE FIELD / 07 NODES</span>
            <span>{focusedDefinition.label} focus</span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div className="pointer-events-none absolute inset-5 border border-cyan-100/[0.055]" />
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-[72%] -translate-x-1/2 bg-cyan-100/[0.08]" />
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-[72%] w-px -translate-x-1/2 -translate-y-1/2 bg-violet-100/[0.08]" />
            <LumaCoreScene nodes={sceneNodes} focusedNodeId={focusedNodeId} onNodeSelect={selectNode} className="absolute inset-0" />
            <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-center">
              <p className="text-[9px] font-bold uppercase tracking-[0.28em] text-cyan-100/55">LUMA</p>
              <p className="mt-1 text-sm font-black tracking-[0.18em] text-slate-50">CORE</p>
              <p className="mt-1 text-[9px] text-slate-500">{filteredTasks.length ? `${filteredTasks.length} signals linked` : "no active signal"}</p>
            </div>
            <div className="absolute inset-0 z-20">
              {coreNodes.map((node) => {
                const Icon = moduleIcon(node.id);
                const status = getNodeStatus(node, filteredTasks);
                const focused = node.id === focusedNodeId;
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => selectNode(node.id)}
                    className={`luma-core-node ${focused ? "is-focused" : ""}`}
                    style={{ left: node.position.left, top: node.position.top }}
                    data-tone={node.tone}
                    data-status={status}
                    data-focused={focused ? "true" : "false"}
                    aria-pressed={focused}
                    title={`进入${node.label}模块`}
                  >
                    <span className="luma-core-node-label">
                      <span className="luma-core-node-icon"><Icon /></span>
                      {node.label}
                    </span>
                    <span className="luma-core-node-status">
                      <span className="luma-core-node-status-dot" />
                      {status === "attention" ? "attention" : status === "running" ? "running" : "standby"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-cyan-100/10 px-3 py-2 text-[10px] text-slate-400">
            <span className="truncate">焦点：{focusedDefinition.label} · 节点只负责聚焦</span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-cyan-100/55">READ / ONLY</span>
              <button type="button" onClick={enterFocusedNode} className="inline-flex items-center gap-1 font-semibold text-cyan-100 transition hover:text-cyan-50" title={`进入${focusedDefinition.label}模块`}>
                进入模块<ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </footer>
        </section>

        <CorePanel title="调度轨道" kicker="ATTENTION ROUTE" count={filteredTasks.length} className="min-h-[320px] xl:min-h-0">
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            {schedule.map((lane) => <ScheduleLane key={lane.id} lane={lane} />)}
          </div>
          <div className="mt-auto border-t border-white/[0.07] pt-3 text-[10px] text-slate-500">
            仅按真实任务状态排序，不自动执行动作
          </div>
        </CorePanel>
      </div>
    </section>
  );
}

function CorePanel({ title, kicker, count, className = "", children }: { title: string; kicker: string; count: number; className?: string; children: ReactNode }) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-cyan-100/12 bg-[#061019]/32 p-3 backdrop-blur-[7px] ${className}`}>
      <header className="mb-3 flex shrink-0 items-end justify-between gap-2 border-b border-white/[0.07] pb-2">
        <div className="min-w-0">
          <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-cyan-100/52">{kicker}</p>
          <h2 className="mt-1 text-sm font-black text-slate-50">{title}</h2>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-slate-500">{String(count).padStart(2, "0")}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

function JudgmentItem({ judgment, index, expanded, onToggle }: { judgment: CoreJudgment; index: number; expanded: boolean; onToggle: () => void }) {
  const meta = bucketMeta[judgment.task.bucket];
  const tone = toneClasses[judgment.tone];
  const Icon = meta.icon;
  return (
    <article className={`overflow-hidden rounded-md border ${expanded ? tone.border : "border-white/10"} ${expanded ? tone.bg : "bg-white/[0.025]"} transition`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2.5 p-2.5 text-left">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${tone.border} ${tone.bg} ${tone.text}`}>
          <Icon className={`h-3.5 w-3.5 ${judgment.task.bucket === "running" ? "animate-spin" : ""}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className={`text-[9px] font-bold uppercase tracking-[0.12em] ${tone.text}`}>{String(index + 1).padStart(2, "0")} / {judgment.label}</span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition ${expanded ? "rotate-180" : ""}`} />
          </span>
          <span className="mt-1 block truncate text-xs font-bold text-slate-50">{judgment.task.title}</span>
          <span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-slate-300/78">{judgment.task.summary}</span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-white/[0.08] px-2.5 pb-2.5 pt-2 text-[10px] text-slate-400">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <span className="text-slate-500">模块</span><span className="truncate text-slate-200">{judgment.task.module}</span>
            <span className="text-slate-500">阶段</span><span className="truncate text-slate-200">{judgment.task.stage}</span>
            <span className="text-slate-500">更新</span><span className="truncate text-slate-200">{formatCoreTime(judgment.task.updatedAt)}</span>
            <span className="text-slate-500">证据</span><span className="truncate text-slate-200">{judgment.task.tags.join(" · ") || "无附加标签"}</span>
          </div>
          <Link href={judgment.task.href} className="mt-2 inline-flex items-center gap-1.5 font-semibold text-cyan-100 transition hover:text-cyan-50">
            {judgment.task.actionLabel}<ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      )}
    </article>
  );
}

function ScheduleLane({ lane }: { lane: CoreScheduleLane }) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black text-slate-50">{lane.label}</span>
          <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-cyan-100/46">{lane.kicker}</span>
        </div>
        <span className="font-mono text-[9px] text-slate-500">{String(lane.tasks.length).padStart(2, "0")}</span>
      </div>
      {lane.tasks.length === 0 ? (
        <div className="border-l border-white/10 py-1 pl-2 text-[10px] text-slate-500">暂无信号</div>
      ) : (
        <div className="space-y-1.5 border-l border-cyan-100/14 pl-2">
          {lane.tasks.map((task) => {
            const meta = bucketMeta[task.bucket];
            const tone = toneClasses[meta.tone];
            return (
              <Link key={task.id} href={task.href} className="group block rounded-md border border-white/[0.07] bg-white/[0.025] px-2.5 py-2 transition hover:border-cyan-100/24 hover:bg-cyan-100/7">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-100 group-hover:text-cyan-50">{task.title}</span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-cyan-100" />
                </div>
                <p className="mt-1 line-clamp-1 pl-3.5 text-[10px] text-slate-400/80">{task.summary}</p>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LoadingSignal() {
  return (
    <div className="flex min-h-32 items-center justify-center text-[11px] text-slate-400">
      <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-cyan-100" />
      正在读取核心信号
    </div>
  );
}

function EmptySignal({ text }: { text: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center border-y border-white/[0.07] text-center">
      <CheckCircle2 className="h-5 w-5 text-emerald-200/70" />
      <p className="mt-2 text-[11px] font-semibold text-slate-300">{text}</p>
      <p className="mt-1 text-[10px] text-slate-500">调度轨道仍保留已完成记录</p>
    </div>
  );
}
