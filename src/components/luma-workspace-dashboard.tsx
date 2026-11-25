"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Factory,
  GitBranch,
  House,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Package,
  Play,
  Plus,
  Search,
  Scissors,
  Settings,
  Sparkles,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { hasProviderCredential, useSettingsStore } from "@/lib/stores/settings-store";
import { useProductLibraryStore, type ProductItem } from "@/lib/stores/product-library-store";
import {
  isWorkspaceModuleId,
  type WorkspaceFeatureEntries,
  type WorkspaceModuleId,
  workspaceModuleHref,
} from "@/lib/workspace-navigation";
import type { WorkspaceTaskCounts, WorkspaceTaskItem } from "@/lib/workspace-overview";
import { WorkspaceEmbedProvider } from "@/components/workspace-embed-context";

const BoardWorkflowEditor = dynamic(
  () => import("@/components/board-workflow-editor").then((module) => module.BoardWorkflowEditor),
  { ssr: false },
);
const BoardWorkflowListPanel = dynamic(
  () => import("@/components/board-workflow-list-panel").then((module) => module.BoardWorkflowListPanel),
  { ssr: false },
);
const ProductsPage = dynamic(() => import("@/app/products/page"), { ssr: false });
const CloneMethodsPage = dynamic(() => import("@/app/clone-methods/page"), { ssr: false });
const IdentityPackPage = dynamic(() => import("@/app/identity-pack/page"), { ssr: false });
const NewProjectPage = dynamic(() => import("@/app/project/new/page"), { ssr: false });
const ClonePage = dynamic(() => import("@/app/project/clone/page"), { ssr: false });
const OperationsReviewDashboard = dynamic(
  () => import("@/components/analytics/operations-review-dashboard").then((module) => module.OperationsReviewDashboard),
  { ssr: false },
);
const LumaQuickCutPage = dynamic(
  () => import("@/components/luma-quick-cut-page").then((module) => module.LumaQuickCutPage),
  { ssr: false },
);
const ProductProductionPage = dynamic(
  () => import("@/components/product-production-page").then((module) => module.ProductProductionPage),
  { ssr: false },
);
const LumaCoreWorkspace = dynamic(
  () => import("@/components/luma-core-workspace").then((module) => module.LumaCoreWorkspace),
  { ssr: false },
);

interface ProjectItem {
  id: string;
  name: string;
  productId?: string | null;
  productName?: string | null;
  status: string;
  updatedAt?: string | Date | null;
}

interface BoardWorkflowItem {
  id: string;
  name: string;
  status: string;
  description?: string;
  nodes?: { id: string; kind?: string; status?: string }[];
  updatedAt?: string;
}

interface CloneMethodItem {
  id: string;
  name: string;
  category: string;
  description: string;
  usageMode?: "normal" | "clone" | "both";
  visualStructure?: string[];
  assetNeeds?: string[];
  directorRules?: string[];
  updatedAt?: string;
}

interface IdentityPackItem {
  packName: string;
  description: string;
  references: {
    id: string;
    title: string;
    role: string;
    url: string;
    requiredFor?: string[];
    generated?: boolean;
  }[];
}

type CurrentUser = {
  id: string;
  accountId: string;
  username: string;
  role: "admin" | "user";
  featureEntries: WorkspaceFeatureEntries;
};

type ModuleId = Exclude<WorkspaceModuleId, "overview">;
type ActivePanel = WorkspaceModuleId;

type WorkspaceModule = {
  id: ModuleId;
  href: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  shortDesc: string;
  badges: string[];
  secondary: string[];
  tone: string;
  primaryAction: string;
};

const statusMap: Record<string, { label: string; className: string; progress: number }> = {
  draft: { label: "草稿", className: "border-zinc-300/15 bg-zinc-300/10 text-zinc-100", progress: 18 },
  scripting: { label: "脚本中", className: "border-blue-300/20 bg-blue-300/12 text-blue-100", progress: 34 },
  assets: { label: "素材中", className: "border-violet-300/20 bg-violet-300/12 text-violet-100", progress: 48 },
  video: { label: "视频中", className: "border-amber-300/20 bg-amber-300/12 text-amber-100", progress: 64 },
  composing: { label: "合成中", className: "border-cyan-300/20 bg-cyan-300/12 text-cyan-100", progress: 78 },
  done: { label: "已完成", className: "border-emerald-300/20 bg-emerald-300/12 text-emerald-100", progress: 100 },
};

const emptyTaskCounts: WorkspaceTaskCounts = {
  blocked: 0,
  waiting: 0,
  running: 0,
  continue: 0,
  completed: 0,
  total: 0,
};

