"use client";

/* eslint-disable @next/next/no-img-element -- User-selected local preview images are intentionally rendered without remote optimization. */
import { useCallback, useEffect, useState, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { LuChartNoAxesCombined, LuChevronDown, LuChevronLeft, LuChevronRight, LuEye, LuFactory, LuGitBranch, LuHouse, LuLayoutDashboard, LuPackage, LuPalette, LuPlus, LuRefreshCw, LuSave, LuScissors, LuSearch, LuSettings, LuSparkles, LuTrash2, LuUpload, LuUserRound, LuZap } from "react-icons/lu";
import { useSettingsStore, type ImageModelChannel, type VideoModelChannel } from "@/lib/stores/settings-store";
import {
  defaultBoardVideoDurationOptions,
  defaultBoardVideoMaxReferenceAudios,
  defaultBoardVideoMaxReferenceImages,
  defaultBoardVideoMaxReferenceVideos,
  formatBoardVideoDurationOptions,
  parseBoardVideoDurationOptions,
} from "@/lib/board-video-protocol";
import { useBrandStore } from "@/lib/stores/brand-store";
import {
  WORKSPACE_FEATURES,
  WORKSPACE_NAVIGATION,
  type WorkspaceFeatureEntryState,
  type WorkspaceModuleId,
} from "@/lib/workspace-navigation";
import { SERVER_MANAGED_API_KEY } from "@/lib/auth-constants";
import {
  EMPTY_VIDEO_REFERENCE_HOSTING,
  type VideoReferenceHostingSetting,
} from "@/lib/video-reference-hosting-types";

// AI 平台配置信息
const AI_PROVIDERS = [
  {
    key: "openai-seedance",
    name: "自有 OpenAI / Seedance",
    description: "适配当前 LLM、GPT Image 2 / image-2、Seedance、Grok 和其他 OpenAI 兼容视频接口",
    tip: "这里只登记可用模型通道；具体项目里再选择本次使用哪个生图模型和视频模型",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v20" />
        <path d="M2 12h20" />
        <path d="m4.93 4.93 14.14 14.14" />
        <path d="m19.07 4.93-14.14 14.14" />
      </svg>
    ),
    iconBg: "from-violet-500 to-fuchsia-500",
    primary: true,
  },
  {
    key: "atlas-cloud",
    name: "Atlas Cloud",
    description: "高质量图像和视频生成平台，支持多种 AI 模型",
    tip: "推荐首选，模型最全最便宜",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
    ),
    iconBg: "from-blue-500 to-cyan-500",
  },
  {
    key: "fal-ai",
    name: "fal.ai",
    description: "快速推理平台，支持 Flux、SDXL 等主流图像生成模型",
    tip: "支持 Kling 3.0、Veo 3 等最新模型",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    iconBg: "from-purple-500 to-pink-500",
  },
  {
    key: "volcengine",
    name: "火山引擎",
    description: "字节跳动旗下云服务，提供豆包大模型和视频生成能力",
    tip: "字节系模型 Seedance/Seedream，中文优化好",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
      </svg>
    ),
    iconBg: "from-orange-500 to-red-500",
  },
  {
    key: "alibaba",
    name: "阿里百炼",
    description: "阿里云大模型服务平台，支持通义系列模型和图像生成",
    tip: "万相系列，商品图生视频效果佳",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
    iconBg: "from-amber-500 to-orange-500",
  },
  {
    key: "siliconflow",
    name: "硅基流动",
    description: "国产 AI 推理平台，提供高性价比的模型推理服务",
    tip: "国产高性价比推理平台",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2" />
        <path d="M15 20v2" />
        <path d="M2 15h2" />
        <path d="M2 9h2" />
        <path d="M20 15h2" />
        <path d="M20 9h2" />
        <path d="M9 2v2" />
        <path d="M9 20v2" />
      </svg>
    ),
    iconBg: "from-emerald-500 to-teal-500",
  },
];

const PRIMARY_AI_PROVIDERS = AI_PROVIDERS.filter((provider) => provider.primary);
const ADVANCED_AI_PROVIDERS = AI_PROVIDERS.filter((provider) => !provider.primary);

type CapabilityTestStatus = "idle" | "testing" | "success" | "error";

