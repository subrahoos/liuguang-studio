"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Circle, Sparkles, WandSparkles } from "lucide-react";
import {
  BackgroundSettingsPanel,
  useHomeBackgroundSettings,
} from "@/components/luma-home-background";
import { fetchWorkspaceSession } from "@/lib/workspace-auth";

export default function HomePage() {
  const router = useRouter();
  const background = useHomeBackgroundSettings();
  const [isBackgroundPanelOpen, setIsBackgroundPanelOpen] = useState(false);

  async function enterWorkspace() {
    const session = await fetchWorkspaceSession().catch(() => null);
    router.push(session ? "/workspace" : "/login");
  }

  return (
    <div className="luma-home-page min-h-screen bg-transparent text-slate-100">
      <section className="relative min-h-screen overflow-hidden">
        <header className="relative z-20 flex h-20 items-center justify-between px-5 sm:px-6 lg:px-8">
          <Link href="/" className="flex w-[214px] flex-col items-start leading-none">
            <span className="whitespace-nowrap text-[12px] font-medium uppercase tracking-[0.18em] text-cyan-100/70">Luma Commerce Studio</span>
            <span className="mt-1 text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-100 via-white to-violet-300">
              流光商影
            </span>
          </Link>
          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-9 text-sm font-medium text-slate-200/74 md:flex">
            <span className="cursor-default transition hover:text-cyan-200">灵感线索</span>
            <span className="cursor-default transition hover:text-cyan-200">光影工序</span>
            <span className="cursor-default transition hover:text-cyan-200">商影档案</span>
          </nav>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsBackgroundPanelOpen(true)}
              title="首页背景设置"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10"
            >
              <WandSparkles className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={enterWorkspace}
              className="hidden rounded-full border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-cyan-50 backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10 md:inline-flex"
            >
              登入
            </button>
          </div>
        </header>

        <main className="relative z-10 mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl flex-col items-center justify-center px-6 pb-36 text-center">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.34em] text-violet-200/90">Luma Commerce Studio</p>
          <h1 className="text-6xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-cyan-100 via-white to-violet-300 drop-shadow-[0_0_42px_rgba(125,211,252,0.28)] md:text-8xl">
            流光商影
          </h1>
          <h2 className="mt-7 text-3xl font-bold tracking-tight text-slate-100 md:text-5xl">AI 电商视频生产中枢</h2>
          <p className="mt-8 max-w-3xl text-base leading-8 text-slate-200/78 md:text-lg">
            让商品在光影中生成故事，把爆款参考、商品素材与 AI 视频生产汇入一条创作流水线。
          </p>
          <button
            type="button"
            onClick={enterWorkspace}
            className="group mt-14 inline-flex items-center gap-3 rounded-full border border-cyan-100/18 bg-white/[0.055] px-9 py-4 text-lg font-bold text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_50px_rgba(34,211,238,0.12)] backdrop-blur-3xl transition hover:border-cyan-100/45 hover:bg-cyan-200/10 hover:shadow-[0_0_54px_rgba(34,211,238,0.22)]"
          >
            进入工作台
            <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" />
          </button>
        </main>

        <div className="absolute bottom-9 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-white/[0.055] p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.32)] backdrop-blur-3xl">
          <BackgroundPresetButton
            icon={<Sparkles className="h-4 w-4" />}
            active={!background.isDefaultAnimation && background.currentPreset === "galaxy"}
            onClick={() => background.selectPreset("galaxy")}
          >
            银河
          </BackgroundPresetButton>
          <BackgroundPresetButton
            icon={<Circle className="h-4 w-4" />}
            active={!background.isDefaultAnimation && background.currentPreset === "planet"}
            onClick={() => background.selectPreset("planet")}
          >
            星球
          </BackgroundPresetButton>
          <BackgroundPresetButton
            icon={<WandSparkles className="h-4 w-4" />}
            active={!background.isDefaultAnimation && background.currentPreset === "luma"}
            onClick={() => background.selectPreset("luma")}
          >
            流光
          </BackgroundPresetButton>
        </div>
      </section>

      {isBackgroundPanelOpen && (
        <BackgroundSettingsPanel
          settings={background.settings}
          currentPreset={background.currentPreset}
          isDefaultAnimation={background.isDefaultAnimation}
          message={background.message}
          isUploading={background.isUploading}
          fileInputRef={background.fileInputRef}
          onClose={() => setIsBackgroundPanelOpen(false)}
          onPickFile={background.pickFile}
          onFileChange={background.handleFile}
          onSelectPreset={background.selectPreset}
          onUpdate={background.update}
          onUseDefaultAnimation={background.activateDefaultAnimation}
          onSave={background.save}
          onRestore={background.restore}
          onVideoError={background.reportVideoPlaybackError}
        />
      )}
    </div>
  );
}

function BackgroundPresetButton({
  icon,
  active,
  children,
  onClick,
}: {
  icon: ReactNode;
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition ${
        active
          ? "bg-cyan-200/18 text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.22)]"
          : "text-slate-300/72 hover:bg-white/[0.06] hover:text-cyan-100"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{children}</span>
    </button>
  );
}