const workspaceModules: WorkspaceModule[] = [
  {
    id: "new",
    href: workspaceModuleHref("new"),
    icon: Plus,
    title: "新建视频项目",
    desc: "独立项目链路：选择商品素材包与脚本风格；不使用画板最新视频协议。",
    shortDesc: "开启全新视频创作链路",
    badges: ["脚本风格", "分镜链路"],
    secondary: ["商品素材包", "脚本风格", "分镜项目"],
    tone: "from-cyan-300 to-sky-400",
    primaryAction: "创建项目",
  },
  {
    id: "clone",
    href: workspaceModuleHref("clone"),
    icon: Zap,
    title: "爆款复刻",
    desc: "独立复刻项目链路；不替代画板的参考视频拆解、五图与导演稿协议。",
    shortDesc: "拆解参考，复用创作逻辑",
    badges: ["高相似", "完整视频"],
    secondary: ["参考视频", "结构拆解", "资产清单"],
    tone: "from-violet-300 to-fuchsia-400",
    primaryAction: "开始复刻",
  },
  {
    id: "board",
    href: workspaceModuleHref("board"),
    icon: GitBranch,
    title: "画板工作流",
    desc: "按节点拆解证据、素材、分镜与生成任务，适合复杂创作。",
    shortDesc: "节点式推进复杂创作",
    badges: ["节点式创作"],
    secondary: ["证据节点", "素材节点", "生成任务"],
    tone: "from-teal-300 to-cyan-400",
    primaryAction: "进入画板",
  },
  {
    id: "product-production",
    href: workspaceModuleHref("product-production"),
    icon: Factory,
    title: "商品生产线",
    desc: "以商品白底图为母版，批量生成参考视频换品成片与详情图换装结果。",
    shortDesc: "批量生产视频与详情图",
    badges: ["批量视频", "详情换装"],
    secondary: ["商品母版", "多视频多版本", "批量详情图"],
    tone: "from-cyan-200 to-violet-300",
    primaryAction: "进入生产线",
  },
  {
    id: "quick-cut",
    href: workspaceModuleHref("quick-cut"),
    icon: Scissors,
    title: "流光快剪",
    desc: "本机扫描电商素材，按口播、商品镜头与本地媒体规则批量生成深度混剪成片。",
    shortDesc: "本机批量电商混剪",
    badges: ["本地处理", "批量成片"],
    secondary: ["素材扫描", "深度混剪", "本地交付"],
    tone: "from-cyan-300 to-emerald-300",
    primaryAction: "进入快剪",
  },
  {
    id: "products",
    href: workspaceModuleHref("products"),
    icon: Package,
    title: "商品库",
    desc: "维护商品图、卖点、结构描述与素材包，让后续项目反复调用。",
    shortDesc: "管理可复用素材资产",
    badges: ["产品包", "结构键"],
    secondary: ["商品图", "卖点", "素材包"],
    tone: "from-emerald-300 to-teal-400",
    primaryAction: "管理商品",
  },
  {
    id: "methods",
    href: workspaceModuleHref("methods"),
    icon: Sparkles,
    title: "方法库",
    desc: "独立方法档案；不替代画板的证据拆解报告与当前提示词合同。",
    shortDesc: "沉淀方法与镜头语言",
    badges: ["方法沉淀", "二级入口"],
    secondary: ["创作方法", "镜头语言", "复用结构"],
    tone: "from-indigo-300 to-violet-400",
    primaryAction: "查看方法",
  },
  {
    id: "identity",
    href: workspaceModuleHref("identity"),
    icon: UserRound,
    title: "人物身份包",
    desc: "统一管理人物脸部、身材、肤色、表情口型和补齐视觉，保持成片一致。",
    shortDesc: "统一人物视觉一致性",
    badges: ["全局绑定"],
    secondary: ["脸部参考", "表情口型", "一致性"],
    tone: "from-sky-300 to-blue-400",
    primaryAction: "管理身份",
  },
  {
    id: "analytics",
    href: workspaceModuleHref("analytics"),
    icon: ChartNoAxesCombined,
    title: "经营诊断",
    desc: "导入利润表，按 Excel 原表查看店铺、商品、投放、履约与数据异常。",
    shortDesc: "经营结论与优先处理队列",
    badges: ["Excel 原表", "账户隔离"],
    secondary: ["店铺经营", "商品决策", "跨店对比"],
    tone: "from-amber-200 to-cyan-300",
    primaryAction: "查看诊断",
  },
];