function CapabilityTestStatusPill({ status }: { status: CapabilityTestStatus }) {
  const content = {
    idle: { label: "未测试", className: "border-slate-300/20 bg-slate-200/5 text-slate-300" },
    testing: { label: "请求中", className: "border-cyan-300/30 bg-cyan-300/10 text-cyan-200" },
    success: { label: "已返回 · 待人工验收", className: "border-violet-300/30 bg-violet-300/10 text-violet-100" },
    error: { label: "请求失败", className: "border-rose-300/30 bg-rose-300/10 text-rose-200" },
  }[status];

  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${content.className}`}>
      {content.label}
    </span>
  );
}

let settingsWorkspaceModules = [
  { href: "/workspace?module=analytics", icon: LuChartNoAxesCombined, title: "经营诊断", desc: "利润与经营复盘" },
  { href: "/workspace?module=overview", icon: LuLayoutDashboard, title: "流光创作引擎", desc: "创作指挥中心" },
  { href: "/workspace?module=new", icon: LuPlus, title: "新建视频项目", desc: "开启全新链路" },
  { href: "/workspace?module=clone", icon: LuZap, title: "爆款复刻", desc: "拆解参考逻辑" },
  { href: "/workspace?module=board", icon: LuGitBranch, title: "画板工作流", desc: "节点式推进" },
  { href: "/workspace?module=product-production", icon: LuFactory, title: "商品生产线", desc: "视频与详情图批量生产" },
  { href: "/workspace?module=quick-cut", icon: LuScissors, title: "流光快剪", desc: "本机批量电商混剪" },
  { href: "/workspace?module=products", icon: LuPackage, title: "商品库", desc: "素材资产管理" },
  { href: "/workspace?module=methods", icon: LuSparkles, title: "方法库", desc: "镜头语言沉淀" },
  { href: "/workspace?module=identity", icon: LuUserRound, title: "人物身份包", desc: "视觉一致性" },
];

// 密码输入框（可切换显示/隐藏）
settingsWorkspaceModules = WORKSPACE_NAVIGATION.map((module) => ({
  ...module,
  icon: settingsWorkspaceModules.find((item) => item.href === module.href)?.icon ?? LuLayoutDashboard,
}));

function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
  disabled = false,
  onReveal,
  onHideRevealedValue,
  revealing = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  onReveal?: () => void;
  onHideRevealedValue?: () => void;
  revealing?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [revealedFromStorage, setRevealedFromStorage] = useState(false);

  return (
    <div className={`relative ${className ?? ""}`}>
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => {
          setRevealedFromStorage(false);
          onChange(e.target.value);
        }}
        autoComplete="new-password"
        placeholder={placeholder}
        disabled={disabled}
        className="pr-10 font-mono text-xs"
      />
      <button
        type="button"
        onClick={() => {
          if (visible) {
            if (revealedFromStorage) {
              onHideRevealedValue?.();
              setRevealedFromStorage(false);
            }
            setVisible(false);
            return;
          }

          if (!value && onReveal) {
            setRevealedFromStorage(true);
            onReveal();
          }
          setVisible(true);
        }}
        disabled={disabled || revealing}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
      >
        {visible ? (
          // 隐藏图标
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          </svg>
        ) : (
          // 显示图标
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function ProtectedConfigInput({
  value,
  onChange,
  placeholder,
  onReveal,
  onHideRevealedValue,
  revealing = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onReveal?: () => void;
  onHideRevealedValue?: () => void;
  revealing?: boolean;
}) {
  const isServerManaged = value === SERVER_MANAGED_API_KEY;
  return (
    <PasswordInput
      value={isServerManaged ? "" : value}
      onChange={onChange}
      placeholder={isServerManaged ? "已加密保存，点击眼睛查看或输入新 Key" : placeholder}
      onReveal={isServerManaged ? onReveal : undefined}
      onHideRevealedValue={onHideRevealedValue}
      revealing={revealing}
    />
  );
}

type HostingCredentialField = "apiKey" | "apiSecret";

type UserVideoReferenceHostingCredentialState = {
  configured: boolean;
  updatedAt: string | Date | null;
};

function hostingSettingFromApi(value: unknown): VideoReferenceHostingSetting {
  if (!value || typeof value !== "object") return { ...EMPTY_VIDEO_REFERENCE_HOSTING };
  const setting = value as Partial<VideoReferenceHostingSetting>;
  return {
    provider: "cloudinary",
    enabled: setting.enabled !== false,
    cloudName: typeof setting.cloudName === "string" ? setting.cloudName : "",
    apiKey: typeof setting.apiKey === "string" ? setting.apiKey : "",
    apiSecret: typeof setting.apiSecret === "string" ? setting.apiSecret : "",
  };
}

// 自定义开关组件
function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg transition-transform duration-200 ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function SettingsRailLink({
  href,
  icon: Icon,
  title,
  desc,
  expanded,
  active = false,
}: {
  href: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  expanded: boolean;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group relative mb-1 flex min-h-12 w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition ${
        active
          ? "border-cyan-200/30 bg-cyan-200/12 text-cyan-50 shadow-[0_0_24px_rgba(34,211,238,0.12)]"
          : "border-transparent bg-transparent text-slate-300/80 hover:border-cyan-100/16 hover:bg-white/[0.045] hover:text-cyan-50"
      } ${expanded ? "" : "justify-center px-0"}`}
      title={expanded ? undefined : title}
    >
      {active && <span className="absolute left-0 top-2 h-8 w-0.5 rounded-full bg-cyan-200 shadow-[0_0_18px_rgba(103,232,249,0.9)]" />}
      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${
        active
          ? "border-cyan-100/22 bg-cyan-200/12 text-cyan-100"
          : "border-white/8 bg-white/[0.035] text-slate-300/80 group-hover:border-cyan-100/18 group-hover:text-cyan-100"
      }`}>
        <Icon className="h-4 w-4" />
      </span>
      {expanded && (
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{title}</span>
          <span className="mt-0.5 block truncate text-[10px] text-slate-400/78">{desc}</span>
        </span>
      )}
    </Link>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [defaultSettingsTab, setDefaultSettingsTab] = useState(0);
  // 从 store 读取设置
  const {
    providers,
    llm,
    setProvider,
    setLLM,
    replaceSettings,
  } = useSettingsStore();

  // 保存时的提示状态
  const [saved, setSaved] = useState(false);

  // LLM 连接测试状态
  const [llmTestStatus, setLlmTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [llmTestMessage, setLlmTestMessage] = useState("");
  const [visionTestStatus, setVisionTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [visionTestMessage, setVisionTestMessage] = useState("");
  const [visionTestImage, setVisionTestImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [audioTestStatus, setAudioTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [audioTestMessage, setAudioTestMessage] = useState("");
  const [audioTestFile, setAudioTestFile] = useState<File | null>(null);
  const [imageTestResults, setImageTestResults] = useState<Record<string, {
    status: "idle" | "testing" | "success" | "error";
    message: string;
    endpoint?: string;
    durationMs?: number;
    transport?: "b64_json" | "url";
    previewUrl?: string;
  }>>({});
  const [testingImageChannelId, setTestingImageChannelId] = useState("");
  const [, setVideoTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [, setVideoTestMessage] = useState("");
  const [cloneVideoTestStatus, setCloneVideoTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [cloneVideoTestMessage, setCloneVideoTestMessage] = useState("");
  const [testingCloneVideoChannelId, setTestingCloneVideoChannelId] = useState("");
  const [videoChannelTestResults, setVideoChannelTestResults] = useState<Record<string, { status: "testing" | "success" | "error"; message: string }>>({});
  const [videoReferenceHosting, setVideoReferenceHosting] = useState<VideoReferenceHostingSetting>({
    ...EMPTY_VIDEO_REFERENCE_HOSTING,
  });
  const [hostingCredentialDrafts, setHostingCredentialDrafts] = useState<Partial<Record<HostingCredentialField, string>>>({});
  const [revealedHostingCredentialFields, setRevealedHostingCredentialFields] = useState<HostingCredentialField[]>([]);
  const [hostingCredentialBusyField, setHostingCredentialBusyField] = useState<HostingCredentialField | "">("");
  const [hostingCredentialMessage, setHostingCredentialMessage] = useState("");
  const [hostingTestStatus, setHostingTestStatus] = useState<CapabilityTestStatus>("idle");
  const [hostingTestMessage, setHostingTestMessage] = useState("");
  const [showAdvancedProviders, setShowAdvancedProviders] = useState(false);
  const [isRailExpanded, setIsRailExpanded] = useState(true);
  const [currentUser, setCurrentUser] = useState<{ id: string; accountId: string; username: string; role: "admin" | "user" } | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; accountId: string; username: string; role: string; disabled: boolean | null }>>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userCredentials, setUserCredentials] = useState<ModelCredentialRow[]>([]);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [credentialMessage, setCredentialMessage] = useState("");
  const [credentialBusyChannelId, setCredentialBusyChannelId] = useState("");
  const [userHostingCredential, setUserHostingCredential] = useState<UserVideoReferenceHostingCredentialState | null>(null);
  const [userHostingCredentialDrafts, setUserHostingCredentialDrafts] = useState<Partial<Record<HostingCredentialField, string>>>({});
  const [userHostingCredentialChangedFields, setUserHostingCredentialChangedFields] = useState<HostingCredentialField[]>([]);
  const [userHostingCredentialMessage, setUserHostingCredentialMessage] = useState("");
  const [userHostingCredentialBusyField, setUserHostingCredentialBusyField] = useState("");
  const [userFeatureEntries, setUserFeatureEntries] = useState<UserFeatureEntryRow[]>([]);
  const [userFeatureEntryMessage, setUserFeatureEntryMessage] = useState("");
  const [userFeatureEntryBusyKey, setUserFeatureEntryBusyKey] = useState("");
  const [adminCredentials, setAdminCredentials] = useState<ModelCredentialRow[]>([]);
  const [adminCredentialDrafts, setAdminCredentialDrafts] = useState<Record<string, string>>({});
  const [adminCredentialBusyChannelId, setAdminCredentialBusyChannelId] = useState("");
  const [adminCredentialMessage, setAdminCredentialMessage] = useState("");
  const [invites, setInvites] = useState<Array<{
    id: string;
    label: string | null;
    createdAt: string | Date;
    expiresAt: string | Date;
    usedAt: string | Date | null;
    usedByUserId: string | null;
  }>>([]);
  const [lastInviteCode, setLastInviteCode] = useState("");
  const [lastInviteId, setLastInviteId] = useState("");
  const [modelAdminMessage, setModelAdminMessage] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");
  const [isInvitesLoading, setIsInvitesLoading] = useState(false);
  const [deletingInviteId, setDeletingInviteId] = useState("");

  const refreshInvites = useCallback(async () => {
    setIsInvitesLoading(true);
    try {
      const res = await fetch("/api/admin/invites", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteMessage(data.error || "读取邀请码记录失败");
        return;
      }
      setInvites(data.invites ?? []);
    } catch {
      setInviteMessage("读取邀请码记录失败");
    } finally {
      setIsInvitesLoading(false);
    }
  }, []);

  const refreshAdminCredentials = useCallback(async (userId: string) => {
    if (!userId) return false;
    try {
      const res = await fetch(`/api/model-settings/credentials?userId=${encodeURIComponent(userId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdminCredentialMessage(data.error || "读取管理员模型 Key 状态失败");
        return false;
      }
      setAdminCredentials(data.credentials ?? []);
      setAdminCredentialMessage("");
      return true;
    } catch {
      setAdminCredentialMessage("读取管理员模型 Key 状态失败");
      return false;
    }
  }, []);

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    setDefaultSettingsTab(tab === "system" ? 3 : tab === "brand" ? 2 : 0);
  }, []);

  useEffect(() => {
    async function loadAdminState() {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      if (!meRes.ok) {
        router.replace("/login");
        return;
      }
      const meData = await meRes.json();
      if (meData.user?.role !== "admin") {
        router.replace("/workspace");
        return;
      }
      setCurrentUser(meData.user);
      setSelectedUserId("");
      const [usersRes, settingsRes] = await Promise.all([
        fetch("/api/admin/users", { cache: "no-store" }),
        fetch("/api/model-settings", { cache: "no-store" }),
      ]);
      const usersData = await usersRes.json().catch(() => ({}));
      const settingsData = await settingsRes.json().catch(() => ({}));
      setUsers(usersData.users ?? []);
      setUserCredentials([]);
      setUserHostingCredential(null);
      setUserHostingCredentialDrafts({});
      setUserHostingCredentialChangedFields([]);
      setUserHostingCredentialMessage("");
      setUserHostingCredentialBusyField("");
      setUserFeatureEntries([]);
      setUserFeatureEntryMessage("");
      setUserFeatureEntryBusyKey("");
      const credentialsLoaded = await refreshAdminCredentials(meData.user.id);
      if (!settingsRes.ok || !credentialsLoaded) {
        setModelAdminMessage(settingsData.error || "模型池读取失败");
      }
      await refreshInvites();
      replaceSettings(settingsData.settings ?? {
        providers: {},
        llm: { provider: "", baseUrl: "", apiKey: "", model: "", visionModel: "" },
      });
      setVideoReferenceHosting(hostingSettingFromApi(settingsData.settings?.videoReferenceHosting));
      setHostingCredentialDrafts({});
      setRevealedHostingCredentialFields([]);
    }
    void loadAdminState();
  }, [refreshAdminCredentials, refreshInvites, replaceSettings, router]);

  async function loadModelSettingsForUser(userId: string) {
    setSelectedUserId(userId);
    setCredentialDrafts({});
    setUserHostingCredential(null);
    setUserHostingCredentialDrafts({});
    setUserHostingCredentialChangedFields([]);
    setUserHostingCredentialMessage("");
    setUserHostingCredentialBusyField("");
    setUserFeatureEntries([]);
    setUserFeatureEntryMessage("");
    setUserFeatureEntryBusyKey("");
    const [credentialsRes, hostingCredentialsRes, featureEntriesRes] = await Promise.all([
      fetch(`/api/model-settings/credentials?userId=${encodeURIComponent(userId)}`, { cache: "no-store" }),
      fetch(`/api/model-settings/hosting-credentials?userId=${encodeURIComponent(userId)}`, { cache: "no-store" }),
      fetch(`/api/admin/user-feature-entries?userId=${encodeURIComponent(userId)}`, { cache: "no-store" }),
    ]);
    const [credentialsData, hostingCredentialsData, featureEntriesData] = await Promise.all([
      credentialsRes.json().catch(() => ({})),
      hostingCredentialsRes.json().catch(() => ({})),
      featureEntriesRes.json().catch(() => ({})),
    ]);
    if (credentialsRes.ok) {
      setUserCredentials(credentialsData.credentials ?? []);
      setCredentialMessage("");
    } else {
      setCredentialMessage(credentialsData.error || "读取用户通道凭证失败");
      setUserCredentials([]);
    }
    if (hostingCredentialsRes.ok) {
      setUserHostingCredential(hostingCredentialsData.credential ?? null);
      setUserHostingCredentialMessage("");
    } else {
      setUserHostingCredential(null);
      setUserHostingCredentialMessage(hostingCredentialsData.error || "读取用户公网托管凭证失败");
    }
    if (featureEntriesRes.ok) {
      setUserFeatureEntries(featureEntriesData.entries ?? []);
      setUserFeatureEntryMessage("");
    } else {
      setUserFeatureEntries([]);
      setUserFeatureEntryMessage(featureEntriesData.error || "读取用户功能入口状态失败");
    }
    setModelAdminMessage(
      credentialsRes.ok && hostingCredentialsRes.ok && featureEntriesRes.ok
        ? "已载入该用户的私有通道、公网托管凭证与功能入口状态"
        : "未能完整载入该普通用户的配置状态。",
    );
  }

  const updateUserCredential = async (channelId: string) => {
    const targetUserId = selectedUserId;
    const apiKey = credentialDrafts[channelId]?.trim() || "";
    if (!targetUserId || !apiKey) {
      setCredentialMessage("请先填写要保存的 Key；清除请使用删除按钮");
      return;
    }
    setCredentialBusyChannelId(channelId);
    try {
      const res = await fetch("/api/model-settings/credentials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUserId, channelId, apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCredentialMessage(data.error || "保存用户 Key 失败");
        return;
      }
      setUserCredentials(data.credentials ?? []);
      setCredentialDrafts((current) => ({ ...current, [channelId]: "" }));
      setCredentialMessage("用户 Key 已加密保存");
    } catch {
      setCredentialMessage("保存用户 Key 失败");
    } finally {
      setCredentialBusyChannelId("");
    }
  };

  const revealUserCredential = async (channelId: string) => {
    const targetUserId = selectedUserId;
    if (!targetUserId) return;
    setCredentialBusyChannelId(channelId);
    try {
      const res = await fetch(`/api/model-settings/credentials?userId=${encodeURIComponent(targetUserId)}&revealChannelId=${encodeURIComponent(channelId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCredentialMessage(data.error || "读取用户 Key 失败");
        return;
      }
      setCredentialDrafts((current) => ({ ...current, [channelId]: typeof data.apiKey === "string" ? data.apiKey : "" }));
      setCredentialMessage(data.apiKey ? "已按需显示该用户 Key" : "该用户尚未配置此通道 Key");
    } catch {
      setCredentialMessage("读取用户 Key 失败");
    } finally {
      setCredentialBusyChannelId("");
    }
  };

  const clearUserCredential = async (channelId: string) => {
    const targetUserId = selectedUserId;
    if (!targetUserId) return;
    setCredentialBusyChannelId(channelId);
    try {
      const res = await fetch("/api/model-settings/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUserId, channelId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCredentialMessage(data.error || "清除用户 Key 失败");
        return;
      }
      setUserCredentials(data.credentials ?? []);
      setCredentialDrafts((current) => ({ ...current, [channelId]: "" }));
      setCredentialMessage("用户 Key 已清除");
    } catch {
      setCredentialMessage("清除用户 Key 失败");
    } finally {
      setCredentialBusyChannelId("");
    }
  };

  const updateUserFeatureEntry = async (featureKey: WorkspaceModuleId, entryState: WorkspaceFeatureEntryState) => {
    const targetUserId = selectedUserId;
    if (!targetUserId) return;
    setUserFeatureEntryBusyKey(featureKey);
    try {
      const res = await fetch("/api/admin/user-feature-entries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUserId, featureKey, entryState }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUserFeatureEntryMessage(data.error || "保存用户功能入口状态失败");
        return;
      }
      setUserFeatureEntries(data.entries ?? []);
      setUserFeatureEntryMessage(entryState === "open" ? "该功能已允许进入" : "该功能已设为等待开放");
    } catch {
      setUserFeatureEntryMessage("保存用户功能入口状态失败");
    } finally {
      setUserFeatureEntryBusyKey("");
    }
  };

  const changeUserHostingCredentialDraft = (field: HostingCredentialField, value: string) => {
    setUserHostingCredentialDrafts((current) => ({ ...current, [field]: value }));
    setUserHostingCredentialChangedFields((current) => current.includes(field) ? current : [...current, field]);
  };

  const revealUserHostingCredential = async (field: HostingCredentialField) => {
    const targetUserId = selectedUserId;
    if (!targetUserId) return;
    setUserHostingCredentialBusyField(field);
    try {
      const res = await fetch(
        `/api/model-settings/hosting-credentials?userId=${encodeURIComponent(targetUserId)}&revealField=${field}`,
        { cache: "no-store" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUserHostingCredentialMessage(data.error || "读取用户公网托管凭证失败");
        return;
      }
      setUserHostingCredentialDrafts((current) => ({ ...current, [field]: typeof data.value === "string" ? data.value : "" }));
      setUserHostingCredentialMessage(data.value ? `已按需显示该用户的 Cloudinary ${field === "apiKey" ? "API Key" : "API Secret"}` : "该用户尚未配置公网托管凭证");
    } catch {
      setUserHostingCredentialMessage("读取用户公网托管凭证失败");
    } finally {
      setUserHostingCredentialBusyField("");
    }
  };

  const saveUserHostingCredentials = async () => {
    const targetUserId = selectedUserId;
    const apiKey = userHostingCredentialChangedFields.includes("apiKey")
      ? userHostingCredentialDrafts.apiKey?.trim() || ""
      : "";
    const apiSecret = userHostingCredentialChangedFields.includes("apiSecret")
      ? userHostingCredentialDrafts.apiSecret?.trim() || ""
      : "";
    if (!targetUserId || (!apiKey && !apiSecret)) {
      setUserHostingCredentialMessage("请手工填写需要保存的公网托管凭证；查看的旧值不会被再次提交");
      return;
    }
    if (!userHostingCredential?.configured && (!apiKey || !apiSecret)) {
      setUserHostingCredentialMessage("首次配置必须同时填写 API Key 和 API Secret");
      return;
    }
    setUserHostingCredentialBusyField("save");
    try {
      const res = await fetch("/api/model-settings/hosting-credentials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: targetUserId,
          ...(apiKey ? { apiKey } : {}),
          ...(apiSecret ? { apiSecret } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUserHostingCredentialMessage(data.error || "保存用户公网托管凭证失败");
        return;
      }
      setUserHostingCredential(data.credential ?? null);
      setUserHostingCredentialDrafts({});
      setUserHostingCredentialChangedFields([]);
      setUserHostingCredentialMessage("该用户的 Cloudinary API Key 和 API Secret 已加密保存");
    } catch {
      setUserHostingCredentialMessage("保存用户公网托管凭证失败");
    } finally {
      setUserHostingCredentialBusyField("");
    }
  };

  const clearUserHostingCredentials = async () => {
    const targetUserId = selectedUserId;
    if (!targetUserId) return;
    setUserHostingCredentialBusyField("clear");
    try {
      const res = await fetch("/api/model-settings/hosting-credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUserHostingCredentialMessage(data.error || "清除用户公网托管凭证失败");
        return;
      }
      setUserHostingCredential({ configured: false, updatedAt: null });
      setUserHostingCredentialDrafts({});
      setUserHostingCredentialChangedFields([]);
      setUserHostingCredentialMessage("该用户的 Cloudinary API Key 和 API Secret 已清除");
    } catch {
      setUserHostingCredentialMessage("清除用户公网托管凭证失败");
    } finally {
      setUserHostingCredentialBusyField("");
    }
  };

  const revealAdminCredential = async (channelId: string) => {
    const userId = currentUser?.id;
    if (!userId) return;
    setAdminCredentialBusyChannelId(channelId);
    try {
      const res = await fetch(`/api/model-settings/credentials?userId=${encodeURIComponent(userId)}&revealChannelId=${encodeURIComponent(channelId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdminCredentialMessage(data.error || "读取管理员模型 Key 失败");
        return;
      }
      setAdminCredentialDrafts((current) => ({ ...current, [channelId]: typeof data.apiKey === "string" ? data.apiKey : "" }));
      setAdminCredentialMessage(data.apiKey ? "已按需显示管理员 Key" : "该通道尚未配置 Key");
    } catch {
      setAdminCredentialMessage("读取管理员模型 Key 失败");
    } finally {
      setAdminCredentialBusyChannelId("");
    }
  };

  async function createInvite() {
    setInviteMessage("");
    setLastInviteCode("");
    setLastInviteId("");
    setIsInvitesLoading(true);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteMessage(data.error || "生成邀请码失败");
        return;
      }
      setLastInviteCode(data.code);
      setLastInviteId(data.invite?.id ?? "");
      setInviteMessage("一次性邀请码已生成，请立即复制。明文不会再次显示。");
      await refreshInvites();
    } catch {
      setInviteMessage("生成邀请码失败");
    } finally {
      setIsInvitesLoading(false);
    }
  }

  async function deleteInvite(inviteId: string) {
    setInviteMessage("");
    setDeletingInviteId(inviteId);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: inviteId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteMessage(data.error || "删除邀请码失败");
        return;
      }
      if (inviteId === lastInviteId) {
        setLastInviteCode("");
        setLastInviteId("");
      }
      setInviteMessage("邀请码记录已删除，邀请码立即失效。");
      await refreshInvites();
    } catch {
      setInviteMessage("删除邀请码失败");
    } finally {
      setDeletingInviteId("");
    }
  }

  async function toggleUserDisabled(userId: string, disabled: boolean) {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setModelAdminMessage(data.error || "更新用户失败");
      return;
    }
    const usersRes = await fetch("/api/admin/users", { cache: "no-store" });
    const usersData = await usersRes.json().catch(() => ({}));
    setUsers(usersData.users ?? []);
  }

  // 测试 LLM 连接
  const testLLMConnection = async () => {
    setLlmTestStatus("testing");
    setLlmTestMessage("");
    try {
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      setLlmTestStatus(res.ok && data.ok ? "success" : "error");
      setLlmTestMessage(data.message || data.warning || data.error || data.chatError || "");
    } catch (error) {
      setLlmTestStatus("error");
      setLlmTestMessage(error instanceof Error ? error.message : "连接失败");
    }
  };

  const handleVisionTestImage = (file: File | undefined) => {
    setVisionTestMessage("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setVisionTestStatus("error");
      setVisionTestMessage("请上传图片文件");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setVisionTestStatus("error");
      setVisionTestMessage("测试图片不能超过 8MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setVisionTestImage({
        name: file.name,
        dataUrl: String(reader.result || ""),
      });
      setVisionTestStatus("idle");
    };
    reader.onerror = () => {
      setVisionTestStatus("error");
      setVisionTestMessage("图片读取失败，请换一张图片重试");
    };
    reader.readAsDataURL(file);
  };

  // 测试视觉分析能力
  const handleAudioTestFile = (file: File | undefined) => {
    setAudioTestMessage("");
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setAudioTestStatus("error");
      setAudioTestMessage("请上传 MP3 或 WAV 音频文件");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setAudioTestStatus("error");
      setAudioTestMessage("测试文件不能超过 50MB");
      return;
    }
    setAudioTestFile(file);
    setAudioTestStatus("idle");
  };

  const testAudioTranscription = async () => {
    setAudioTestStatus("testing");
    setAudioTestMessage("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 300_000);
    try {
      if (!audioTestFile) {
        throw new Error("请先上传一段 MP3 或 WAV 音频测试文件");
      }

      const form = new FormData();
      form.set("file", audioTestFile);

      const res = await fetch("/api/llm/audio-test", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok;
      window.clearTimeout(timer);
      setAudioTestStatus(ok ? "success" : "error");
      const detail = !ok
        ? [
            data.responsesAudioError ? `responses: ${data.responsesAudioError}` : "",
            data.chatAudioError ? `chat/completions: ${data.chatAudioError}` : "",
          ].filter(Boolean).join("\n\n")
        : "";
      const transcription = ok && typeof data.transcription === "string"
        ? `模型原始转写：\n${data.transcription}`
        : "";
      setAudioTestMessage([
        ok ? `${llm.model || "当前模型"} 已返回音频转写结果，请人工核对下方模型原始转写。` : data.message || data.error || data.detail || "",
        transcription,
        detail,
      ].filter(Boolean).join("\n\n"));
    } catch (error) {
      window.clearTimeout(timer);
      setAudioTestStatus("error");
      setAudioTestMessage(error instanceof Error ? error.message : "语音识别测试失败");
    }
  };

  const testVisionConnection = async () => {
    setVisionTestStatus("testing");
    setVisionTestMessage("");
    try {
      const model = llm.visionModel?.trim() || llm.model;
      const res = await fetch("/api/llm/vision-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl: visionTestImage?.dataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok;
      setVisionTestStatus(ok ? "success" : "error");
      if (ok && !llm.visionModel?.trim()) {
        setLLM({ ...llm, visionModel: model });
      }
      const detail = !ok && (data.responsesError || data.chatError)
        ? ` responses: ${data.responsesError || "-"} | chat: ${data.chatError || "-"}`
        : "";
      const autoFill = ok && !llm.visionModel?.trim() ? "; auto-filled vision model" : "";
      const answer = ok && typeof data.answer === "string"
        ? `模型原始回答：${data.answer}`
        : "";
      setVisionTestMessage([
        ok ? `${model} 已返回视觉识别结果，请人工核对下方模型原始回答。` : data.message || data.error || "",
        answer,
        detail,
        autoFill,
      ].filter(Boolean).join("\n\n"));
    } catch (error) {
      setVisionTestStatus("error");
      setVisionTestMessage(error instanceof Error ? error.message : "视觉分析测试失败");
    }
  };

  const testImageChannelConnection = async (channel: ImageModelChannel) => {
    const imageModel = channel.model || "生图模型";

    setTestingImageChannelId(channel.id);
    setImageTestResults((current) => ({
      ...current,
      [channel.id]: { status: "testing", message: `正在真实生图测试：${channel.name || imageModel}` },
    }));
    try {
      const res = await fetch("/api/ai/image/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.id }),
      });
      const data = await res.json().catch(() => ({}));
      setImageTestResults((current) => ({
        ...current,
        [channel.id]: {
          status: res.ok && data.ok ? "success" : "error",
          message: `${channel.name || "Image model"}: ${data.message || data.error || data.detail || ""}`,
          endpoint: typeof data.endpoint === "string" ? data.endpoint : undefined,
          durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
          transport: data.transport === "b64_json" || data.transport === "url" ? data.transport : undefined,
          previewUrl: typeof data.previewUrl === "string" ? data.previewUrl : undefined,
        },
      }));
    } catch (error) {
      setImageTestResults((current) => ({
        ...current,
        [channel.id]: {
          status: "error",
          message: error instanceof Error ? error.message : "Connection failed",
        },
      }));
    } finally {
      setTestingImageChannelId("");
    }
  };

  // 计算 AI 平台配置状态
  const hasAdminChannelCredential = (channelId: string) => adminCredentials.some((credential) => (
    credential.channelId === channelId && credential.configured && credential.enabled
  ));
  const selectedLlmConfigured = adminCredentials.some((credential) => (
    credential.kind === "llm" && credential.configured && credential.enabled
  ));
  const hasAnyProvider = adminCredentials.some((credential) => (
    (credential.kind === "image" || credential.kind === "video") && credential.configured && credential.enabled
  ));
  const testVideoChannelConnection = async (
    channel: VideoModelChannel,
    onResult?: (status: "testing" | "success" | "error", message: string) => void,
  ) => {
    // Model-pool channels are isolated. A test must never silently fall back
    // to the legacy shared provider values, otherwise it can test a different
    // upstream than the channel being edited.
    const videoModel = channel.model;
    const report = (status: "testing" | "success" | "error", message: string) => {
      if (onResult) {
        onResult(status, message);
        return;
      }
      setVideoTestStatus(status);
      setVideoTestMessage(message);
    };

    report("testing", `正在测试：${channel.name || videoModel}`);
    try {
      const res = await fetch("/api/ai/video/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.id }),
      });
      const data = await res.json().catch(() => ({}));
      report(res.ok && data.ok ? "success" : "error", `${channel.name || "视频模型"}：${data.message || data.error || data.detail || ""}`);
    } catch (error) {
      report("error", error instanceof Error ? error.message : "视频 API 连接测试失败");
    }
  };

  const addImageChannel = () => {
    const provider = providers["openai-seedance"];
    if (!provider) return;
    const channels = provider.imageChannels ?? [];
    setProvider("openai-seedance", {
      ...provider,
      imageChannels: [
        ...channels,
        {
          id: `image-${Date.now()}`,
          name: `生图模型 ${channels.length + 1}`,
          enabled: true,
          apiKey: "",
          // A newly added channel must be configured explicitly. Do not copy a
          // legacy shared provider address into a possibly different upstream.
          baseUrl: "",
          model: "",
          endpointPath: "/images/edits",
          requestTimeoutMs: 30 * 60 * 1000,
        },
      ],
    });
  };

  const updateImageChannel = (channelId: string, patch: Partial<ImageModelChannel>) => {
    const provider = providers["openai-seedance"];
    if (!provider) return;
    const channels = provider.imageChannels ?? [];
    setProvider("openai-seedance", {
      ...provider,
      imageChannels: channels.map((channel) =>
        channel.id === channelId ? { ...channel, ...patch } : channel
      ),
    });
  };

  const deleteImageChannel = (channelId: string) => {
    const provider = providers["openai-seedance"];
    if (!provider) return;
    const channels = provider.imageChannels ?? [];
    setProvider("openai-seedance", {
      ...provider,
      imageChannels: channels.filter((channel) => channel.id !== channelId),
    });
  };

  const updateVideoChannel = (channelId: string, patch: Partial<VideoModelChannel>) => {
    const provider = providers["openai-seedance"];
    if (!provider) return;
    const channels = provider.videoChannels ?? [];
    const nextChannels = channels.map((channel) =>
      channel.id === channelId ? { ...channel, ...patch } : channel
    );
    setProvider("openai-seedance", {
      ...provider,
      videoChannels: nextChannels,
    });
  };

  const addVideoChannel = () => {
    const provider = providers["openai-seedance"];
    if (!provider) return;
    const channels = provider.videoChannels ?? [];
    setProvider("openai-seedance", {
      ...provider,
      videoChannels: [
        ...channels,
        {
          id: `video-${Date.now()}`,
          name: `视频模型 ${channels.length + 1}`,
          enabled: true,
          apiKey: "",
          // A newly added channel must be configured explicitly. Do not copy a
          // legacy shared provider address into a possibly different upstream.
          baseUrl: "",
          model: "",
          taskTypes: ["shot_clip", "full_video"],
          submitPath: provider.videoSubmitPath || "/videos",
          statusPath: provider.videoStatusPath || "/videos/{id}",
          contentPath: provider.videoContentPath || "/videos/{id}/content",
          durationOptions: [],
          maxReferenceImages: 0,
          maxReferenceVideos: 0,
          maxReferenceAudios: 0,
          directVideoReplacementPromptLanguage: "en",
        },
      ],
    });
  };

  const deleteVideoChannel = (channelId: string) => {
    const provider = providers["openai-seedance"];
    if (!provider) return;
    const channels = provider.videoChannels ?? [];
    const nextChannels = channels.filter((channel) => channel.id !== channelId);
    setProvider("openai-seedance", {
      ...provider,
      videoChannels: nextChannels,
    });
  };

  const updateCloneVideoChannel = updateVideoChannel;
  const testCloneVideoChannelConnection = (channel: VideoModelChannel) => {
    setTestingCloneVideoChannelId(channel.id);
    setVideoChannelTestResults((current) => ({
      ...current,
      [channel.id]: { status: "testing", message: `正在测试 ${channel.name || channel.model}…` },
    }));
    void testVideoChannelConnection(channel, (status, message) => {
      setCloneVideoTestStatus(status);
      setCloneVideoTestMessage(message);
      if (status !== "testing") {
        setVideoChannelTestResults((current) => ({
          ...current,
          [channel.id]: { status, message },
        }));
      }
    }).finally(() => {
      setTestingCloneVideoChannelId("");
    });
  };

  const enabledCount = adminCredentials.filter((credential) => (
    (credential.kind === "image" || credential.kind === "video") && credential.configured && credential.enabled
  )).length;

  const updateHostingCredentialDraft = (field: HostingCredentialField, value: string) => {
    setHostingCredentialDrafts((current) => ({ ...current, [field]: value }));
    setRevealedHostingCredentialFields((current) => current.filter((item) => item !== field));
    setHostingCredentialMessage("");
  };

  const clearHostingCredentialDraft = (field: HostingCredentialField) => {
    setHostingCredentialDrafts((current) => {
      const remaining = { ...current };
      delete remaining[field];
      return remaining;
    });
    setRevealedHostingCredentialFields((current) => current.filter((item) => item !== field));
  };

  const revealHostingCredential = async (field: HostingCredentialField) => {
    setHostingCredentialBusyField(field);
    setHostingCredentialMessage("");
    try {
      const res = await fetch(`/api/model-settings?revealHostingCredential=${encodeURIComponent(field)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHostingCredentialMessage(data.error || "读取公网托管凭证失败");
        return;
      }
      const value = typeof data.value === "string" ? data.value : "";
      if (!value) {
        clearHostingCredentialDraft(field);
        setHostingCredentialMessage("该项尚未配置");
        return;
      }
      setHostingCredentialDrafts((current) => ({ ...current, [field]: value }));
      setRevealedHostingCredentialFields((current) => current.includes(field) ? current : [...current, field]);
      setHostingCredentialMessage(`已按需显示 ${field === "apiKey" ? "API Key" : "API Secret"}`);
    } catch {
      setHostingCredentialMessage("读取公网托管凭证失败");
    } finally {
      setHostingCredentialBusyField("");
    }
  };

  const pendingVideoReferenceHosting: VideoReferenceHostingSetting = {
    ...videoReferenceHosting,
    apiKey: revealedHostingCredentialFields.includes("apiKey")
      ? SERVER_MANAGED_API_KEY
      : hostingCredentialDrafts.apiKey ?? videoReferenceHosting.apiKey,
    apiSecret: revealedHostingCredentialFields.includes("apiSecret")
      ? SERVER_MANAGED_API_KEY
      : hostingCredentialDrafts.apiSecret ?? videoReferenceHosting.apiSecret,
  };

  const testVideoReferenceHosting = async () => {
    const targetUserId = currentUser?.id;
    if (!targetUserId) {
      setHostingTestStatus("error");
      setHostingTestMessage("请先选择要测试的用户。");
      return;
    }
    setHostingTestStatus("testing");
    setHostingTestMessage("");
    try {
      const res = await fetch("/api/video-reference-hosting/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: targetUserId,
          setting: pendingVideoReferenceHosting,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok;
      setHostingTestStatus(ok ? "success" : "error");
      setHostingTestMessage(
        [
          data.message || data.error || "Cloudinary 托管测试失败。",
          typeof data.durationMs === "number" ? `耗时 ${(data.durationMs / 1000).toFixed(1)} 秒` : "",
        ].filter(Boolean).join(" · "),
      );
    } catch (error) {
      setHostingTestStatus("error");
      setHostingTestMessage(error instanceof Error ? error.message : "Cloudinary 托管测试失败。");
    }
  };

  // 处理保存（zustand persist 会自动保存，这里主要做 UI 反馈）
  const handleSave = async () => {
    const primaryProvider = providers["openai-seedance"];
    const settings = {
      providers: {
        ...providers,
        ...(primaryProvider ? {
          "openai-seedance": {
            ...primaryProvider,
            apiKey: "",
            imageApiKey: "",
            videoApiKey: "",
            imageChannels: (primaryProvider.imageChannels ?? []).map((channel) => ({
              ...channel,
              apiKey: adminCredentialDrafts[channel.id]?.trim() || "",
            })),
            videoChannels: (primaryProvider.videoChannels ?? []).map((channel) => ({
              ...channel,
              apiKey: adminCredentialDrafts[channel.id]?.trim() || "",
            })),
          },
        } : {}),
      },
      llm: {
        ...llm,
        apiKey: adminCredentialDrafts["llm-default"]?.trim() || "",
      },
      videoReferenceHosting: pendingVideoReferenceHosting,
    };
    const res = await fetch("/api/model-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setModelAdminMessage(data.error || "保存模型配置失败");
      return;
    }
    setSaved(true);
    setVideoReferenceHosting((current) => ({
      ...current,
      apiKey: pendingVideoReferenceHosting.apiKey ? SERVER_MANAGED_API_KEY : "",
      apiSecret: pendingVideoReferenceHosting.apiSecret ? SERVER_MANAGED_API_KEY : "",
    }));
    setHostingCredentialDrafts({});
    setRevealedHostingCredentialFields([]);
    await refreshAdminCredentials(currentUser?.id ?? "");
    setAdminCredentialDrafts({});
    setModelAdminMessage("模型池配置已保存");
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="luma-settings-page luma-workspace-shell relative flex h-screen overflow-hidden bg-transparent text-slate-100">
      {/* 顶部导航 */}
      <aside
        className={`luma-workspace-rail relative z-20 hidden shrink-0 border-r border-cyan-100/16 bg-[#061019]/20 shadow-[inset_-1px_0_0_rgba(103,232,249,0.08)] backdrop-blur-[15px] transition-[width] duration-300 lg:block ${
          isRailExpanded ? "w-[276px]" : "w-[68px]"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className={`flex h-16 items-center gap-2.5 border-b border-cyan-100/10 px-3 ${isRailExpanded ? "justify-between" : "justify-center"}`}>
            <Link
              href="/"
              className={`min-w-0 overflow-hidden leading-none transition-[max-width,opacity,transform] duration-200 ${
                isRailExpanded ? "max-w-[196px] translate-x-0 opacity-100" : "pointer-events-none max-w-0 -translate-x-2 opacity-0"
              }`}
              aria-hidden={!isRailExpanded}
              tabIndex={isRailExpanded ? 0 : -1}
            >
              <span className="luma-brand-en block truncate whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.12em]">Luma Commerce Studio</span>
              <span className="luma-brand-cn mt-1 block truncate text-xl font-black tracking-tight">流光商影</span>
            </Link>
            <button
              type="button"
              onClick={() => setIsRailExpanded((value) => !value)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.045] text-cyan-100 transition hover:border-cyan-200/35 hover:bg-cyan-200/10"
              title={isRailExpanded ? "收起导航" : "展开导航"}
            >
              {isRailExpanded ? <LuChevronLeft className="h-4 w-4" /> : <LuChevronRight className="h-4 w-4" />}
            </button>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
            {settingsWorkspaceModules.map((module) => (
              <SettingsRailLink key={module.href} {...module} expanded={isRailExpanded} />
            ))}
          </nav>

          <div className="px-2.5 pb-3">
            <SettingsRailLink href="/settings" icon={LuSettings} title="模型与API" desc="通道与配置" expanded={isRailExpanded} active />
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-hidden">
      <header className="luma-settings-topbar luma-workspace-header sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-cyan-100/14 bg-[#061019]/16 px-4 backdrop-blur-[15px] lg:px-6">
        <div className="hidden min-w-0 flex-1 items-center lg:flex">
          <div className="relative w-full max-w-2xl">
            <LuSearch className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-100/55" />
            <input
              className="h-10 w-full rounded-full border border-white/10 bg-white/[0.055] px-11 pr-20 text-sm text-slate-100 outline-none backdrop-blur-2xl transition placeholder:text-slate-400/65 focus:border-cyan-200/38 focus:bg-cyan-200/8"
              placeholder="搜索模型、API、通道配置..."
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 rounded-md border border-white/10 bg-black/18 px-2 py-0.5 text-[11px] text-slate-400">
              CMD K
            </span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-emerald-200/14 bg-emerald-300/8 px-3 py-2 text-xs font-semibold text-emerald-100/88 backdrop-blur-2xl md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(110,231,183,0.9)]" />
            引擎在线
          </span>
          <Link
            href="/workspace"
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10"
            title="返回流光创作引擎"
          >
            <LuLayoutDashboard className="h-4 w-4" />
            <span>返回流光创作引擎</span>
          </Link>
          <Link
            href="/"
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10"
            title="返回首页"
          >
            <LuHouse className="h-4 w-4" />
            <span>返回首页</span>
          </Link>
        </div>
      </header>

      <main className="relative z-10 h-[calc(100vh-4rem)] overflow-y-auto overflow-x-hidden px-4 py-8 sm:px-6 sm:py-10">
        <div className="mx-auto w-full max-w-5xl">
        {/* 页面标题 */}
        <div className="luma-settings-title mb-8">
          <h1 className="text-2xl font-bold tracking-tight">模型与API</h1>
          <p className="text-sm text-muted-foreground mt-1">
            配置 AI 服务后即可开始生成带货视频。需要配置 LLM（生成脚本）+ 至少一个 AI 平台（生成图片/视频）。
          </p>
        </div>

        {/* 标签页 */}
        <Tabs key={defaultSettingsTab} defaultValue={defaultSettingsTab}>
          <TabsList className="mb-6">
            <TabsTrigger value={0}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <rect x="9" y="9" width="6" height="6" />
                <path d="M15 2v2" />
                <path d="M15 20v2" />
                <path d="M2 15h2" />
                <path d="M2 9h2" />
                <path d="M20 15h2" />
                <path d="M20 9h2" />
                <path d="M9 2v2" />
                <path d="M9 20v2" />
              </svg>
              AI 平台
            </TabsTrigger>
            <TabsTrigger value={1}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              LLM 配置
            </TabsTrigger>
            <TabsTrigger value={2}>
              <LuPalette className="w-3.5 h-3.5" />
              品牌设置
            </TabsTrigger>
            <TabsTrigger value={3}>
              <LuSettings className="w-3.5 h-3.5" />
              系统管理
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: AI 平台配置 */}
          <TabsContent value={0}>
            <div className="space-y-4">
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-relaxed text-muted-foreground">
                默认只展示你的自有通道。其他平台作为高级备用配置折叠起来，避免设置页变乱。
              </div>
              {adminCredentialMessage && <div className="rounded-lg border border-white/10 bg-white/[0.045] p-3 text-sm text-slate-200">{adminCredentialMessage}</div>}
              {PRIMARY_AI_PROVIDERS.map((platform) => {
                const provider = providers[platform.key] ?? {
                  enabled: false,
                  apiKey: "",
                };

                return (
                  <Card key={platform.key} className="glass-card">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between gap-4">
                        {/* 平台信息 */}
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${platform.iconBg} text-white shadow-lg`}
                          >
                            {platform.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold text-sm">
                                {platform.name}
                              </h3>
                              {provider.enabled && (
                                <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                                  已启用
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {platform.description}
                            </p>
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{platform.tip}</p>
                          </div>
                        </div>

                        {/* 启用开关 */}
                        <Toggle
                          checked={provider.enabled}
                          onChange={(enabled) =>
                            setProvider(platform.key, {
                              ...provider,
                              enabled,
                            })
                          }
                        />
                      </div>

                      {platform.key === "openai-seedance" ? (
                        <div className="mt-4 space-y-4">
                          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                            <p className="text-xs font-semibold">自有模型通道</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                              设置页只登记可用模型，不在这里指定固定默认模型。开启的模型会出现在普通项目和爆款复刻的选择列表里；暂停的模型不会被误选。
                            </p>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <div className="rounded-md border border-border/50 bg-background/70 p-2">
                                <p className="text-[11px] font-medium">生图模型池</p>
                                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                                  普通关键帧、爆款人物/产品/场景资产都从这里选。
                                </p>
                              </div>
                              <div className="rounded-md border border-border/50 bg-background/70 p-2">
                                <p className="text-[11px] font-medium">视频模型池</p>
                                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                                  普通分镜和爆款完整视频共用同一个池，通过任务类型区分调用。
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-medium">生图模型池</p>
                                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                  可以配置多个 OpenAI 兼容生图模型。项目里会选择具体通道；这里的开启/暂停只控制可选范围。
                                </p>
                              </div>
                              <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addImageChannel}>
                                新增生图模型
                              </Button>
                            </div>
                            <div className="space-y-4">
                              {(provider.imageChannels?.length ? provider.imageChannels : []).map((channel, index) => {
                                const channelEnabled = channel.enabled !== false;
                                const imageTestResult = imageTestResults[channel.id];
                                const isImageTesting = imageTestResult?.status === "testing";
                                return (
                                  <div
                                    key={channel.id}
                                    className={`rounded-lg border p-3 ${
                                      channelEnabled
                                        ? "border-border/50 bg-background/50"
                                        : "border-border/40 bg-muted/20 opacity-70"
                                    }`}
                                  >
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                      <div>
                                        <p className="text-xs font-medium">{channel.name || `生图模型 ${index + 1}`}</p>
                                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                                          状态：{channelEnabled ? "开启" : "已暂停"} · 模型：{channel.model || "未填写"}
                                        </p>
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        <div className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1">
                                          <span className="text-[11px] text-muted-foreground">{channelEnabled ? "开启" : "暂停"}</span>
                                          <Toggle checked={channelEnabled} onChange={(enabled) => updateImageChannel(channel.id, { enabled })} />
                                        </div>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-8 border-cyan-200/30 bg-cyan-300/10 text-xs text-cyan-50 hover:bg-cyan-300/20"
                                          onClick={() => testImageChannelConnection(channel)}
                                          disabled={Boolean(testingImageChannelId) || !channelEnabled || !hasAdminChannelCredential(channel.id) || !channel.baseUrl || !channel.model}
                                        >
                                          {isImageTesting ? "真实测试中..." : "真实生图测试"}
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-8 text-xs text-destructive hover:text-destructive"
                                          onClick={() => deleteImageChannel(channel.id)}
                                        >
                                          删除
                                        </Button>
                                      </div>
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">模型通道名称</Label>
                                        <Input
                                          value={channel.name}
                                          onChange={(e) => updateImageChannel(channel.id, { name: e.target.value })}
                                          placeholder={`生图模型 ${index + 1}`}
                                          className="text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">模型名称</Label>
                                        <Input
                                          value={channel.model}
                                          onChange={(e) => updateImageChannel(channel.id, { model: e.target.value })}
                                          placeholder={index === 0 ? "gpt-image-2" : "填写生图模型名"}
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">API Key</Label>
                                        <PasswordInput
                                          value={adminCredentialDrafts[channel.id] ?? ""}
                                          onChange={(apiKey) => setAdminCredentialDrafts((current) => ({ ...current, [channel.id]: apiKey }))}
                                          placeholder={hasAdminChannelCredential(channel.id) ? "已加密保存，点击眼睛查看或输入新 Key" : "填写此通道的 API Key"}
                                          onReveal={() => void revealAdminCredential(channel.id)}
                                          onHideRevealedValue={() => setAdminCredentialDrafts((current) => ({ ...current, [channel.id]: "" }))}
                                          revealing={adminCredentialBusyChannelId === channel.id}
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">API 地址（baseUrl）</Label>
                                        <Input
                                          value={channel.baseUrl}
                                          onChange={(e) => updateImageChannel(channel.id, { baseUrl: e.target.value })}
                                          placeholder="https://api.openai.com/v1"
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">生图端点类型</Label>
                                        <Input
                                          value={channel.endpointPath ?? "/images/edits"}
                                          onChange={(e) => updateImageChannel(channel.id, { endpointPath: e.target.value })}
                                          placeholder="/images/edits"
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                    </div>
                                    {imageTestResult?.message && (
                                      <div className={`mt-3 flex items-start gap-3 rounded-md border px-3 py-2.5 text-[11px] ${
                                        imageTestResult.status === "success"
                                          ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
                                          : imageTestResult.status === "testing"
                                            ? "border-cyan-300/25 bg-cyan-300/10 text-cyan-50"
                                            : "border-rose-300/25 bg-rose-300/10 text-rose-100"
                                      }`}>
                                        <div className="min-w-0 flex-1">
                                          <p className="leading-relaxed">{imageTestResult.message}</p>
                                          {imageTestResult.status === "success" && (
                                            <p className="mt-1.5 text-[10px] text-emerald-100/75">
                                              {imageTestResult.endpoint || "/images/edits"}
                                              {typeof imageTestResult.durationMs === "number" ? ` · ${(imageTestResult.durationMs / 1000).toFixed(1)} 秒` : ""}
                                              {imageTestResult.transport ? ` · ${imageTestResult.transport === "b64_json" ? "Base64 回传" : "URL 回传"}` : ""}
                                              {" · 已本地保存"}
                                            </p>
                                          )}
                                        </div>
                                        {imageTestResult.status === "success" && imageTestResult.previewUrl && (
                                          <img
                                            src={imageTestResult.previewUrl}
                                            alt="模型通道测试结果"
                                            className="h-14 w-14 shrink-0 rounded border border-emerald-100/25 object-cover"
                                          />
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
                            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-medium">视频模型池</p>
                                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                  普通项目分镜视频和爆款复刻完整视频共用这里的模型。项目调用时会带上任务类型：单镜头分镜或完整视频。
                                </p>
                              </div>
                              <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addVideoChannel}>
                                新增视频模型
                              </Button>
                            </div>
                            <div className="space-y-4">
                              {(provider.videoChannels ?? []).map((channel, index) => {
                                const isTesting = cloneVideoTestStatus === "testing" && testingCloneVideoChannelId === channel.id;
                                const channelEnabled = channel.enabled !== false;
                                const channelTest = videoChannelTestResults[channel.id];
                                return (
                                  <div
                                    key={channel.id}
                                    className={`rounded-lg border p-3 ${
                                      channelEnabled
                                          ? "border-border/50 bg-background/50"
                                          : "border-border/40 bg-muted/20 opacity-70"
                                    }`}
                                  >
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                      <div>
                                        <p className="text-xs font-medium">
                                          {channel.name || `视频模型 ${index + 1}`}
                                        </p>
                                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                                          状态：{channelEnabled ? "开启" : "已暂停"} · 模型：{channel.model || "未填写"}
                                        </p>
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        <div className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1">
                                          <span className="text-[11px] text-muted-foreground">{channelEnabled ? "开启" : "暂停"}</span>
                                          <Toggle
                                            checked={channelEnabled}
                                            onChange={(enabled) => updateCloneVideoChannel(channel.id, { enabled })}
                                          />
                                        </div>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-8 text-xs"
                                          onClick={() => testCloneVideoChannelConnection(channel)}
                                          disabled={cloneVideoTestStatus === "testing" || !channelEnabled || !hasAdminChannelCredential(channel.id) || !channel.baseUrl || !channel.model}
                                        >
                                          {isTesting ? "测试中..." : "测试此通道"}
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-8 text-xs text-destructive hover:text-destructive"
                                          onClick={() => deleteVideoChannel(channel.id)}
                                        >
                                          删除
                                        </Button>
                                      </div>
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">模型通道名称</Label>
                                        <Input
                                          value={channel.name}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, { name: e.target.value })}
                                          placeholder={`视频模型 ${index + 1}`}
                                          className="text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">模型名称</Label>
                                        <Input
                                          value={channel.model}
                                          onChange={(e) => {
                                            const model = e.target.value;
                                            updateCloneVideoChannel(channel.id, {
                                              model,
                                              durationOptions: defaultBoardVideoDurationOptions(model),
                                              maxReferenceImages: defaultBoardVideoMaxReferenceImages(model),
                                              maxReferenceVideos: defaultBoardVideoMaxReferenceVideos(model),
                                              maxReferenceAudios: defaultBoardVideoMaxReferenceAudios(model),
                                            });
                                          }}
                                          placeholder={index === 0 ? "seedance-v2-720p-video" : "填写要测试的视频模型名"}
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">单任务可用时长（秒）</Label>
                                        <Input
                                          value={formatBoardVideoDurationOptions(channel.durationOptions)}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, {
                                            durationOptions: parseBoardVideoDurationOptions(e.target.value),
                                          })}
                                          placeholder="例如 4-15 或 6,10"
                                          className="font-mono text-xs"
                                        />
                                        <p className="mt-1 text-[10px] text-muted-foreground">画板自动使用最大值；未知模型留空时不能用于画板视频。</p>
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">最多参考图（张）</Label>
                                        <Input
                                          type="number"
                                          min={1}
                                          max={16}
                                          value={channel.maxReferenceImages || ""}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, {
                                            maxReferenceImages: Math.max(0, Math.min(16, Math.round(Number(e.target.value || 0)))),
                                          })}
                                          placeholder="例如 1、5 或 9"
                                          className="font-mono text-xs"
                                        />
                                        <p className="mt-1 text-[10px] text-muted-foreground">上游允许的最大张数；画板会按当前工作流职责发送，不会为凑满上限混入图片。</p>
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">最多参考视频（个）</Label>
                                        <Input
                                          type="number"
                                          min={0}
                                          max={3}
                                          value={channel.maxReferenceVideos ?? ""}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, {
                                            maxReferenceVideos: Math.max(0, Math.min(3, Math.round(Number(e.target.value || 0)))),
                                          })}
                                          placeholder="例如 3；不支持则填 0"
                                          className="font-mono text-xs"
                                        />
                                        <p className="mt-1 text-[10px] text-muted-foreground">上游允许的最大数量；只记录真实能力，不会自动凑数或隐式传送参考视频。</p>
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">最多参考音频（个）</Label>
                                        <Input
                                          type="number"
                                          min={0}
                                          max={3}
                                          value={channel.maxReferenceAudios ?? ""}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, {
                                            maxReferenceAudios: Math.max(0, Math.min(3, Math.round(Number(e.target.value || 0)))),
                                          })}
                                          placeholder="例如 1 或 3；不支持则填 0"
                                          className="font-mono text-xs"
                                        />
                                        <p className="mt-1 text-[10px] text-muted-foreground">上游允许的最大数量；只记录真实能力，不会自动凑数或隐式传送参考音频。</p>
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">参考视频替换提示词语言</Label>
                                        <select
                                          value={channel.directVideoReplacementPromptLanguage ?? "en"}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, {
                                            directVideoReplacementPromptLanguage: e.target.value === "zh-CN" ? "zh-CN" : "en",
                                          })}
                                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs outline-none"
                                        >
                                          <option value="en">英文（默认）</option>
                                          <option value="zh-CN">中文</option>
                                        </select>
                                        <p className="mt-1 text-[10px] text-muted-foreground">
                                          仅在该通道启用参考视频替换时生效，其他通道互不影响。
                                        </p>
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">API Key</Label>
                                        <PasswordInput
                                          value={adminCredentialDrafts[channel.id] ?? ""}
                                          onChange={(apiKey) => setAdminCredentialDrafts((current) => ({ ...current, [channel.id]: apiKey }))}
                                          placeholder={hasAdminChannelCredential(channel.id) ? "已加密保存，点击眼睛查看或输入新 Key" : "填写此通道的 API Key"}
                                          onReveal={() => void revealAdminCredential(channel.id)}
                                          onHideRevealedValue={() => setAdminCredentialDrafts((current) => ({ ...current, [channel.id]: "" }))}
                                          revealing={adminCredentialBusyChannelId === channel.id}
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">API 地址（baseUrl）</Label>
                                        <Input
                                          value={channel.baseUrl}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, { baseUrl: e.target.value })}
                                          placeholder="例如 https://api.xxx.com/v1"
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                    </div>
                                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">提交路径</Label>
                                        <Input
                                          value={channel.submitPath ?? "/videos"}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, { submitPath: e.target.value })}
                                          placeholder="/videos"
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">查询路径</Label>
                                        <Input
                                          value={channel.statusPath ?? "/videos/{id}"}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, { statusPath: e.target.value })}
                                          placeholder="/videos/{id}"
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="mb-1.5 text-xs text-muted-foreground">视频文件路径</Label>
                                        <Input
                                          value={channel.contentPath ?? "/videos/{id}/content"}
                                          onChange={(e) => updateCloneVideoChannel(channel.id, { contentPath: e.target.value })}
                                          placeholder="/videos/{id}/content"
                                          className="font-mono text-xs"
                                        />
                                      </div>
                                    </div>
                                    {channelTest && (
                                      <p className={`mt-3 text-[11px] ${
                                        channelTest.status === "success"
                                          ? "text-emerald-600"
                                          : channelTest.status === "error"
                                            ? "text-destructive"
                                            : "text-muted-foreground"
                                      }`}>
                                        {channelTest.message}
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                              {cloneVideoTestMessage && (
                                <p
                                  className={`text-[11px] ${
                                    cloneVideoTestStatus === "success" ? "text-emerald-600" : "text-destructive"
                                  }`}
                                >
                                  {cloneVideoTestMessage}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="border-t border-cyan-100/14 pt-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-xs font-semibold text-cyan-50">视频参考图公网托管</p>
                                  <CapabilityTestStatusPill status={hostingTestStatus} />
                                </div>
                                <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
                                  Grok 任务会临时上传手工连线的参考图，按原顺序发送公网 HTTPS 地址；视频成功后自动清理临时图片。
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] text-muted-foreground">
                                  {videoReferenceHosting.enabled ? "启用" : "暂停"}
                                </span>
                                <Toggle
                                  checked={videoReferenceHosting.enabled}
                                  onChange={(enabled) => setVideoReferenceHosting((current) => ({ ...current, enabled }))}
                                />
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                              <div>
                                <Label className="mb-1.5 text-xs text-muted-foreground">Cloud name</Label>
                                <Input
                                  value={videoReferenceHosting.cloudName}
                                  onChange={(event) => setVideoReferenceHosting((current) => ({
                                    ...current,
                                    cloudName: event.target.value,
                                  }))}
                                  placeholder="例如 clwc2glq"
                                  className="font-mono text-xs"
                                />
                              </div>
                              <div>
                                <Label className="mb-1.5 text-xs text-muted-foreground">API Key</Label>
                                <ProtectedConfigInput
                                  value={hostingCredentialDrafts.apiKey ?? videoReferenceHosting.apiKey}
                                  onChange={(apiKey) => updateHostingCredentialDraft("apiKey", apiKey)}
                                  placeholder="填写 Cloudinary API Key"
                                  onReveal={() => void revealHostingCredential("apiKey")}
                                  onHideRevealedValue={() => clearHostingCredentialDraft("apiKey")}
                                  revealing={hostingCredentialBusyField === "apiKey"}
                                />
                              </div>
                              <div>
                                <Label className="mb-1.5 text-xs text-muted-foreground">API Secret</Label>
                                <ProtectedConfigInput
                                  value={hostingCredentialDrafts.apiSecret ?? videoReferenceHosting.apiSecret}
                                  onChange={(apiSecret) => updateHostingCredentialDraft("apiSecret", apiSecret)}
                                  placeholder="填写 Cloudinary API Secret"
                                  onReveal={() => void revealHostingCredential("apiSecret")}
                                  onHideRevealedValue={() => clearHostingCredentialDraft("apiSecret")}
                                  revealing={hostingCredentialBusyField === "apiSecret"}
                                />
                            </div>

                            {hostingCredentialMessage && (
                              <p className="mt-2 text-[11px] text-muted-foreground">{hostingCredentialMessage}</p>
                            )}
                            </div>

                            <div className="mt-3 flex flex-wrap items-center gap-3">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 border-cyan-200/30 bg-cyan-300/10 text-xs text-cyan-50 hover:bg-cyan-300/20"
                                onClick={testVideoReferenceHosting}
                                disabled={
                                  hostingTestStatus === "testing"
                                  || !videoReferenceHosting.enabled
                                  || !videoReferenceHosting.cloudName.trim()
                                  || !pendingVideoReferenceHosting.apiKey
                                  || !pendingVideoReferenceHosting.apiSecret
                                }
                              >
                                <LuUpload className="h-3.5 w-3.5" />
                                {hostingTestStatus === "testing" ? "测试中..." : "测试公网托管"}
                              </Button>
                              {hostingTestMessage && (
                                <p
                                  className={`text-[11px] ${
                                    hostingTestStatus === "success" ? "text-emerald-300" : "text-rose-300"
                                  }`}
                                >
                                  {hostingTestMessage}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* API Key 输入 */}
                          <div className="mt-4">
                            <Label className="text-xs text-muted-foreground mb-1.5">
                              API Key
                            </Label>
                            <PasswordInput
                              value={provider.apiKey}
                              onChange={(apiKey) =>
                                setProvider(platform.key, {
                                  ...provider,
                                  apiKey,
                                })
                              }
                              placeholder={`输入 ${platform.name} 的 API Key`}
                            />
                          </div>
                          <div className="mt-3">
                            <Label className="text-xs text-muted-foreground mb-1.5">
                              API 地址（baseUrl，可选）
                            </Label>
                            <Input
                              value={provider.baseUrl ?? ""}
                              onChange={(e) =>
                                setProvider(platform.key, {
                                  ...provider,
                                  baseUrl: e.target.value,
                                })
                              }
                              placeholder="不填则使用该平台默认地址"
                              className="font-mono text-xs"
                            />
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
              <Card className="glass-card">
                <CardContent className="p-0">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedProviders((value) => !value)}
                    className="flex w-full items-center justify-between gap-3 p-5 text-left"
                  >
                    <div>
                      <h3 className="text-sm font-semibold">高级备用 AI 平台</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Atlas Cloud、fal.ai、火山引擎、阿里百炼、硅基流动。暂时不用时保持隐藏。
                      </p>
                    </div>
                    <LuChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showAdvancedProviders ? "rotate-180" : ""}`} />
                  </button>
                  {showAdvancedProviders && (
                    <div className="space-y-4 border-t border-border/50 p-5">
                      {ADVANCED_AI_PROVIDERS.map((platform) => {
                        const provider = providers[platform.key] ?? {
                          enabled: false,
                          apiKey: "",
                        };

                        return (
                          <Card key={platform.key} className="border-border/50 bg-background/50">
                            <CardContent className="p-4">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${platform.iconBg} text-white shadow-lg`}>
                                    {platform.icon}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="mb-1 flex items-center gap-2">
                                      <h3 className="text-sm font-semibold">{platform.name}</h3>
                                      {provider.enabled && (
                                        <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                                          已启用
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-xs leading-relaxed text-muted-foreground">{platform.description}</p>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground/70">{platform.tip}</p>
                                  </div>
                                </div>
                                <Toggle
                                  checked={provider.enabled}
                                  onChange={(enabled) =>
                                    setProvider(platform.key, {
                                      ...provider,
                                      enabled,
                                    })
                                  }
                                />
                              </div>
                              <div className="mt-4">
                                <Label className="mb-1.5 text-xs text-muted-foreground">API Key</Label>
                                <PasswordInput
                                  value={provider.apiKey}
                                  onChange={(apiKey) =>
                                    setProvider(platform.key, {
                                      ...provider,
                                      apiKey,
                                    })
                                  }
                                  placeholder={`输入 ${platform.name} 的 API Key`}
                                />
                              </div>
                              <div className="mt-3">
                                <Label className="mb-1.5 text-xs text-muted-foreground">API 地址（baseUrl，可选）</Label>
                                <Input
                                  value={provider.baseUrl ?? ""}
                                  onChange={(e) =>
                                    setProvider(platform.key, {
                                      ...provider,
                                      baseUrl: e.target.value,
                                    })
                                  }
                                  placeholder="不填则使用该平台默认地址"
                                  className="font-mono text-xs"
                                />
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Tab 2: LLM 配置 */}
          <TabsContent value={1}>
            <div className="space-y-6">
              {/* LLM Provider 配置 */}
              <Card className="glass-card">
                <CardContent className="p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 text-white">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">LLM 主配置</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        用于脚本生成、商品图视觉分析、方法库拆解、视频导演稿和爆款复刻规划。
                      </p>
                    </div>
                  </div>

                  {/* 快捷预设 */}
                  <div className="mb-4 p-3 rounded-lg bg-muted/50 border border-border/50">
                    <p className="text-xs text-muted-foreground mb-2">
                      当前主模型与视觉模型会共同用于脚本、拆解、导演稿和能力测试；API Key 始终沿用你自己的配置。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: "GPT-5.6 Sol", baseUrl: "https://api.zzbei.cc/v1", model: "gpt-5.6-sol", tip: "当前主用" },
                        { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v3.2", tip: "V3.2 推理+对话统一模型" },
                        { label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5", tip: "K2.5 支持 Agent Swarm" },
                        { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5-turbo", tip: "GLM-5 旗舰级" },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => setLLM({ ...llm, baseUrl: preset.baseUrl, model: preset.model })}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border border-border/50 bg-background hover:border-primary/40 hover:text-primary transition-colors"
                        >
                          {preset.label}
                          {preset.tip && <span className="text-[10px] text-muted-foreground/70">({preset.tip})</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4">
                    {/* API 地址 */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        API 地址（baseUrl）
                      </Label>
                      <Input
                        value={llm.baseUrl}
                        onChange={(e) =>
                          setLLM({ ...llm, baseUrl: e.target.value })
                        }
                        placeholder="https://api.openai.com/v1"
                        className="font-mono text-xs"
                      />
                    </div>

                    {/* API Key */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        API Key
                      </Label>
                      <PasswordInput
                        value={adminCredentialDrafts["llm-default"] ?? ""}
                        onChange={(apiKey) => setAdminCredentialDrafts((current) => ({ ...current, "llm-default": apiKey }))}
                        placeholder={hasAdminChannelCredential("llm-default") ? "已加密保存，点击眼睛查看或输入新 Key" : "填写 LLM API Key"}
                        onReveal={() => void revealAdminCredential("llm-default")}
                        onHideRevealedValue={() => setAdminCredentialDrafts((current) => ({ ...current, "llm-default": "" }))}
                        revealing={adminCredentialBusyChannelId === "llm-default"}
                      />
                    </div>

                    {/* 模型名称 */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          文本模型 / 主模型
                        </Label>
                        <Input
                          value={llm.model}
                          onChange={(e) =>
                            setLLM({ ...llm, model: e.target.value })
                          }
                          placeholder="gpt-5.6-sol"
                          className="font-mono text-xs"
                        />
                        <p className="mt-1 text-[11px] text-muted-foreground/60">
                          默认承担文本、商品分析、方法拆解、视频导演稿等任务。
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          视觉模型（可选）
                        </Label>
                        <Input
                          value={llm.visionModel ?? ""}
                          onChange={(e) =>
                            setLLM({
                              ...llm,
                              visionModel: e.target.value || undefined,
                            })
                          }
                          placeholder={llm.model ? `留空则使用主模型 ${llm.model}` : "留空则使用主模型"}
                          className="font-mono text-xs"
                        />
                        <p className="mt-1 text-[11px] text-muted-foreground/60">
                          填写时优先用于图片拆解、导演稿和视觉测试；留空则跟随当前主模型。
                        </p>
                      </div>
                    </div>

                    {/* 测试连接按钮 */}
                    <section className="mt-3 border-t border-cyan-100/10 pt-5" aria-labelledby="llm-capability-test-title">
                      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-200/20 bg-cyan-300/10 text-cyan-200">
                            <LuSparkles className="h-4 w-4" />
                          </div>
                          <div>
                            <h4 id="llm-capability-test-title" className="text-sm font-semibold text-slate-100">LLM 能力测试</h4>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">请求是否返回由系统展示；回答内容是否正确由人工验收，不自动判定“可用”。</p>
                          </div>
                        </div>
                        <span className="w-fit rounded-full border border-cyan-200/15 bg-slate-950/20 px-2.5 py-1 text-[11px] font-mono text-cyan-100/80">
                          主模型 {llm.model || "未配置"}
                        </span>
                      </div>

                      <div className="grid gap-4 xl:grid-cols-3">
                        <section className="flex min-w-0 flex-col rounded-2xl border border-cyan-100/14 bg-slate-950/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[11px] font-semibold tracking-[0.12em] text-cyan-100/55">01 · TEXT</p>
                              <h5 className="mt-1 text-sm font-semibold text-slate-100">文本连通</h5>
                            </div>
                            <CapabilityTestStatusPill status={llmTestStatus} />
                          </div>
                          <p className="mt-3 min-h-10 text-xs leading-5 text-muted-foreground">保持原有文本测试请求，用于确认当前主模型可以正常返回。</p>
                          <div className="mt-4 flex items-center justify-between gap-3 border-t border-cyan-100/10 pt-3">
                            <span className="truncate text-[11px] font-mono text-cyan-100/65">{llm.model || "未配置模型"}</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={testLLMConnection}
                              disabled={!selectedLlmConfigured || !llm.baseUrl || llmTestStatus === "testing"}
                              className="shrink-0 border-cyan-200/20 bg-cyan-300/5 text-xs text-cyan-50 hover:border-cyan-200/40 hover:bg-cyan-300/10"
                            >
                              {llmTestStatus === "testing" ? "测试中..." : "开始测试"}
                            </Button>
                          </div>
                          {llmTestMessage && (
                            <div className={`mt-3 rounded-xl border p-3 ${llmTestStatus === "error" ? "border-rose-300/20 bg-rose-300/5" : "border-cyan-100/12 bg-black/10"}`} aria-live="polite">
                              <p className="text-[11px] font-semibold text-slate-300">{llmTestStatus === "error" ? "请求失败详情" : "连接返回"}</p>
                              <p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 ${llmTestStatus === "error" ? "text-rose-100" : "text-cyan-50/85"}`}>{llmTestMessage}</p>
                            </div>
                          )}
                        </section>

                        <section className="flex min-w-0 flex-col rounded-2xl border border-cyan-100/14 bg-slate-950/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[11px] font-semibold tracking-[0.12em] text-cyan-100/55">02 · VISION</p>
                              <h5 className="mt-1 text-sm font-semibold text-slate-100">视觉识别</h5>
                            </div>
                            <CapabilityTestStatusPill status={visionTestStatus} />
                          </div>
                          <p className="mt-3 text-xs leading-5 text-muted-foreground">上传白底水果图；模型应只返回水果名称，原始回答由您核对。</p>
                          <div className="mt-3 space-y-2">
                            <Label className="text-[11px] font-medium text-cyan-100/70">测试图片</Label>
                            <Input
                              type="file"
                              accept="image/*"
                              onChange={(e) => {
                                handleVisionTestImage(e.target.files?.[0]);
                                e.target.value = "";
                              }}
                              className="h-9 border-cyan-100/16 bg-black/10 text-xs file:mr-3 file:border-0 file:bg-transparent file:text-cyan-50"
                            />
                            {visionTestImage ? (
                              <div className="flex items-center gap-2 rounded-xl border border-cyan-100/12 bg-black/10 p-2">
                                <img src={visionTestImage.dataUrl} alt="当前视觉测试图" className="h-10 w-10 rounded-lg border border-cyan-100/10 object-cover" />
                                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{visionTestImage.name}</span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-slate-100"
                                  onClick={() => {
                                    setVisionTestImage(null);
                                    setVisionTestStatus("idle");
                                    setVisionTestMessage("");
                                  }}
                                >
                                  清除
                                </Button>
                              </div>
                            ) : (
                              <p className="text-[11px] leading-4 text-muted-foreground/75">未上传时会使用内置颜色图，仅验证视觉请求能否返回。</p>
                            )}
                          </div>
                          <div className="mt-4 flex items-center justify-between gap-3 border-t border-cyan-100/10 pt-3">
                            <span className="truncate text-[11px] font-mono text-cyan-100/65">{llm.visionModel?.trim() || llm.model || "未配置模型"}</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={testVisionConnection}
                              disabled={!selectedLlmConfigured || !llm.baseUrl || !(llm.visionModel || llm.model) || visionTestStatus === "testing"}
                              className="shrink-0 border-cyan-200/20 bg-cyan-300/5 text-xs text-cyan-50 hover:border-cyan-200/40 hover:bg-cyan-300/10"
                            >
                              {visionTestStatus === "testing" ? "识别中..." : "开始测试"}
                            </Button>
                          </div>
                          {visionTestMessage && (
                            <div className={`mt-3 rounded-xl border p-3 ${visionTestStatus === "error" ? "border-rose-300/20 bg-rose-300/5" : "border-cyan-100/12 bg-black/10"}`} aria-live="polite">
                              <p className="text-[11px] font-semibold text-slate-300">{visionTestStatus === "error" ? "请求失败详情" : "模型原始回答 · 待人工验收"}</p>
                              <p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 ${visionTestStatus === "error" ? "text-rose-100" : "text-cyan-50/85"}`}>{visionTestMessage}</p>
                            </div>
                          )}
                        </section>

                        <section className="flex min-w-0 flex-col rounded-2xl border border-cyan-100/14 bg-slate-950/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[11px] font-semibold tracking-[0.12em] text-cyan-100/55">03 · AUDIO</p>
                              <h5 className="mt-1 text-sm font-semibold text-slate-100">音频转写</h5>
                            </div>
                            <CapabilityTestStatusPill status={audioTestStatus} />
                          </div>
                          <p className="mt-3 text-xs leading-5 text-muted-foreground">上传一段简短 MP3/WAV；模型应只返回实际口播内容，原始转写由您核对。</p>
                          <div className="mt-3 space-y-2">
                            <Label className="text-[11px] font-medium text-cyan-100/70">测试音频</Label>
                            <Input
                              type="file"
                              accept="audio/mpeg,audio/mp3,audio/wav,.mp3,.wav"
                              onChange={(e) => {
                                handleAudioTestFile(e.target.files?.[0]);
                                e.target.value = "";
                              }}
                              className="h-9 border-cyan-100/16 bg-black/10 text-xs file:mr-3 file:border-0 file:bg-transparent file:text-cyan-50"
                            />
                            {audioTestFile ? (
                              <div className="flex items-center gap-2 rounded-xl border border-cyan-100/12 bg-black/10 p-2">
                                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{audioTestFile.name}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">{Math.max(1, Math.ceil(audioTestFile.size / 1024))} KB</span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-slate-100"
                                  onClick={() => {
                                    setAudioTestFile(null);
                                    setAudioTestStatus("idle");
                                    setAudioTestMessage("");
                                  }}
                                >
                                  清除
                                </Button>
                              </div>
                            ) : (
                              <p className="text-[11px] leading-4 text-muted-foreground/75">仅支持 MP3/WAV，单个文件不超过 50MB。</p>
                            )}
                          </div>
                          <div className="mt-4 flex items-center justify-between gap-3 border-t border-cyan-100/10 pt-3">
                            <span className="truncate text-[11px] font-mono text-cyan-100/65">{llm.model || "未配置模型"}</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={testAudioTranscription}
                              disabled={!selectedLlmConfigured || !llm.baseUrl || !audioTestFile || audioTestStatus === "testing"}
                              className="shrink-0 border-cyan-200/20 bg-cyan-300/5 text-xs text-cyan-50 hover:border-cyan-200/40 hover:bg-cyan-300/10"
                            >
                              {audioTestStatus === "testing" ? "转写中..." : "开始测试"}
                            </Button>
                          </div>
                          {audioTestMessage && (
                            <div className={`mt-3 rounded-xl border p-3 ${audioTestStatus === "error" ? "border-rose-300/20 bg-rose-300/5" : "border-cyan-100/12 bg-black/10"}`} aria-live="polite">
                              <p className="text-[11px] font-semibold text-slate-300">{audioTestStatus === "error" ? "请求失败详情" : "模型原始转写 · 待人工验收"}</p>
                              <p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 ${audioTestStatus === "error" ? "text-rose-100" : "text-cyan-50/85"}`}>{audioTestMessage}</p>
                            </div>
                          )}
                        </section>
                      </div>
                    </section>

                    <div className="hidden">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={testLLMConnection}
                        disabled={!selectedLlmConfigured || !llm.baseUrl || llmTestStatus === "testing"}
                        className={`text-xs ${
                          llmTestStatus === "success"
                            ? "text-emerald-600"
                            : llmTestStatus === "error"
                            ? "text-destructive"
                            : ""
                        }`}
                      >
                        {llmTestStatus === "testing" ? "测试中..."
                         : llmTestStatus === "success" ? "连接成功 ✓"
                         : llmTestStatus === "error" ? "连接失败 ✗"
                         : "测试连接"}
                      </Button>
                      {!selectedLlmConfigured && (
                        <span className="text-xs text-muted-foreground ml-2">请先在 LLM 配置中填写管理员 LLM Key</span>
                      )}
                      {llmTestMessage && (
                        <p className={`text-xs mt-2 ${llmTestStatus === "success" ? "text-emerald-600" : "text-destructive"}`}>
                          {llmTestMessage}
                        </p>
                      )}
                      <div>
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                              handleVisionTestImage(e.target.files?.[0]);
                              e.target.value = "";
                            }}
                            className="h-8 w-full max-w-xs text-xs"
                          />
                          {visionTestImage ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => {
                                setVisionTestImage(null);
                                setVisionTestStatus("idle");
                                setVisionTestMessage("");
                              }}
                            >
                              清除测试图
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              上传白底水果图后，模型只回答水果名称；未上传时使用内置颜色测试图。
                            </span>
                          )}
                        </div>
                        {visionTestImage && (
                          <p className="mb-2 text-xs text-muted-foreground">
                            当前测试图：{visionTestImage.name}
                          </p>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={testVisionConnection}
                          disabled={!selectedLlmConfigured || !llm.baseUrl || !(llm.visionModel || llm.model) || visionTestStatus === "testing"}
                          className={`text-xs ${
                            visionTestStatus === "success"
                              ? "text-emerald-600"
                              : visionTestStatus === "error"
                              ? "text-destructive"
                              : ""
                          }`}
                        >
                          {visionTestStatus === "testing" ? "测试中..."
                           : visionTestStatus === "success" ? "视觉可用 ✓"
                           : visionTestStatus === "error" ? "视觉不可用 ✗"
                           : "测试视觉分析"}
                        </Button>
                        <span className="text-xs text-muted-foreground ml-2">
                          使用视觉模型；未填写时跟随当前 LLM 主模型。模型回答会原样展示，供人工验收。
                        </span>
                        {visionTestMessage && (
                          <p className={`text-xs mt-2 ${visionTestStatus === "success" ? "text-emerald-600" : "text-destructive"}`}>
                            {visionTestMessage}
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
                        <div className="mb-2 grid grid-cols-1 gap-2">
                          <Input
                            type="file"
                            accept="audio/mpeg,audio/mp3,audio/wav,.mp3,.wav"
                            onChange={(e) => {
                              handleAudioTestFile(e.target.files?.[0]);
                              e.target.value = "";
                            }}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          {audioTestFile ? (
                            <>
                              <span className="text-xs text-muted-foreground">
                                当前测试文件：{audioTestFile.name}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => {
                                  setAudioTestFile(null);
                                  setAudioTestStatus("idle");
                                  setAudioTestMessage("");
                                }}
                              >
                                清除测试文件
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              上传一段简短 MP3/WAV 音频；模型会只返回其中实际说的话，供人工核对。
                            </span>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={testAudioTranscription}
                          disabled={!selectedLlmConfigured || !llm.baseUrl || !audioTestFile || audioTestStatus === "testing"}
                          className={`text-xs ${
                            audioTestStatus === "success"
                              ? "text-emerald-600"
                              : audioTestStatus === "error"
                              ? "text-destructive"
                              : ""
                          }`}
                        >
                          {audioTestStatus === "testing"
                            ? "语音识别测试中..."
                            : audioTestStatus === "success"
                            ? "语音识别可用 ✓"
                            : audioTestStatus === "error"
                            ? "语音识别不可用 ✕"
                            : "测试语音识别"}
                        </Button>
                        {audioTestStatus === "testing" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="ml-2 h-8 text-xs"
                            onClick={() => {
                              setAudioTestStatus("idle");
                              setAudioTestMessage("已手动重置测试状态。服务端如果已经返回，重新点一次测试即可。");
                            }}
                          >
                            重置状态
                          </Button>
                        )}
                        <span className="ml-2 text-xs text-muted-foreground">
                          音频测试固定使用当前 LLM 主模型：{llm.model || "未配置"}。
                        </span>
                        {audioTestMessage && (
                          <p className={`mt-2 whitespace-pre-wrap text-xs ${audioTestStatus === "success" ? "text-emerald-600" : "text-destructive"}`}>
                            {audioTestMessage}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

            </div>
          </TabsContent>
          {/* Tab 3: 品牌设置 */}
          <TabsContent value={2}>
            <BrandSettings />
          </TabsContent>
          <TabsContent value={3}>
            <SystemManagement
              key={selectedUserId}
              users={users}
              invites={invites}
              selectedUserId={selectedUserId}
              lastInviteCode={lastInviteCode}
              modelMessage={modelAdminMessage}
              inviteMessage={inviteMessage}
              isInvitesLoading={isInvitesLoading}
              deletingInviteId={deletingInviteId}
              userCredentials={userCredentials}
              credentialDrafts={credentialDrafts}
              credentialMessage={credentialMessage}
              credentialBusyChannelId={credentialBusyChannelId}
              userHostingCredential={userHostingCredential}
              userHostingCredentialDrafts={userHostingCredentialDrafts}
              userHostingCredentialChangedFields={userHostingCredentialChangedFields}
              userHostingCredentialMessage={userHostingCredentialMessage}
              userHostingCredentialBusyField={userHostingCredentialBusyField}
              userFeatureEntries={userFeatureEntries}
              userFeatureEntryMessage={userFeatureEntryMessage}
              userFeatureEntryBusyKey={userFeatureEntryBusyKey}
              onSelectUser={loadModelSettingsForUser}
              onCredentialDraftChange={(channelId, value) => setCredentialDrafts((current) => ({ ...current, [channelId]: value }))}
              onSaveCredential={updateUserCredential}
              onRevealCredential={revealUserCredential}
              onClearCredential={clearUserCredential}
              onUserHostingCredentialDraftChange={changeUserHostingCredentialDraft}
              onRevealUserHostingCredential={revealUserHostingCredential}
              onHideUserHostingCredential={(field) => setUserHostingCredentialDrafts((current) => ({ ...current, [field]: "" }))}
              onSaveUserHostingCredentials={saveUserHostingCredentials}
              onClearUserHostingCredentials={clearUserHostingCredentials}
              onUpdateUserFeatureEntry={updateUserFeatureEntry}
              onCreateInvite={createInvite}
              onRefreshInvites={refreshInvites}
              onDeleteInvite={deleteInvite}
              onToggleUser={toggleUserDisabled}
            />
          </TabsContent>
        </Tabs>

        {/* 底部保存按钮 */}
        <div className="luma-settings-statusbar mt-8 flex items-center justify-between gap-3">
          {/* 配置状态摘要 */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p className={selectedLlmConfigured ? "text-emerald-600" : "text-amber-600"}>
              {selectedLlmConfigured ? "✓ 管理员 LLM Key 已配置" : "⚠ 管理员 LLM Key 未配置（脚本生成需要）"}
            </p>
            <p className={hasAnyProvider ? "text-emerald-600" : "text-amber-600"}>
              {hasAnyProvider ? `✓ ${enabledCount} 个 AI 平台已启用` : "⚠ 无 AI 平台启用（素材生成需要）"}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {saved && (
              <span className="text-sm text-emerald-400 animate-in fade-in slide-in-from-right-2">
                设置已保存
              </span>
            )}
            <Button
              onClick={handleSave}
              className="brand-gradient text-white px-6"
              size="lg"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              保存设置
            </Button>
          </div>
        </div>
        </div>
      </main>
      </div>
    </div>
  );
}

type AdminUserRow = {
  id: string;
  accountId: string;
  username: string;
  role: string;
  disabled: boolean | null;
};

type InviteRow = {
  id: string;
  label: string | null;
  createdAt: string | Date;
  expiresAt: string | Date;
  usedAt: string | Date | null;
  usedByUserId: string | null;
};

type ModelCredentialRow = {
  channelId: string;
  kind: "llm" | "image" | "video";
  providerKey: string;
  name: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  updatedAt: string | Date | null;
};

type UserFeatureEntryRow = {
  featureKey: WorkspaceModuleId;
  entryState: WorkspaceFeatureEntryState;
  updatedAt: string | Date | null;
};

function inviteDate(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatInviteDate(value: string | Date | null | undefined) {
  const date = inviteDate(value);
  if (!date) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function inviteStatus(invite: InviteRow) {
  if (invite.usedAt) return { label: "已使用", className: "border-white/10 bg-white/[0.045] text-slate-300" };
  const expiresAt = inviteDate(invite.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { label: "已过期", className: "border-amber-200/20 bg-amber-200/10 text-amber-100" };
  }
  return { label: "未使用", className: "border-emerald-200/20 bg-emerald-200/10 text-emerald-200" };
}

function SystemManagement({
  users,
  invites,
  selectedUserId,
  lastInviteCode,
  modelMessage,
  inviteMessage,
  isInvitesLoading,
  deletingInviteId,
  userCredentials,
  credentialDrafts,
  credentialMessage,
  credentialBusyChannelId,
  userHostingCredential,
  userHostingCredentialDrafts,
  userHostingCredentialChangedFields,
  userHostingCredentialMessage,
  userHostingCredentialBusyField,
  userFeatureEntries,
  userFeatureEntryMessage,
  userFeatureEntryBusyKey,
  onSelectUser,
  onCredentialDraftChange,
  onSaveCredential,
  onRevealCredential,
  onClearCredential,
  onUserHostingCredentialDraftChange,
  onRevealUserHostingCredential,
  onHideUserHostingCredential,
  onSaveUserHostingCredentials,
  onClearUserHostingCredentials,
  onUpdateUserFeatureEntry,
  onCreateInvite,
  onRefreshInvites,
  onDeleteInvite,
  onToggleUser,
}: {
  users: AdminUserRow[];
  invites: InviteRow[];
  selectedUserId: string;
  lastInviteCode: string;
  modelMessage: string;
  inviteMessage: string;
  isInvitesLoading: boolean;
  deletingInviteId: string;
  userCredentials: ModelCredentialRow[];
  credentialDrafts: Record<string, string>;
  credentialMessage: string;
  credentialBusyChannelId: string;
  userHostingCredential: UserVideoReferenceHostingCredentialState | null;
  userHostingCredentialDrafts: Partial<Record<HostingCredentialField, string>>;
  userHostingCredentialChangedFields: HostingCredentialField[];
  userHostingCredentialMessage: string;
  userHostingCredentialBusyField: string;
  userFeatureEntries: UserFeatureEntryRow[];
  userFeatureEntryMessage: string;
  userFeatureEntryBusyKey: string;
  onSelectUser: (userId: string) => void;
  onCredentialDraftChange: (channelId: string, value: string) => void;
  onSaveCredential: (channelId: string) => void;
  onRevealCredential: (channelId: string) => void;
  onClearCredential: (channelId: string) => void;
  onUserHostingCredentialDraftChange: (field: HostingCredentialField, value: string) => void;
  onRevealUserHostingCredential: (field: HostingCredentialField) => void;
  onHideUserHostingCredential: (field: HostingCredentialField) => void;
  onSaveUserHostingCredentials: () => void;
  onClearUserHostingCredentials: () => void;
  onUpdateUserFeatureEntry: (featureKey: WorkspaceModuleId, entryState: WorkspaceFeatureEntryState) => void;
  onCreateInvite: () => void;
  onRefreshInvites: () => void;
  onDeleteInvite: (inviteId: string) => void;
  onToggleUser: (userId: string, disabled: boolean) => void;
}) {
  const normalUsers = users.filter((user) => user.role === "user");
  const selectedUser = normalUsers.find((user) => user.id === selectedUserId);
  const [revealedChannels, setRevealedChannels] = useState<string[]>([]);
  const hostingBusy = Boolean(userHostingCredentialBusyField);
  const hostingDraftApiKey = userHostingCredentialChangedFields.includes("apiKey")
    ? userHostingCredentialDrafts.apiKey?.trim() || ""
    : "";
  const hostingDraftApiSecret = userHostingCredentialChangedFields.includes("apiSecret")
    ? userHostingCredentialDrafts.apiSecret?.trim() || ""
    : "";
  const canSaveHostingCredentials = Boolean(
    userHostingCredential
    && (userHostingCredential.configured
      ? hostingDraftApiKey || hostingDraftApiSecret
      : hostingDraftApiKey && hostingDraftApiSecret),
  );

  return (
    <div className="space-y-5">
      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-slate-50">普通用户通道凭证</h3>
              <p className="mt-1 text-sm text-slate-300/70">
                {selectedUser ? `正在配置 ${selectedUser.username} 在共享通道上的私有 Key。通道配置由管理员在 AI 平台维护。` : "先选择普通用户，再配置其各共享通道的私有 Key。"}
              </p>
            </div>
          </div>

          {modelMessage && <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.045] p-3 text-sm text-slate-200">{modelMessage}</div>}

          <div className="grid gap-3 lg:grid-cols-2">
            {normalUsers.map((user) => (
              <div
                key={user.id}
                className={`rounded-lg border p-4 transition ${
                  selectedUserId === user.id
                    ? "border-cyan-100/34 bg-cyan-200/12"
                    : "border-white/10 bg-white/[0.035]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => onSelectUser(user.id)}>
                    <div className="truncate text-base font-bold text-slate-50">{user.username}</div>
                    <div className="mt-1 font-mono text-xs text-cyan-100/72">{user.accountId}</div>
                  </button>
                  <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-xs text-slate-300">
                    {user.role === "admin" ? "管理员" : "普通用户"}
                  </span>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-slate-300/72">
                  <span>{user.disabled ? "已禁用" : "已启用"}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onToggleUser(user.id, !user.disabled)}
                  >
                    {user.disabled ? "启用" : "禁用"}
                  </Button>
                </div>
              </div>
            ))}
            {normalUsers.length === 0 && <p className="text-sm text-slate-400">还没有普通用户。</p>}
          </div>
          <div className="mt-5 border-t border-white/10 pt-5">
            <Tabs defaultValue="credentials">
              <TabsList>
                <TabsTrigger value="credentials">通道凭证</TabsTrigger>
                <TabsTrigger value="api-calls">API 调用记录</TabsTrigger>
                <TabsTrigger value="feature-entries">功能开放</TabsTrigger>
              </TabsList>
              <TabsContent value="credentials" className="mt-4">
            {selectedUser ? (
              <>
                {credentialMessage && <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.045] p-3 text-sm text-slate-200">{credentialMessage}</div>}
                <div className="space-y-3">
                  {userCredentials.map((credential) => {
                    const busy = credentialBusyChannelId === credential.channelId;
                    const revealed = revealedChannels.includes(credential.channelId);
                    return (
                      <div key={credential.channelId} className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,1.15fr)_auto] lg:items-end">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-100">{credential.name}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${credential.configured ? "border-emerald-200/20 bg-emerald-200/10 text-emerald-100" : "border-white/10 bg-white/[0.04] text-slate-300"}`}>
                              {credential.configured ? "已配置" : "未配置"}
                            </span>
                            {!credential.enabled && <span className="rounded-full border border-amber-200/20 bg-amber-200/10 px-2 py-0.5 text-[11px] text-amber-100">通道已停用</span>}
                          </div>
                          <p className="mt-1 truncate font-mono text-xs text-slate-400">{credential.kind.toUpperCase()} · {credential.model || "未设置模型"}</p>
                        </div>
                        <div>
                          <Label className="mb-1.5 text-xs text-muted-foreground">该用户的 API Key</Label>
                          <Input
                            type={revealed ? "text" : "password"}
                            autoComplete="off"
                            value={credentialDrafts[credential.channelId] ?? ""}
                            onChange={(event) => onCredentialDraftChange(credential.channelId, event.target.value)}
                            placeholder={credential.configured ? "已加密保存，输入新 Key 可替换" : "填写该用户在此通道的 Key"}
                            className="font-mono text-xs"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            title={revealed ? "隐藏 Key" : "查看已保存的 Key"}
                            aria-label={revealed ? "隐藏 Key" : "查看已保存的 Key"}
                            disabled={busy || !credential.configured}
                            onClick={() => {
                              if (revealed) {
                                setRevealedChannels((current) => current.filter((id) => id !== credential.channelId));
                                onCredentialDraftChange(credential.channelId, "");
                              } else {
                                setRevealedChannels((current) => [...current, credential.channelId]);
                                onRevealCredential(credential.channelId);
                              }
                            }}
                          >
                            <LuEye />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            title="保存该用户 Key"
                            aria-label="保存该用户 Key"
                            disabled={busy || !credentialDrafts[credential.channelId]?.trim()}
                            onClick={() => onSaveCredential(credential.channelId)}
                          >
                            <LuSave />
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="icon"
                            title="清除该用户 Key"
                            aria-label="清除该用户 Key"
                            disabled={busy || !credential.configured}
                            onClick={() => onClearCredential(credential.channelId)}
                          >
                            <LuTrash2 />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {userHostingCredential && (
                    <div className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(220px,1fr)_minmax(220px,1fr)_auto] lg:items-end">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-slate-100">公网托管（Cloudinary）</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${userHostingCredential.configured ? "border-emerald-200/20 bg-emerald-200/10 text-emerald-100" : "border-white/10 bg-white/[0.04] text-slate-300"}`}>
                            {userHostingCredential.configured ? "已配置" : "未配置"}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">共享 Cloud name 和托管通道；仅为该用户保存独立 API Key 与 API Secret。</p>
                      </div>
                      <div>
                        <Label className="mb-1.5 text-xs text-muted-foreground">API Key</Label>
                        <PasswordInput
                          value={userHostingCredentialDrafts.apiKey ?? ""}
                          onChange={(value) => onUserHostingCredentialDraftChange("apiKey", value)}
                          placeholder={userHostingCredential.configured ? "已加密保存，点击眼睛查看或输入新 Key" : "填写该用户的 Cloudinary API Key"}
                          disabled={hostingBusy}
                          revealing={userHostingCredentialBusyField === "apiKey"}
                          onReveal={userHostingCredential.configured ? () => onRevealUserHostingCredential("apiKey") : undefined}
                          onHideRevealedValue={() => onHideUserHostingCredential("apiKey")}
                        />
                      </div>
                      <div>
                        <Label className="mb-1.5 text-xs text-muted-foreground">API Secret</Label>
                        <PasswordInput
                          value={userHostingCredentialDrafts.apiSecret ?? ""}
                          onChange={(value) => onUserHostingCredentialDraftChange("apiSecret", value)}
                          placeholder={userHostingCredential.configured ? "已加密保存，点击眼睛查看或输入新 Secret" : "填写该用户的 Cloudinary API Secret"}
                          disabled={hostingBusy}
                          revealing={userHostingCredentialBusyField === "apiSecret"}
                          onReveal={userHostingCredential.configured ? () => onRevealUserHostingCredential("apiSecret") : undefined}
                          onHideRevealedValue={() => onHideUserHostingCredential("apiSecret")}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          title="保存该用户的公网托管凭证"
                          aria-label="保存该用户的公网托管凭证"
                          disabled={hostingBusy || !canSaveHostingCredentials}
                          onClick={onSaveUserHostingCredentials}
                        >
                          <LuSave />
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          title="清除该用户的公网托管凭证"
                          aria-label="清除该用户的公网托管凭证"
                          disabled={hostingBusy || !userHostingCredential.configured}
                          onClick={onClearUserHostingCredentials}
                        >
                          <LuTrash2 />
                        </Button>
                      </div>
                    </div>
                  )}
                  {userCredentials.length === 0 && <p className="text-sm text-slate-400">管理员尚未配置共享通道。</p>}
                  {userHostingCredentialMessage && <div className="rounded-lg border border-white/10 bg-white/[0.045] p-3 text-sm text-slate-200">{userHostingCredentialMessage}</div>}
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-400">选择上方任一普通用户后，这里会显示其全部共享通道凭证。</p>
            )}
              </TabsContent>
              <TabsContent value="api-calls" className="mt-4">
                <ModelApiCallPanel selectedUserId={selectedUserId} normalUsers={normalUsers} />
              </TabsContent>
              <TabsContent value="feature-entries" className="mt-4">
                <FeatureEntryPanel
                  selectedUser={selectedUser}
                  entries={userFeatureEntries}
                  message={userFeatureEntryMessage}
                  busyFeatureKey={userFeatureEntryBusyKey}
                  onUpdate={onUpdateUserFeatureEntry}
                />
              </TabsContent>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-slate-50">邀请码管理</h3>
              <p className="mt-1 text-sm text-slate-300/70">明文仅在创建时显示一次，记录保留邀请码的状态与时间。</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={onCreateInvite}
                disabled={isInvitesLoading}
              >
                <LuPlus data-icon="inline-start" />
                生成邀请码
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="刷新邀请码记录"
                title="刷新邀请码记录"
                disabled={isInvitesLoading}
                onClick={onRefreshInvites}
              >
                <LuRefreshCw className={isInvitesLoading ? "animate-spin" : ""} />
              </Button>
            </div>
          </div>

          {lastInviteCode && (
            <div className="mb-3 rounded-lg border border-cyan-100/18 bg-cyan-200/10 p-3 text-sm text-cyan-50">
              <div className="text-xs text-cyan-100/75">新邀请码，仅此一次</div>
              <div className="mt-1 select-all font-mono font-bold tracking-[0.12em]">{lastInviteCode}</div>
            </div>
          )}
          {inviteMessage && <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.045] p-3 text-sm text-slate-200">{inviteMessage}</div>}

          <div className="space-y-2">
            {invites.length === 0 ? (
              <p className="text-sm text-slate-400">{isInvitesLoading ? "正在读取邀请码记录…" : "还没有邀请码。"}</p>
            ) : (
              invites.map((invite) => {
                const status = inviteStatus(invite);
                return (
                  <div key={invite.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-100">{invite.label || "一次性邀请码"}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate-400">
                        <span>创建 {formatInviteDate(invite.createdAt)}</span>
                        <span>到期 {formatInviteDate(invite.expiresAt)}</span>
                        {invite.usedAt && <span>使用 {formatInviteDate(invite.usedAt)}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full border px-2 py-1 text-xs ${status.className}`}>{status.label}</span>
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon-xs"
                        aria-label={`删除${invite.label || "邀请码"}`}
                        title="删除邀请码"
                        disabled={deletingInviteId === invite.id}
                        onClick={() => onDeleteInvite(invite.id)}
                      >
                        <LuTrash2 />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FeatureEntryPanel({
  selectedUser,
  entries,
  message,
  busyFeatureKey,
  onUpdate,
}: {
  selectedUser: AdminUserRow | undefined;
  entries: UserFeatureEntryRow[];
  message: string;
  busyFeatureKey: string;
  onUpdate: (featureKey: WorkspaceModuleId, entryState: WorkspaceFeatureEntryState) => void;
}) {
  if (!selectedUser) {
    return <p className="text-sm text-slate-400">选择上方任一普通用户后，这里会显示其功能开放状态。</p>;
  }

  const states = new Map(entries.map((entry) => [entry.featureKey, entry.entryState]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold text-slate-100">{selectedUser.username} 的功能开放</h4>
          <p className="mt-1 text-xs leading-5 text-slate-400">关闭后保留锁定入口；点击只显示“正在测试，等待开放”。</p>
        </div>
        <span className="rounded-full border border-cyan-100/16 bg-cyan-200/8 px-2.5 py-1 text-xs font-semibold text-cyan-100">普通用户</span>
      </div>

      {message && <div className="rounded-lg border border-white/10 bg-white/[0.045] p-3 text-sm text-slate-200">{message}</div>}

      <div className="space-y-2">
        {WORKSPACE_FEATURES.map((feature) => {
          const isOpen = states.get(feature.id) !== "waiting";
          const busy = busyFeatureKey === feature.id;
          return (
            <div key={feature.id} className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-100">{feature.title}</p>
                <p className="mt-1 truncate text-xs text-slate-400">{feature.desc}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={`text-xs font-semibold ${isOpen ? "text-emerald-100" : "text-amber-100"}`}>
                  {isOpen ? "允许进入" : "等待开放"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOpen}
                  aria-label={`${feature.title}${isOpen ? "允许进入" : "等待开放"}`}
                  title={isOpen ? `关闭${feature.title}` : `开放${feature.title}`}
                  disabled={busy}
                  onClick={() => onUpdate(feature.id, isOpen ? "waiting" : "open")}
                  className={`relative h-6 w-11 rounded-full border transition disabled:cursor-wait disabled:opacity-55 ${
                    isOpen
                      ? "border-cyan-100/30 bg-cyan-200/28"
                      : "border-white/14 bg-black/28"
                  }`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${isOpen ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== 品牌设置组件 ====================

// 水印位置选项
type ModelApiCallRow = {
  id: string;
  userId: string;
  username: string;
  accountId: string;
  callType: "llm" | "image" | "video";
  channelName: string | null;
  model: string | null;
  source: string;
  status: "success" | "error";
  remoteTaskId: string | null;
  durationMs: number;
  totalTokens: number | null;
  errorCode: string | null;
  createdAt: string | Date | null;
};

function formatModelApiCallTime(value: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function ModelApiCallPanel({ selectedUserId, normalUsers }: { selectedUserId: string; normalUsers: AdminUserRow[] }) {
  const [scope, setScope] = useState<"current" | "all">("current");
  const [callType, setCallType] = useState<"" | "llm" | "image" | "video">("");
  const [status, setStatus] = useState<"" | "success" | "error">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [logs, setLogs] = useState<ModelApiCallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (scope === "current" && !selectedUserId) {
      setLogs([]);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ limit: "50" });
      if (scope === "current" && selectedUserId) params.set("userId", selectedUserId);
      if (callType) params.set("type", callType);
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      try {
        const response = await fetch(`/api/admin/model-api-calls?${params.toString()}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "读取 API 调用记录失败");
        if (!cancelled) setLogs(data.logs ?? []);
      } catch (requestError) {
        if (!cancelled) {
          setLogs([]);
          setError(requestError instanceof Error ? requestError.message : "读取 API 调用记录失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [callType, from, refreshVersion, scope, selectedUserId, status, to]);

  const filteredLogs = logs.filter((log) => {
    const needle = modelFilter.trim().toLowerCase();
    return !needle || [log.channelName, log.model, log.source].some((value) => value?.toLowerCase().includes(needle));
  });
  const selectedUser = normalUsers.find((user) => user.id === selectedUserId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 p-1">
          <Button type="button" size="sm" variant={scope === "current" ? "default" : "ghost"} disabled={!selectedUserId} onClick={() => setScope("current")}>当前用户{selectedUser ? `：${selectedUser.username}` : ""}</Button>
          <Button type="button" size="sm" variant={scope === "all" ? "default" : "ghost"} onClick={() => setScope("all")}>全部用户</Button>
        </div>
        <Button type="button" variant="outline" size="icon" title="刷新调用记录" aria-label="刷新调用记录" disabled={loading} onClick={() => setRefreshVersion((value) => value + 1)}><LuRefreshCw className={loading ? "animate-spin" : ""} /></Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <select value={callType} onChange={(event) => setCallType(event.target.value as typeof callType)} className="h-9 rounded-md border border-white/10 bg-black/20 px-2 text-sm text-slate-100"><option value="">全部类型</option><option value="llm">LLM</option><option value="image">生图</option><option value="video">生视频</option></select>
        <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-9 rounded-md border border-white/10 bg-black/20 px-2 text-sm text-slate-100"><option value="">全部状态</option><option value="success">成功</option><option value="error">失败</option></select>
        <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="开始日期" />
        <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="结束日期" />
        <Input value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} placeholder="筛选通道、模型或来源" aria-label="筛选通道、模型或来源" />
      </div>
      {error && <div className="rounded-md border border-red-300/20 bg-red-300/10 p-3 text-sm text-red-100">{error}</div>}
      <div className="overflow-x-auto rounded-md border border-white/10"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-white/[0.045] text-slate-300"><tr><th className="px-3 py-2">时间</th><th className="px-3 py-2">用户</th><th className="px-3 py-2">类型</th><th className="px-3 py-2">通道 / 模型</th><th className="px-3 py-2">来源</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">耗时</th><th className="px-3 py-2">任务 / 用量</th></tr></thead><tbody>
        {filteredLogs.map((log) => <tr key={log.id} className="border-t border-white/10 text-slate-200"><td className="whitespace-nowrap px-3 py-2 text-slate-400">{formatModelApiCallTime(log.createdAt)}</td><td className="px-3 py-2"><div>{log.username}</div><div className="font-mono text-[11px] text-slate-500">{log.accountId}</div></td><td className="px-3 py-2 uppercase">{log.callType}</td><td className="px-3 py-2"><div>{log.channelName || "-"}</div><div className="font-mono text-[11px] text-slate-400">{log.model || "-"}</div></td><td className="px-3 py-2 font-mono text-[11px] text-slate-400">{log.source}</td><td className="px-3 py-2"><span className={log.status === "success" ? "text-emerald-200" : "text-red-200"}>{log.status === "success" ? "成功" : "失败"}</span>{log.errorCode && <div className="mt-1 text-[11px] text-red-200/75">{log.errorCode}</div>}</td><td className="whitespace-nowrap px-3 py-2">{Math.max(0, log.durationMs || 0)} ms</td><td className="px-3 py-2 font-mono text-[11px] text-slate-400"><div className="max-w-48 truncate">{log.remoteTaskId || "-"}</div>{log.totalTokens !== null && log.totalTokens !== undefined && <div>tokens {log.totalTokens}</div>}</td></tr>)}
        {!loading && filteredLogs.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">暂无符合条件的调用记录</td></tr>}
        {loading && <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">正在读取调用记录</td></tr>}
      </tbody></table></div>
    </div>
  );
}

const WATERMARK_POSITIONS = [
  { value: "top-left" as const, label: "左上" },
  { value: "top-right" as const, label: "右上" },
  { value: "bottom-left" as const, label: "左下" },
  { value: "bottom-right" as const, label: "右下" },
] as const;

function BrandSettings() {
  const { brand, updateBrand, updateWatermark } = useBrandStore();

  return (
    <div className="space-y-6">
      {/* 店铺基本信息 */}
      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </div>
            <h3 className="font-semibold text-sm">店铺信息</h3>
          </div>

          <div className="grid gap-4">
            {/* 店铺名称 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">店铺名称</Label>
              <Input
                value={brand.name}
                onChange={(e) => updateBrand({ name: e.target.value })}
                placeholder="输入品牌或店铺名称"
                className="text-sm"
              />
            </div>

            {/* Logo 上传区 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Logo</Label>
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/30 overflow-hidden">
                  {brand.logoUrl ? (
                    <img
                      src={brand.logoUrl}
                      alt="品牌 Logo"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          // 将选择的图片转为 Data URL 存储
                          const reader = new FileReader();
                          reader.onload = (ev) => {
                            updateBrand({ logoUrl: ev.target?.result as string });
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
                      <LuUpload className="w-3 h-3" />
                      上传 Logo
                    </span>
                  </label>
                  {brand.logoUrl && (
                    <button
                      onClick={() => updateBrand({ logoUrl: undefined })}
                      className="text-xs text-destructive hover:underline text-left"
                    >
                      移除
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 品牌色设置 */}
      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-500 to-rose-600 text-white">
              <LuPalette className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-sm">品牌色</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* 主色 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">主色</Label>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input
                    type="color"
                    value={brand.primaryColor}
                    onChange={(e) => updateBrand({ primaryColor: e.target.value })}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div
                    className="h-9 w-9 rounded-lg border border-border shadow-sm"
                    style={{ backgroundColor: brand.primaryColor }}
                  />
                </div>
                <Input
                  value={brand.primaryColor}
                  onChange={(e) => updateBrand({ primaryColor: e.target.value })}
                  className="font-mono text-xs uppercase flex-1"
                  maxLength={7}
                />
              </div>
            </div>

            {/* 辅色 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">辅色</Label>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input
                    type="color"
                    value={brand.secondaryColor}
                    onChange={(e) => updateBrand({ secondaryColor: e.target.value })}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div
                    className="h-9 w-9 rounded-lg border border-border shadow-sm"
                    style={{ backgroundColor: brand.secondaryColor }}
                  />
                </div>
                <Input
                  value={brand.secondaryColor}
                  onChange={(e) => updateBrand({ secondaryColor: e.target.value })}
                  className="font-mono text-xs uppercase flex-1"
                  maxLength={7}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 水印设置 */}
      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <h3 className="font-semibold text-sm">水印设置</h3>
            </div>
            <Toggle
              checked={brand.watermark.enabled}
              onChange={(enabled) => updateWatermark({ enabled })}
            />
          </div>

          {brand.watermark.enabled && (
            <div className="space-y-4 pt-2">
              {/* 水印位置 */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">水印位置</Label>
                <div className="grid grid-cols-4 gap-2">
                  {WATERMARK_POSITIONS.map((pos) => (
                    <button
                      key={pos.value}
                      onClick={() => updateWatermark({ position: pos.value })}
                      className={`h-9 rounded-lg border text-xs font-medium transition-colors ${
                        brand.watermark.position === pos.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background hover:bg-accent text-muted-foreground"
                      }`}
                    >
                      {pos.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 透明度 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">透明度</Label>
                  <span className="text-xs text-muted-foreground font-mono">
                    {Math.round(brand.watermark.opacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="5"
                  value={Math.round(brand.watermark.opacity * 100)}
                  onChange={(e) =>
                    updateWatermark({ opacity: Number(e.target.value) / 100 })
                  }
                  className="w-full h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>10%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 片尾设置 */}
      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </div>
              <h3 className="font-semibold text-sm">片尾设置</h3>
            </div>
            <Toggle
              checked={brand.outroEnabled}
              onChange={(enabled) => updateBrand({ outroEnabled: enabled })}
            />
          </div>

          {brand.outroEnabled && (
            <div className="space-y-1.5 pt-2">
              <Label className="text-xs text-muted-foreground">片尾文字</Label>
              <Textarea
                value={brand.outroText ?? ""}
                onChange={(e) => updateBrand({ outroText: e.target.value })}
                placeholder="如：关注我们获取更多好物推荐"
                rows={2}
                className="text-sm resize-none"
              />
              <p className="text-[11px] text-muted-foreground/60">
                片尾文字会叠加在品牌色背景上展示
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