export function LumaWorkspaceDashboard({ onLogout }: { onLogout: () => void }) {
  const searchParams = useSearchParams();
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceSearchRef = useRef<HTMLInputElement | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [methods, setMethods] = useState<CloneMethodItem[]>([]);
  const [boards, setBoards] = useState<BoardWorkflowItem[]>([]);
  const [identityPack, setIdentityPack] = useState<IdentityPackItem | null>(null);
  const [isRailExpanded, setIsRailExpanded] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<ActivePanel>("overview");
  const [isCreatingMethod, setIsCreatingMethod] = useState(false);
  const [moduleNotice, setModuleNotice] = useState("");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isCurrentUserLoading, setIsCurrentUserLoading] = useState(true);
  const [isFeatureWaiting, setIsFeatureWaiting] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [overviewTasks, setOverviewTasks] = useState<WorkspaceTaskItem[]>([]);
  const [overviewCounts, setOverviewCounts] = useState<WorkspaceTaskCounts>(emptyTaskCounts);
  const [overviewGeneratedAt, setOverviewGeneratedAt] = useState("");
  const [overviewError, setOverviewError] = useState("");
  const [isLoadingOverview, setIsLoadingOverview] = useState(true);
  const [workspaceSearch, setWorkspaceSearch] = useState("");

  const { llm, providers } = useSettingsStore();
  const { products } = useProductLibraryStore();
  const isConfigured = Boolean(llm.apiKey && llm.baseUrl && llm.model);
  const hasAnyProvider = Object.values(providers).some((provider) => provider.enabled && hasProviderCredential(provider));
  const isAdmin = currentUser?.role === "admin";
  const featureEntriesReady = !isCurrentUserLoading;
  const canEnterPanel = useCallback((panel: ActivePanel) => (
    currentUser?.role === "admin" || currentUser?.featureEntries?.[panel] === "open"
  ), [currentUser]);
  const activeModule = featureEntriesReady && !isFeatureWaiting && canEnterPanel(activePanel) && activePanel !== "overview"
    ? workspaceModules.find((module) => module.id === activePanel) ?? null
    : null;

  const showFeatureWaiting = useCallback((replace = false) => {
    const waitingHref = "/workspace?notice=waiting";
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref !== waitingHref) {
      window.history[replace ? "replaceState" : "pushState"]({}, "", waitingHref);
    }
    setActivePanel("overview");
    setIsFeatureWaiting(true);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  function navigateToPanel(panel: ActivePanel, entityId?: string) {
    if (!featureEntriesReady || !canEnterPanel(panel)) {
      showFeatureWaiting();
      return;
    }
    const href = workspaceModuleHref(panel, entityId);
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref !== href) window.history.pushState({}, "", href);
    setActivePanel(panel);
    setIsFeatureWaiting(false);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  useEffect(() => {
    function syncPanelFromLocation() {
      const params = new URLSearchParams(window.location.search);
      if (params.get("notice") === "waiting") {
        setActivePanel("overview");
        setIsFeatureWaiting(true);
        return;
      }
      const moduleParam = params.get("module") || "overview";
      const panel = isWorkspaceModuleId(moduleParam) ? moduleParam : "overview";
      if (featureEntriesReady && !canEnterPanel(panel)) {
        showFeatureWaiting(true);
        return;
      }
      setActivePanel(panel);
      setIsFeatureWaiting(false);
    }

    syncPanelFromLocation();
    window.addEventListener("popstate", syncPanelFromLocation);
    return () => window.removeEventListener("popstate", syncPanelFromLocation);
  }, [canEnterPanel, featureEntriesReady, searchParams, showFeatureWaiting]);

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentUser() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data: { user?: CurrentUser } = await res.json().catch(() => ({}));
        if (!cancelled) setCurrentUser(res.ok && data.user ? data.user : null);
      } catch {
        if (!cancelled) setCurrentUser(null);
      } finally {
        if (!cancelled) setIsCurrentUserLoading(false);
      }
    }

    loadCurrentUser();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isUserMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setIsUserMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsUserMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isUserMenuOpen]);

  const loadOverview = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setIsLoadingOverview(true);
    try {
      const response = await fetch("/api/workspace/overview", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "读取指挥中心任务失败");
      setOverviewTasks(Array.isArray(body.tasks) ? body.tasks : []);
      setOverviewCounts(body.counts || emptyTaskCounts);
      setOverviewGeneratedAt(typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString());
      setOverviewError("");
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : "读取指挥中心任务失败");
    } finally {
      if (!silent) setIsLoadingOverview(false);
    }
  }, []);

  useEffect(() => {
    if (!featureEntriesReady || isFeatureWaiting || activePanel !== "overview" || !canEnterPanel("overview")) return;
    void loadOverview();
    const timer = window.setInterval(() => { void loadOverview({ silent: true }); }, 10000);
    return () => window.clearInterval(timer);
  }, [activePanel, canEnterPanel, featureEntriesReady, isFeatureWaiting, loadOverview]);

  useEffect(() => {
    function focusWorkspaceSearch(event: KeyboardEvent) {
      if (activePanel !== "overview" || event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      workspaceSearchRef.current?.focus();
    }
    document.addEventListener("keydown", focusWorkspaceSearch);
    return () => document.removeEventListener("keydown", focusWorkspaceSearch);
  }, [activePanel]);

  useEffect(() => {
    let cancelled = false;

    async function loadHomeData() {
      if (!featureEntriesReady || !workspaceModules.some((module) => canEnterPanel(module.id))) return;
      try {
        const [projectRes, methodRes, boardRes, identityRes] = await Promise.all([
          fetch("/api/project", { cache: "no-store" }),
          fetch("/api/clone-methods", { cache: "no-store" }),
          fetch("/api/board-workflows", { cache: "no-store" }),
          fetch("/api/identity-pack", { cache: "no-store" }),
        ]);
        let projectData = await projectRes.json().catch(() => []);
        const methodData = await methodRes.json().catch(() => ({ methods: [] }));
        const boardData = await boardRes.json().catch(() => ({ workflows: [] }));
        const identityData = await identityRes.json().catch(() => null);

        if (!projectRes.ok) {
          throw new Error(projectData?.error || "项目列表加载失败");
        }

        if (Array.isArray(projectData) && products.length > 0) {
          const needsSync = products.filter((product) =>
            projectData.some((project: ProjectItem) => project.productId === product.id && project.productName !== product.name)
          );

          if (needsSync.length > 0) {
            await Promise.all(
              needsSync.map((product) =>
                fetch("/api/project/sync-product", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ productId: product.id, productName: product.name }),
                })
              )
            );
            const refreshedProjectRes = await fetch("/api/project", { cache: "no-store" });
            projectData = await refreshedProjectRes.json().catch(() => projectData);
          }
        }

        if (!cancelled) {
          const nextProjects = Array.isArray(projectData) ? projectData : [];
          setProjects(nextProjects);
          setMethods(Array.isArray(methodData?.methods) ? methodData.methods : []);
          setBoards(Array.isArray(boardData?.workflows) ? boardData.workflows : []);
          setIdentityPack(identityData?.pack ? {
            ...identityData.pack,
            references: (identityData.pack.references || []).filter((reference: { status?: string }) => reference.status === "approved"),
          } : null);
        }
      } catch (error) {
        if (!cancelled) setModuleNotice(error instanceof Error ? error.message : "工作台数据加载失败");
      }
    }

    loadHomeData();

    return () => {
      cancelled = true;
    };
  }, [canEnterPanel, featureEntriesReady, products]);

  async function handleCreateMethod(name: string, description: string) {
    const cleanName = name.trim();
    if (!cleanName || isCreatingMethod) return;
    setIsCreatingMethod(true);
    setModuleNotice("");
    try {
      const res = await fetch("/api/clone-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName,
          category: "自定义方法",
          usageMode: "both",
          description: description.trim() || "从工作台快速记录的创作方法。",
          visualStructure: ["开场容器", "主体动作", "商品证据", "收束镜头"],
          assetNeeds: ["参考视频", "商品结构图", "人物一致性参考"],
          directorRules: ["保留账号拍法", "动作必须可连续", "商品结构优先"],
          promptFocus: "工作台快速沉淀",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.method) throw new Error(data.error || "保存方法失败");
      setMethods((items) => [data.method, ...items.filter((item) => item.id !== data.method.id)]);
      setModuleNotice("方法已沉淀到方法库，后续项目可以直接复用。");
    } catch (error) {
      setModuleNotice(error instanceof Error ? error.message : "保存方法失败");
    } finally {
      setIsCreatingMethod(false);
    }
  }

  return (
    <div className="luma-workspace-shell flex h-screen overflow-hidden text-slate-100">
      {isMobileNavOpen && (
        <button
          type="button"
          aria-label="关闭功能导航"
          onClick={() => setIsMobileNavOpen(false)}
          className="luma-mobile-overlay fixed inset-0 z-40 bg-black/55 backdrop-blur-sm lg:hidden"
        />
      )}
      <aside
        className={`luma-workspace-rail fixed inset-y-0 left-0 z-50 w-[280px] border-r border-cyan-100/18 bg-[#061019]/36 p-3 shadow-2xl backdrop-blur-[15px] transition-transform duration-300 lg:hidden ${
          isMobileNavOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center justify-between border-b border-cyan-100/10 px-1">
            <Link href="/" className="leading-none">
              <span className="luma-brand-en block text-[11px] font-bold uppercase tracking-[0.18em]">Luma Commerce Studio</span>
              <span className="luma-brand-cn mt-1 block text-xl font-black">流光商影</span>
            </Link>
            <button
              type="button"
              onClick={() => setIsMobileNavOpen(false)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-cyan-50"
              title="关闭导航"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto py-3">
            <RailButton
              icon={LayoutDashboard}
              title="流光创作引擎"
              desc="创作指挥中心"
              expanded
              active={activePanel === "overview"}
              locked={featureEntriesReady && !canEnterPanel("overview")}
              onClick={() => {
                navigateToPanel("overview");
                setIsMobileNavOpen(false);
              }}
            />
            <div className="my-2 h-px bg-cyan-100/10" />
            {workspaceModules.map((module) => (
              <RailButton
                key={module.id}
                icon={module.icon}
                title={module.title}
                desc={module.shortDesc}
                expanded
                active={activePanel === module.id}
                locked={featureEntriesReady && !canEnterPanel(module.id)}
                onClick={() => {
                  navigateToPanel(module.id);
                  setIsMobileNavOpen(false);
                }}
              />
            ))}
          </nav>
          {isAdmin && <RailLink href="/settings" icon={Settings} title="模型与API" desc="通道与配置" expanded />}
        </div>
      </aside>
      <aside
        className={`luma-workspace-rail relative z-20 hidden shrink-0 border-r border-cyan-100/16 bg-[#061019]/20 shadow-[inset_-1px_0_0_rgba(103,232,249,0.08)] backdrop-blur-[15px] transition-[width] duration-300 lg:block ${
          isRailExpanded ? "w-[276px]" : "w-[68px]"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className={`flex h-16 items-center gap-2.5 border-b border-cyan-100/10 ${isRailExpanded ? "justify-between px-3" : "justify-start px-2.5"}`}>
            <Link
              href="/"
              className={`min-w-0 overflow-hidden leading-none transition-[max-width,opacity,transform] duration-200 ${
                isRailExpanded ? "max-w-[196px] translate-x-0 opacity-100" : "pointer-events-none max-w-0 -translate-x-2 opacity-0"
              }`}
              aria-hidden={!isRailExpanded}
              tabIndex={isRailExpanded ? 0 : -1}
            >
              <span className="luma-brand-en block truncate whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.12em]">
                Luma Commerce Studio
              </span>
              <span className="luma-brand-cn mt-1 block truncate text-xl font-black tracking-tight">
                流光商影
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setIsRailExpanded((value) => !value)}
              data-border-glow
              className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.045] text-cyan-100 transition hover:border-cyan-200/35 hover:bg-cyan-200/10 ${
                isRailExpanded ? "h-9 w-9" : "h-12 w-12"
              }`}
              title={isRailExpanded ? "收起导航" : "展开导航"}
            >
              {isRailExpanded ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-[18px] w-[18px]" />}
            </button>
          </div>

          <div className="px-2.5 py-3">
            <RailButton
              icon={LayoutDashboard}
              title="流光创作引擎"
              desc="创作指挥中心"
              expanded={isRailExpanded}
              active={activePanel === "overview"}
              locked={featureEntriesReady && !canEnterPanel("overview")}
              onClick={() => navigateToPanel("overview")}
            />
            <div className="my-2 h-px bg-cyan-100/10" />
            {workspaceModules.map((module) => (
              <RailButton
                key={module.id}
                icon={module.icon}
                title={module.title}
                desc={module.shortDesc}
                expanded={isRailExpanded}
                active={activePanel === module.id}
                locked={featureEntriesReady && !canEnterPanel(module.id)}
                onClick={() => navigateToPanel(module.id)}
              />
            ))}
          </div>

          {isAdmin && (
            <div className="mt-auto px-2.5 pb-3">
              <RailLink href="/settings" icon={Settings} title="模型与API" desc="通道与配置" expanded={isRailExpanded} />
            </div>
          )}
        </div>
      </aside>

      <div className="min-h-0 min-w-0 flex-1">
        <header className="luma-workspace-header sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-cyan-100/14 bg-[#061019]/16 px-4 backdrop-blur-[15px] lg:px-6">
          <button
            type="button"
            onClick={() => setIsMobileNavOpen(true)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-cyan-50 lg:hidden"
            title="打开功能导航"
          >
            <Menu className="h-4 w-4" />
          </button>
          <Link href="/" className="flex w-[214px] shrink-0 flex-col items-start leading-none lg:hidden">
            <span className="luma-brand-en whitespace-nowrap text-[12px] font-bold uppercase tracking-[0.18em]">Luma Commerce Studio</span>
            <span className="luma-brand-cn mt-1 text-2xl font-black tracking-tight">
              流光商影
            </span>
          </Link>

          <div className="hidden min-w-0 flex-1 items-center lg:flex">
            <div data-border-glow className="relative mx-auto w-full max-w-xl rounded-full">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-100/55" />
              <input
                ref={workspaceSearchRef}
                value={workspaceSearch}
                onChange={(event) => setWorkspaceSearch(event.target.value)}
                className="h-10 w-full rounded-full border border-white/10 bg-white/[0.055] px-11 text-sm text-slate-100 outline-none backdrop-blur-2xl transition placeholder:text-slate-400/65 focus:border-cyan-200/38 focus:bg-cyan-200/8"
                placeholder={activePanel === "overview" ? "搜索任务、阶段或模块..." : "任务搜索在指挥中心生效"}
                aria-label="搜索指挥中心任务"
              />
              {workspaceSearch && (
                <button
                  type="button"
                  onClick={() => setWorkspaceSearch("")}
                  className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-white/[0.06] hover:text-cyan-50"
                  aria-label="清除任务搜索"
                  title="清除搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div ref={userMenuRef} className="relative z-[80] hidden h-9 w-[110px] shrink-0 md:block">
              <button
                type="button"
                onClick={() => setIsUserMenuOpen((value) => !value)}
                data-border-glow
                className="relative z-[82] inline-flex h-9 w-full items-center gap-2 rounded-full border border-cyan-100/16 bg-white/[0.055] px-2 pr-2.5 text-cyan-50 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/42 hover:bg-cyan-200/10"
                aria-haspopup="menu"
                aria-expanded={isUserMenuOpen}
                title={currentUser ? `${currentUser.username} · ${currentUser.accountId}` : "当前账号"}
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-100/24 bg-cyan-200/12 text-cyan-100">
                  <UserRound className="h-4 w-4" />
                </span>
                <span className="min-w-0 truncate text-xs font-semibold text-slate-100">
                  {currentUser?.username || "当前账号"}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-100/62 transition ${isUserMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {isUserMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-1/2 top-5 z-[80] w-72 -translate-x-1/2 overflow-hidden rounded-lg border border-cyan-100/18 bg-[#061019]/72 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_34px_rgba(34,211,238,0.12)] backdrop-blur-[18px]"
                >
                  <div className="flex items-center gap-3 border-b border-cyan-100/10 px-4 py-4">
                    <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-cyan-100/24 bg-cyan-200/12 text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.14)]">
                      <UserRound className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-slate-50">{currentUser?.username || "当前账号"}</div>
                      <div className="mt-1 text-xs font-medium text-cyan-100/62">{isAdmin ? "管理员" : "普通用户"}</div>
                    </div>
                  </div>

                  <div className="space-y-2 border-b border-cyan-100/10 px-4 py-3">
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.045] px-3 py-2">
                      <span className="text-xs text-slate-400">用户 ID</span>
                      <span className="truncate font-mono text-xs font-semibold text-cyan-100">{currentUser?.accountId || "--"}</span>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.035] px-3 py-2 text-sm font-semibold text-slate-200">
                      <UserRound className="h-4 w-4 text-cyan-100/72" />
                      个人资料
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="border-b border-cyan-100/10 px-2 py-2">
                      <Link
                        href="/settings"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-cyan-200/10 hover:text-cyan-50"
                        role="menuitem"
                      >
                        <Settings className="h-4 w-4 text-cyan-100/72" />
                        模型与API
                      </Link>
                      <Link
                        href="/settings?tab=system"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-cyan-200/10 hover:text-cyan-50"
                        role="menuitem"
                      >
                        <LayoutDashboard className="h-4 w-4 text-cyan-100/72" />
                        系统管理
                      </Link>
                    </div>
                  )}

                  <div className="px-2 py-2">
                    <button
                      type="button"
                      onClick={onLogout}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-rose-100 transition hover:bg-rose-300/10 hover:text-rose-50"
                      role="menuitem"
                    >
                      <LogOut className="h-4 w-4" />
                      退出登录
                    </button>
                  </div>
                </div>
              )}
            </div>
            <span data-border-glow className="hidden items-center gap-2 rounded-full border border-emerald-200/14 bg-emerald-300/8 px-3 py-2 text-xs font-semibold text-emerald-100/88 backdrop-blur-2xl md:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(110,231,183,0.9)]" />
              引擎在线
            </span>
            <Link
              href="/"
              data-border-glow
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10"
              title="返回首页"
            >
              <House className="h-4 w-4" />
            </Link>
            {isAdmin && (
              <Link
                href="/settings"
                data-border-glow
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10"
                title="模型与API"
              >
                <Settings className="h-4 w-4" />
              </Link>
            )}
          </div>
        </header>

        <main className="flex h-[calc(100vh-4rem)] min-h-0 min-w-0 flex-col overflow-hidden px-4 py-4 lg:px-6">
          <section className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 overflow-hidden">
            {!featureEntriesReady ? (
              <WorkspaceFeatureGateLoading />
            ) : isFeatureWaiting || !canEnterPanel(activePanel) ? (
              <WorkspaceFeatureWaiting />
            ) : activeModule ? (
              <NativeModuleWorkspace
                module={activeModule}
                projects={projects}
                products={products}
                methods={methods}
                boards={boards}
                identityPack={identityPack}
                notice={moduleNotice}
                currentUser={currentUser}
                isCreatingMethod={isCreatingMethod}
                onCreateMethod={handleCreateMethod}
                onBackToOverview={() => navigateToPanel("overview")}
                onNavigate={navigateToPanel}
              />
            ) : (
              <LumaCoreWorkspace
                tasks={overviewTasks}
                counts={overviewCounts}
                search={workspaceSearch}
                isLoading={isLoadingOverview}
                error={overviewError}
                generatedAt={overviewGeneratedAt}
                needsProviderSetup={!isConfigured || !hasAnyProvider}
                onRefresh={() => { void loadOverview(); }}
                onSearch={setWorkspaceSearch}
                onNavigate={navigateToPanel}
              />
            )}

          </section>
        </main>
      </div>
    </div>
  );
}

function WorkspaceFeatureGateLoading() {
  return (
    <section className="flex h-full min-h-0 items-center justify-center rounded-lg border border-cyan-100/14 bg-[#061019]/26 px-6 text-center backdrop-blur-[12px]">
      <div>
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-100/18 bg-cyan-200/8 text-cyan-100">
          <LockKeyhole className="h-4 w-4 animate-pulse" />
        </div>
        <p className="mt-3 text-sm font-semibold text-slate-100">正在确认功能状态</p>
      </div>
    </section>
  );
}

function WorkspaceFeatureWaiting() {
  return (
    <section className="flex h-full min-h-0 items-center justify-center rounded-lg border border-cyan-100/14 bg-[#061019]/26 px-6 text-center backdrop-blur-[12px]">
      <div className="max-w-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg border border-violet-200/20 bg-violet-300/8 text-violet-100">
          <LockKeyhole className="h-5 w-5" />
        </div>
        <h1 className="mt-4 text-xl font-black text-slate-50">正在测试，等待开放</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300/72">该功能暂未对当前账号开放。</p>
      </div>
    </section>
  );
}

function NativeModuleWorkspace({
  module,
  projects,
  products,
  methods,
  boards,
  identityPack,
  notice,
  currentUser,
  isCreatingMethod,
  onCreateMethod,
  onBackToOverview,
  onNavigate,
}: {
  module: WorkspaceModule;
  projects: ProjectItem[];
  products: ProductItem[];
  methods: CloneMethodItem[];
  boards: BoardWorkflowItem[];
  identityPack: IdentityPackItem | null;
  notice: string;
  currentUser: CurrentUser | null;
  isCreatingMethod: boolean;
  onCreateMethod: (name: string, description: string) => Promise<void>;
  onBackToOverview: () => void;
  onNavigate: (panel: ActivePanel, entityId?: string) => void;
}) {
  const Icon = module.icon;
  const searchParams = useSearchParams();
  const selectedBoardWorkflowId = module.id === "board" ? searchParams.get("boardId") : null;
  const selectedQuickCutTaskId = module.id === "quick-cut" ? searchParams.get("taskId") : null;
  const [methodName, setMethodName] = useState("新方法");
  const [methodDescription, setMethodDescription] = useState("记录参考视频的结构、镜头语言、资产需求和导演规则。");
  const [createdProjectPath, setCreatedProjectPath] = useState<string | null>(null);

  const activeProjects =
    module.id === "clone" ? projects.filter((project) => project.status !== "done").slice(0, 3) : projects.slice(0, 3);

  async function submitMethod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onCreateMethod(methodName, methodDescription);
  }

  if (module.id === "new") {
    return (
      <EmbeddedRouteShell title={module.title} onBack={onBackToOverview}>
        {createdProjectPath ? (
          <EmbeddedProjectReady
            title="新项目已经创建"
            targetPath={createdProjectPath}
            onCreateAnother={() => setCreatedProjectPath(null)}
          />
        ) : (
          <WorkspaceEmbedProvider onProjectCreated={setCreatedProjectPath}>
            <NewProjectPage />
          </WorkspaceEmbedProvider>
        )}
      </EmbeddedRouteShell>
    );
  }

  if (module.id === "clone") {
    return (
      <EmbeddedRouteShell title={module.title} onBack={onBackToOverview}>
        {createdProjectPath ? (
          <EmbeddedProjectReady
            title="复刻项目已经创建"
            targetPath={createdProjectPath}
            onCreateAnother={() => setCreatedProjectPath(null)}
          />
        ) : (
          <WorkspaceEmbedProvider onProjectCreated={setCreatedProjectPath}>
            <ClonePage />
          </WorkspaceEmbedProvider>
        )}
      </EmbeddedRouteShell>
    );
  }

  if (module.id === "board") {
    return (
      <section className="min-h-0 overflow-hidden rounded-lg border border-cyan-100/12 bg-white/[0.022] shadow-[0_24px_90px_rgba(0,0,0,0.22)] backdrop-blur-[15px] [--glass-card-blur:5px]">
        {selectedBoardWorkflowId ? (
          <BoardWorkflowEditor
            embedded
            workflowId={selectedBoardWorkflowId}
            onBackToList={() => {
              onNavigate("board");
            }}
          />
        ) : (
          <BoardWorkflowListPanel
            embedded
            onBackToWorkspace={onBackToOverview}
            onOpenWorkflow={(workflowId) => {
              onNavigate("board", workflowId);
            }}
          />
        )}
      </section>
    );
  }

  if (module.id === "quick-cut") {
    return <LumaQuickCutPage initialTaskId={selectedQuickCutTaskId} />;
  }

  if (module.id === "product-production") {
    return <ProductProductionPage />;
  }

  if (module.id === "products") {
    return (
      <EmbeddedRouteShell title={module.title} onBack={onBackToOverview}>
        <WorkspaceEmbedProvider>
          <ProductsPage />
        </WorkspaceEmbedProvider>
      </EmbeddedRouteShell>
    );
  }

  if (module.id === "methods") {
    return (
      <EmbeddedRouteShell title={module.title} onBack={onBackToOverview}>
        <WorkspaceEmbedProvider>
          <CloneMethodsPage />
        </WorkspaceEmbedProvider>
      </EmbeddedRouteShell>
    );
  }

  if (module.id === "identity") {
    return (
      <EmbeddedRouteShell title={module.title} onBack={onBackToOverview}>
        <WorkspaceEmbedProvider>
          <IdentityPackPage />
        </WorkspaceEmbedProvider>
      </EmbeddedRouteShell>
    );
  }

  if (module.id === "analytics") {
    return (
      <div className="h-full min-h-0 min-w-0 w-full">
        <OperationsReviewDashboard currentUser={currentUser} />
      </div>
    );
  }

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-cyan-100/12 bg-white/[0.022] shadow-[0_24px_90px_rgba(0,0,0,0.22)] backdrop-blur-[15px]">
      <div className="flex h-12 items-center justify-between gap-3 border-b border-white/10 bg-black/12 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-gradient-to-br ${module.tone} text-slate-950`}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-50">{module.title}</p>
            <p className="truncate text-[10px] text-slate-400/78">原生接入当前模块，左侧切换不会离开工作台</p>
          </div>
        </div>
        <Link
          href={workspaceModuleHref(module.id)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-100/18 bg-white/[0.045] px-2.5 py-1.5 text-[11px] font-semibold text-cyan-50 transition hover:bg-cyan-100/10"
        >
          打开完整编辑器
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#061019]/30 p-3 backdrop-blur-[8px]">
          {module.id === "new" && (
            <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)]">
              <GlassBlock title="新建生产线" kicker="PROJECT SEED">
                <p className="text-sm leading-6 text-slate-300/78">
                  先选择商品、方法和人物身份包，系统会生成脚本、分镜与资产任务。这里保留快速入口，完整向导仍在原来的项目创建页。
                </p>
                <div className="mt-4 grid gap-2">
                  <Link href={workspaceModuleHref("new")} className="workspace-action-primary">
                    创建普通项目 <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link href={workspaceModuleHref("clone")} className="workspace-action-secondary">
                    从参考视频复刻 <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </GlassBlock>
              <CompactList
                title="最近生产任务"
                empty="还没有项目，先创建一个视频项目。"
                items={activeProjects.map((project) => ({
                  id: project.id,
                  title: project.name,
                  desc: project.productName || "未绑定商品",
                  meta: statusMap[project.status]?.label || project.status,
                  href: `/project/${project.id}/script`,
                }))}
              />
            </div>
          )}

          {module.id === "clone" && (
            <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <CompactList
                title="可用复刻方法"
                empty="方法库为空，先沉淀一个参考视频方法。"
                items={methods.slice(0, 5).map((method) => ({
                  id: method.id,
                  title: method.name,
                  desc: method.description || method.category,
                  meta: method.category,
                  href: workspaceModuleHref("methods"),
                }))}
              />
              <GlassBlock title="复刻准备区" kicker="REFERENCE OPS">
                <div className="space-y-2 text-sm text-slate-300/78">
                  <p>1. 上传参考视频，抽取结构、节奏和镜头语言。</p>
                  <p>2. 绑定商品与身份包，生成可复用资产清单。</p>
                  <p>3. 进入项目后继续脚本和分镜生成。</p>
                </div>
                <Link href={workspaceModuleHref("clone")} className="workspace-action-primary mt-4">
                  开始复刻 <ArrowRight className="h-4 w-4" />
                </Link>
              </GlassBlock>
            </div>
          )}

          {module.id === "products" && (
            <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
              <CompactList
                title="商品素材包"
                empty="商品库为空，先添加一个商品素材包。"
                items={products.slice(0, 6).map((product) => ({
                  id: product.id,
                  title: product.name,
                  desc: product.description || product.usageScenarios || "未填写描述",
                  meta: `${product.images.length} 张图`,
                  href: workspaceModuleHref("products"),
                }))}
              />
              <GlassBlock title="结构锁" kicker="PRODUCT LOCK">
                <p className="text-sm leading-6 text-slate-300/78">
                  商品图是唯一结构真相。后续脚本、方法库、人物身份和参考视频都不能改写商品颜色、材质、版型与关键细节。
                </p>
                <Link href={workspaceModuleHref("products")} className="workspace-action-primary mt-4">
                  管理商品库 <ArrowRight className="h-4 w-4" />
                </Link>
              </GlassBlock>
            </div>
          )}

          {module.id === "methods" && (
            <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
              <form onSubmit={submitMethod} className="rounded-lg border border-cyan-100/12 bg-black/18 p-3">
                <p className="mb-3 text-sm font-bold text-cyan-50">快速沉淀方法</p>
                <label className="workspace-label">
                  方法名称
                  <input value={methodName} onChange={(event) => setMethodName(event.target.value)} className="workspace-input" />
                </label>
                <label className="workspace-label mt-3">
                  方法说明
                  <textarea value={methodDescription} onChange={(event) => setMethodDescription(event.target.value)} className="workspace-textarea" />
                </label>
                <button type="submit" disabled={isCreatingMethod} className="workspace-action-primary mt-3 w-full disabled:opacity-50">
                  {isCreatingMethod ? "保存中..." : "保存方法"}
                </button>
                {notice && <p className="mt-3 rounded-md border border-violet-100/14 bg-violet-100/8 px-3 py-2 text-xs text-violet-50">{notice}</p>}
              </form>
              <CompactList
                title="方法库"
                empty="方法库为空。"
                items={methods.slice(0, 6).map((method) => ({
                  id: method.id,
                  title: method.name,
                  desc: method.description || "未填写说明",
                  meta: method.usageMode === "clone" ? "复刻" : method.usageMode === "normal" ? "普通" : "通用",
                  href: workspaceModuleHref("methods"),
                }))}
              />
            </div>
          )}

          {module.id === "identity" && (
            <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-h-0 overflow-hidden rounded-lg border border-white/10 bg-black/14 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-cyan-50">身份参考</h3>
                  <span className="text-xs text-slate-400">{identityPack?.references.length || 0} 张</span>
                </div>
                <div className="grid max-h-[260px] grid-cols-2 gap-2 overflow-hidden">
                  {(identityPack?.references || []).slice(0, 6).map((reference) => (
                    <Link key={reference.id} href={workspaceModuleHref("identity")} className="group overflow-hidden rounded-lg border border-white/10 bg-white/[0.045]">
                      <div className="h-20 bg-cover bg-center opacity-80 transition group-hover:opacity-100" style={{ backgroundImage: `url(${reference.url})` }} />
                      <div className="p-2">
                        <p className="truncate text-xs font-semibold text-slate-100">{reference.title}</p>
                        <p className="mt-1 line-clamp-2 text-[10px] text-slate-400/78">{reference.role}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
              <GlassBlock title={identityPack?.packName || "身份包"} kicker="IDENTITY LOCK">
                <p className="text-sm leading-6 text-slate-300/78">
                  {identityPack?.description || "统一锁定人物脸型、身材、肤色、发型、表情口型与补齐视觉，保持成片一致。"}
                </p>
                <Link href={workspaceModuleHref("identity")} className="workspace-action-primary mt-4">
                  管理身份包 <ArrowRight className="h-4 w-4" />
                </Link>
              </GlassBlock>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-hidden rounded-lg border border-cyan-100/12 bg-[#061019]/36 p-3 backdrop-blur-[8px]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-100/60">Module Console</p>
          <h3 className="mt-2 text-lg font-black text-slate-50">{module.title}</h3>
          <p className="mt-2 text-xs leading-5 text-slate-300/72">{module.shortDesc}</p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <MiniMetric label="项目" value={projects.length} />
            <MiniMetric label="商品" value={products.length} />
            <MiniMetric label="方法" value={methods.length} />
            <MiniMetric label="画板" value={boards.length} />
          </div>

          <div className="mt-4 rounded-lg border border-white/10 bg-black/14 p-3">
            <p className="mb-3 text-xs font-bold text-slate-100">二级能力</p>
            <div className="space-y-2">
              {module.secondary.map((item, index) => (
                <div key={item} className="flex items-center gap-2 rounded-md border border-cyan-100/10 bg-cyan-100/6 px-2.5 py-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-cyan-200/12 text-[10px] font-black text-cyan-100">0{index + 1}</span>
                  <span className="text-xs font-semibold text-slate-200">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function EmbeddedRouteShell({ children, title, onBack }: { children: ReactNode; title?: string; onBack?: () => void }) {
  return (
    <section className="luma-route-embedded luma-workspace-panel min-h-0 overflow-hidden rounded-lg border border-cyan-100/16 bg-white/[0.008] shadow-[0_24px_90px_rgba(0,0,0,0.18)] backdrop-blur-[15px] [--glass-card-blur:5px]">
      {onBack && (
        <div className="flex h-12 items-center justify-between border-b border-cyan-100/10 bg-[#061019]/42 px-4 backdrop-blur-2xl">
          <button
            type="button"
            onClick={onBack}
            className="order-2 inline-flex items-center gap-1.5 rounded-lg border border-cyan-100/18 bg-white/[0.045] px-3 py-1.5 text-xs font-semibold text-cyan-50 transition hover:bg-cyan-100/10"
          >
            <ChevronLeft className="h-4 w-4" />
            返回工作台
          </button>
          {title && <span className="order-1 truncate text-xs font-semibold text-slate-300/72">{title}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

function EmbeddedProjectReady({
  title,
  targetPath,
  onCreateAnother,
}: {
  title: string;
  targetPath: string;
  onCreateAnother: () => void;
}) {
  return (
    <div className="flex h-full min-h-[420px] items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-cyan-100/18 bg-[#07141d]/70 p-6 text-center shadow-[0_24px_90px_rgba(0,0,0,0.3)] backdrop-blur-[8px]">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-emerald-200/20 bg-emerald-300/10 text-emerald-100">
          <Play className="h-5 w-5" />
        </span>
        <h2 className="mt-4 text-2xl font-black text-slate-50">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-300/80">
          创建流程已完成，工作台不会自动跳走。你可以继续进入脚本与分镜编辑，或留在这里再创建一个项目。
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button type="button" onClick={onCreateAnother} className="workspace-action-secondary">
            再创建一个
          </button>
          <Link href={targetPath} className="workspace-action-primary">
            继续编辑 <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function GlassBlock({ title, kicker, children }: { title: string; kicker: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-cyan-100/12 bg-white/[0.045] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-[8px]">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-100/58">{kicker}</p>
      <h3 className="text-xl font-black text-slate-50">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function CompactList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; title: string; desc: string; meta: string; href: string }[];
}) {
  return (
    <div className="min-h-0 overflow-hidden rounded-lg border border-white/10 bg-black/14 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-cyan-50">{title}</h3>
        <span className="text-xs text-slate-400">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <EmptyProjectState title={empty} desc="左侧模块保持不跳转，深编辑入口会在右侧提供。" />
      ) : (
        <div className="grid max-h-[300px] gap-2 overflow-hidden">
          {items.map((item) => (
            <Link key={item.id} href={item.href} className="group rounded-lg border border-white/10 bg-white/[0.04] p-3 transition hover:border-cyan-100/30 hover:bg-cyan-100/8">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-50">{item.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400/78">{item.desc}</p>
                </div>
                <span className="shrink-0 rounded-md border border-cyan-100/12 bg-cyan-100/8 px-2 py-1 text-[10px] font-semibold text-cyan-50">
                  {item.meta}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
      <p className="text-[10px] font-semibold text-slate-400/78">{label}</p>
      <p className="mt-1 text-2xl font-black text-cyan-50">{value}</p>
    </div>
  );
}

function RailButton({
  icon: Icon,
  title,
  desc,
  expanded,
  active,
  locked = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  expanded: boolean;
  active?: boolean;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-border-glow
      title={expanded ? undefined : locked ? `${title} · 正在测试，等待开放` : title}
      className={`group relative mb-1 flex items-center gap-2.5 rounded-lg border py-1.5 text-left transition ${
        expanded ? "min-h-12 w-full justify-start px-2.5" : "h-12 min-h-12 w-12 justify-center px-0"
      } ${
        active
          ? "border-cyan-200/34 bg-cyan-200/[0.055] text-cyan-50 shadow-[0_0_28px_rgba(34,211,238,0.1)]"
          : "border-transparent text-slate-200 hover:border-white/12 hover:bg-white/[0.025] hover:text-cyan-50"
      }`}
    >
      {active && <span className="absolute left-0 top-2 h-8 w-0.5 rounded-full bg-cyan-200 shadow-[0_0_18px_rgba(103,232,249,0.9)]" />}
      <span className={`flex shrink-0 items-center justify-center transition ${expanded ? "h-8 w-8" : "h-12 w-12"} ${
        active
          ? "text-cyan-100 drop-shadow-[0_0_8px_rgba(103,232,249,0.48)]"
          : locked ? "text-amber-100/80 group-hover:text-amber-50" : "text-violet-200 group-hover:text-cyan-100"
      }`}>
        {locked ? <LockKeyhole className={expanded ? "h-[16px] w-[16px]" : "h-[17px] w-[17px]"} /> : <Icon className={expanded ? "h-[17px] w-[17px]" : "h-[18px] w-[18px]"} />}
      </span>
      {expanded && (
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-bold text-slate-50">{title}</span>
          <span className={`mt-0.5 block truncate text-[11px] font-medium ${locked ? "text-amber-100/76" : "text-slate-300"}`}>{locked ? "正在测试，等待开放" : desc}</span>
        </span>
      )}
    </button>
  );
}

function RailLink({
  href,
  icon: Icon,
  title,
  desc,
  expanded,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  expanded: boolean;
}) {
  return (
    <Link
      href={href}
      data-border-glow
      title={expanded ? undefined : title}
      className={`group relative mb-1 flex items-center gap-2.5 rounded-lg border border-transparent py-1.5 text-slate-200 transition hover:border-white/12 hover:bg-white/[0.025] hover:text-cyan-50 ${
        expanded ? "min-h-12 w-full justify-start px-2.5" : "h-12 min-h-12 w-12 justify-center px-0"
      }`}
    >
      <span className={`flex shrink-0 items-center justify-center text-violet-200 transition group-hover:text-cyan-100 ${expanded ? "h-8 w-8" : "h-12 w-12"}`}>
        <Icon className={expanded ? "h-[17px] w-[17px]" : "h-[18px] w-[18px]"} />
      </span>
      {expanded && (
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-bold text-slate-50">{title}</span>
          <span className="mt-0.5 block truncate text-[11px] font-medium text-slate-300">{desc}</span>
        </span>
      )}
    </Link>
  );
}

function EmptyProjectState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-white/10 bg-black/12 px-4 py-10 text-center">
      <p className="mb-2 text-slate-100">{title}</p>
      <p className="text-xs text-slate-300/62">{desc}</p>
    </div>
  );
}
