"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LuArrowLeft, LuDownload, LuFilm, LuHouse, LuPlay, LuPlus, LuVideo } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProjectLocalArchive } from "@/components/project-local-archive";
import { ProjectVersionBar } from "@/components/project-version-bar";
import type { Shot } from "@/lib/db/schema";

interface AssetItem {
  shotId: number;
  segmentIndex?: number | null;
  shotType: Shot["type"];
  duration: number;
  description?: string;
  voiceover?: string;
  status: "pending" | "generating" | "done" | "failed";
  model: string | null;
}

interface VideoClipItem {
  id: string;
  projectId: string;
  shotId: number;
  assetId: string | null;
  filePath: string | null;
  duration: number | null;
  provider: string | null;
  model: string | null;
  transitionType: string | null;
  status: "pending" | "generating" | "done" | "failed";
}

interface CompositionItem {
  id: string;
  projectId: string;
  outputPath: string | null;
  filePath: string | null;
  resolution: "720p" | "1080p" | null;
  aspectRatio: "9:16" | "16:9" | "1:1" | null;
  duration: number | null;
  status: "pending" | "composing" | "done" | "failed";
}

interface AssetsResponse {
  project: {
    id: string;
    name: string;
    videoAspectRatio?: "9:16" | "16:9" | "1:1" | null;
    videoResolution?: "720p" | "1080p" | null;
  };
  script: {
    id: string;
    title: string | null;
    totalDuration: number | null;
    styleType: string;
  } | null;
  assets: AssetItem[];
}

const CLONE_FULL_VIDEO_SHOT_ID = 9999;
const CLONE_SEGMENT_SHOT_BASE = 9000;

function isCloneSegmentShot(shotId: number) {
  return shotId > CLONE_SEGMENT_SHOT_BASE && shotId < CLONE_FULL_VIDEO_SHOT_ID;
}

function secondsLabel(duration: number | null | undefined) {
  if (!duration) return "--";
  return `${Math.round(duration / 1000)} 秒`;
}

export default function ExportPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const versionId = searchParams.get("versionId");
  const [data, setData] = useState<AssetsResponse | null>(null);
  const [videoClips, setVideoClips] = useState<VideoClipItem[]>([]);
  const [compositions, setCompositions] = useState<CompositionItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedCompositionId, setSelectedCompositionId] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load(silent = false) {
      if (!silent) {
        setIsLoading(true);
        setError(null);
      } else {
        setIsRefreshing(true);
      }

      try {
        const [assetsResponse, clipsResponse, compositionsResponse] = await Promise.all([
          fetch(`/api/project/${id}/assets${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`, { cache: "no-store" }),
          fetch(`/api/project/${id}/video-clips${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`, { cache: "no-store" }),
          fetch(`/api/project/${id}/compositions${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`, { cache: "no-store" }),
        ]);

        const assetsJson = await assetsResponse.json();
        const clipsJson = await clipsResponse.json();
        const compositionsJson = await compositionsResponse.json();

        if (!assetsResponse.ok) throw new Error(assetsJson.error || "读取导出信息失败");
        if (!clipsResponse.ok) throw new Error(clipsJson.error || "读取视频记录失败");
        if (!compositionsResponse.ok) throw new Error(compositionsJson.error || "读取成片失败");

        if (!alive) return;

        const clips = (clipsJson.clips ?? []) as VideoClipItem[];
        const compositionRows = (compositionsJson.compositions ?? []) as CompositionItem[];
        setData(assetsJson);
        setVideoClips(clips);
        setCompositions(compositionRows);
        setSelectedClipId((current) => current ?? clips[0]?.id ?? null);
        setSelectedCompositionId((current) => current ?? compositionRows[compositionRows.length - 1]?.id ?? null);
      } catch (err) {
        if (alive && !silent) setError(err instanceof Error ? err.message : "读取导出信息失败");
      } finally {
        if (!alive) return;
        if (!silent) setIsLoading(false);
        setIsRefreshing(false);
      }
    }

    if (id) {
      void load();
      const timer = window.setInterval(() => {
        void load(true);
      }, 5000);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }

    return () => {
      alive = false;
    };
  }, [id, versionId]);

  const assets = data?.assets ?? [];
  const readyCount = assets.filter((asset) => asset.status === "done").length;
  const totalDuration = data?.script?.totalDuration ?? assets.reduce((sum, asset) => sum + asset.duration, 0);
  const imageModels = Array.from(new Set(assets.map((asset) => asset.model).filter(Boolean)));
  const cloneSegmentClips = videoClips.filter((clip) => isCloneSegmentShot(clip.shotId));
  const singleShotClips = videoClips.filter((clip) => clip.shotId !== CLONE_FULL_VIDEO_SHOT_ID && !isCloneSegmentShot(clip.shotId));
  const cloneFullVideoClip = videoClips.find((clip) => clip.shotId === CLONE_FULL_VIDEO_SHOT_ID) ?? null;
  const previewClips = useMemo(
    () => [...cloneSegmentClips, ...singleShotClips].sort((a, b) => a.shotId - b.shotId),
    [cloneSegmentClips, singleShotClips]
  );
  const selectedClip = previewClips.find((clip) => clip.id === selectedClipId) ?? previewClips[0] ?? cloneFullVideoClip ?? null;
  const selectedComposition = compositions.find((item) => item.id === selectedCompositionId) ?? compositions[compositions.length - 1] ?? null;
  const selectedAsset = selectedClip ? assets.find((asset) => asset.shotId === selectedClip.shotId) : null;
  const completedClipCount = previewClips.filter((clip) => clip.status === "done" && clip.filePath).length;
  const completedSegmentCount = cloneSegmentClips.filter((clip) => clip.status === "done" && clip.filePath).length;
  const hasCloneFullVideo = Boolean(cloneFullVideoClip?.status === "done" && cloneFullVideoClip.filePath);
  const completedCompositionCount = compositions.filter((item) => item.status === "done" && item.filePath).length;
  const expectedCloneSegmentCount = cloneSegmentClips.length > 0
    ? Math.max(
        cloneSegmentClips.length,
        ...assets.map((asset) => Number.isFinite(asset.segmentIndex ?? NaN)
          ? Math.max(1, Math.round(asset.segmentIndex || 1))
          : Math.max(1, Math.floor((asset.shotId - 1) / 7) + 1)
        )
      )
    : 0;
  const exportChecks = [
    {
      label: "已保存视频片段",
      ok: completedClipCount > 0,
      detail: completedClipCount > 0 ? `${completedClipCount} 个片段可用于合成` : "还没有可合成的视频片段",
    },
    {
      label: "爆款复刻分段完整性",
      ok: expectedCloneSegmentCount === 0 || completedSegmentCount >= expectedCloneSegmentCount,
      detail: expectedCloneSegmentCount === 0
        ? "当前不是分段爆款复刻合成"
        : `${completedSegmentCount}/${expectedCloneSegmentCount} 段已保存`,
    },
    {
      label: "本地预览路径",
      ok: previewClips.every((clip) => !clip.filePath || clip.filePath.startsWith(`/api/project/${id}/video-clips/file/`)),
      detail: "合成只读取已下载到本地版本目录的视频文件",
    },
    {
      label: "时长记录",
      ok: previewClips.every((clip) => clip.duration && clip.duration > 0),
      detail: previewClips.every((clip) => clip.duration && clip.duration > 0) ? "所有片段都有时长记录" : "存在片段缺少时长，合成会使用兜底时长",
    },
    {
      label: "导出画幅/分辨率",
      ok: Boolean(data?.project.videoAspectRatio || data?.project.videoResolution),
      detail: `${data?.project.videoAspectRatio ?? "9:16"} · ${data?.project.videoResolution ?? "720p"}`,
    },
  ];
  const canComposeFinalVideo = completedClipCount > 0 && exportChecks.slice(0, 3).every((check) => check.ok);

  async function composeFinalVideo() {
    if (!id || !canComposeFinalVideo || isComposing) return;
    setIsComposing(true);
    setError(null);
    try {
      const response = await fetch(`/api/project/${id}/compositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: versionId || undefined,
          resolution: data?.project.videoResolution ?? "720p",
          aspectRatio: data?.project.videoAspectRatio ?? "9:16",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "合成完整成片失败");
      setCompositions((current) => [...current, result]);
      setSelectedCompositionId(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "合成完整成片失败");
    } finally {
      setIsComposing(false);
    }
  }

  return (
    <div className="min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg brand-gradient">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </div>
              <span className="text-lg font-bold tracking-tight">流光商影</span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm text-muted-foreground">{data?.project.name ?? "导出"}</span>
          </div>

          <div className="flex items-center gap-1">
            <Link href="/">
              <Button variant="outline" size="sm" className="mr-2 h-8">
                <LuHouse className="mr-1.5 h-4 w-4" />
                回首页
              </Button>
            </Link>
            {["脚本", "素材", "视频", "导出"].map((step, i) => (
              <div key={step} className="flex items-center">
                <div className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${i === 3 ? "bg-primary text-primary-foreground" : "text-primary"}`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i === 3 ? "bg-white/20" : "bg-primary/20"}`}>
                    {i < 3 ? "✓" : i + 1}
                  </span>
                  {step}
                </div>
                {i < 3 && <div className="mx-1 h-px w-4 bg-border" />}
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <ProjectVersionBar projectId={id} />
        <ProjectLocalArchive projectId={id} versionId={versionId} />

        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <LuFilm className="h-8 w-8 text-primary" />
          </div>
          <h1 className="mb-1 text-2xl font-bold tracking-tight">
            {isLoading ? "正在读取导出状态" : completedCompositionCount > 0 ? "完整成片预览与下载" : completedClipCount > 0 || hasCloneFullVideo ? "视频预览与成片合成" : "等待视频生成"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isRefreshing ? "正在同步最新视频记录..." : "只展示真实生成并保存到本地的文件；没有真实文件前，不提供假预览或假下载。"}
          </p>
        </div>

        <Card className="glass-card mb-6 overflow-hidden">
          <CardContent className="p-0">
            {selectedComposition?.filePath ? (
              <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr]">
                <div className="bg-black">
                  <video key={selectedComposition.filePath} controls playsInline className="mx-auto aspect-[9/16] max-h-[620px] w-full bg-black object-contain" src={selectedComposition.filePath} />
                </div>
                <div className="space-y-4 p-5">
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">完整成片</p>
                    <h3 className="text-lg font-semibold">最终合成视频</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      由 {completedClipCount} 个已保存视频调用本地 FFmpeg 合成工具生成。
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <InfoBox label="分辨率" value={selectedComposition.resolution || "720p"} />
                    <InfoBox label="画幅" value={selectedComposition.aspectRatio || "9:16"} />
                    <InfoBox label="时长" value={secondsLabel(selectedComposition.duration)} />
                    <InfoBox label="状态" value={selectedComposition.status === "done" ? "已完成" : selectedComposition.status} />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <a href={selectedComposition.filePath} target="_blank" rel="noreferrer">
                      <Button variant="outline">
                        <LuPlay className="mr-1.5 h-4 w-4" />
                        新窗口预览成片
                      </Button>
                    </a>
                    <a href={`${selectedComposition.filePath}?download=1`}>
                      <Button className="brand-gradient text-white">
                        <LuDownload className="mr-1.5 h-4 w-4" />
                        下载完整成片
                      </Button>
                    </a>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[260px] items-center justify-between gap-5 p-6">
                <div>
                  <h3 className="text-lg font-semibold">完整成片尚未合成</h3>
                  <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                    爆款复刻分段视频或普通单镜头视频确认完成后，点击右侧按钮会调用本地 FFmpeg，把已保存视频按 shotId 顺序拼成完整成品。
                  </p>
                  <div className="mt-4 grid max-w-2xl gap-2 sm:grid-cols-2">
                    {exportChecks.map((check) => (
                      <div key={check.label} className="rounded-lg border border-border/50 bg-background/60 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">{check.label}</span>
                          <Badge variant={check.ok ? "secondary" : "outline"} className="text-[10px]">
                            {check.ok ? "通过" : "待处理"}
                          </Badge>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{check.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <Button className="brand-gradient shrink-0 text-white" disabled={!canComposeFinalVideo || isComposing} onClick={() => void composeFinalVideo()}>
                  {isComposing ? "正在合成成片" : "合成完整成片"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
          <Card className="glass-card overflow-hidden">
            <CardContent className="p-4">
              {hasCloneFullVideo && cloneFullVideoClip?.filePath && (
                <ClipButton
                  clip={cloneFullVideoClip}
                  active={selectedClip?.id === cloneFullVideoClip.id}
                  title="爆款复刻完整视频"
                  subtitle="由完整导演稿直接生成，已保存到本地。"
                  onClick={() => setSelectedClipId(cloneFullVideoClip.id)}
                />
              )}

              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">视频列表</h3>
                <Badge variant="secondary" className="text-xs">{completedClipCount}/{previewClips.length}</Badge>
              </div>

              <div className="space-y-2">
                {cloneSegmentClips.map((clip) => (
                  <ClipButton
                    key={clip.id}
                    clip={clip}
                    active={selectedClip?.id === clip.id}
                    title={`爆款分段任务 ${clip.shotId - CLONE_SEGMENT_SHOT_BASE}`}
                    subtitle={`Grok/Omni 分段视频，${secondsLabel(clip.duration)}，可验收后继续合成。`}
                    onClick={() => setSelectedClipId(clip.id)}
                  />
                ))}

                {singleShotClips.map((clip) => {
                  const asset = assets.find((item) => item.shotId === clip.shotId);
                  return (
                    <ClipButton
                      key={clip.id}
                      clip={clip}
                      active={selectedClip?.id === clip.id}
                      title={`Shot ${String(clip.shotId).padStart(2, "0")}`}
                      subtitle={asset?.description || asset?.voiceover || "单镜头视频"}
                      onClick={() => setSelectedClipId(clip.id)}
                    />
                  );
                })}

                {previewClips.length === 0 && !hasCloneFullVideo && (
                  <div className="rounded-lg border border-dashed border-border/60 p-5 text-center">
                    <LuVideo className="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" />
                    <p className="text-xs text-muted-foreground">
                      还没有真实生成并保存的视频。视频页保存完成后，这里会自动同步出现。
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="glass-card overflow-hidden">
            <CardContent className="p-0">
              {selectedClip?.filePath ? (
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,360px)_1fr]">
                  <div className="bg-black">
                    <video key={selectedClip.filePath} controls playsInline className="mx-auto aspect-[9/16] max-h-[620px] w-full bg-black object-contain" src={selectedClip.filePath} />
                  </div>
                  <div className="space-y-4 p-5">
                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">当前预览</p>
                      <h3 className="text-lg font-semibold">
                        {isCloneSegmentShot(selectedClip.shotId) ? `爆款分段任务 ${selectedClip.shotId - CLONE_SEGMENT_SHOT_BASE}` : `Shot ${String(selectedClip.shotId).padStart(2, "0")}`}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {selectedAsset?.description || selectedAsset?.voiceover || "已保存的视频文件。"}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <InfoBox label="模型" value={selectedClip.model || "未记录"} />
                      <InfoBox label="时长" value={secondsLabel(selectedClip.duration)} />
                      <InfoBox label="提供方" value={selectedClip.provider || "openai-seedance"} />
                      <InfoBox label="拼接方式" value={selectedClip.transitionType || "--"} />
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <a href={selectedClip.filePath} target="_blank" rel="noreferrer">
                        <Button variant="outline">
                          <LuPlay className="mr-1.5 h-4 w-4" />
                          新窗口预览
                        </Button>
                      </a>
                      <a href={`${selectedClip.filePath}?download=1`}>
                        <Button className="brand-gradient text-white">
                          <LuDownload className="mr-1.5 h-4 w-4" />
                          下载本视频
                        </Button>
                      </a>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[420px] items-center justify-center bg-gradient-to-b from-muted/40 via-muted/20 to-muted/40 p-8 text-center">
                  <div>
                    <LuFilm className="mx-auto mb-3 h-12 w-12 text-muted-foreground/30" />
                    <p className="max-w-[300px] text-xs text-muted-foreground/70">
                      暂无可预览的视频。后台完成并保存到本地后，本页会自动刷新。
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <h3 className="mb-4 text-sm font-semibold">真实链路状态</h3>
            <div className="grid grid-cols-2 gap-4">
              <InfoBox label="脚本" value={data?.script?.title || (data?.script ? "已读取脚本" : "爆款复刻完整稿")} />
              <InfoBox label="素材" value={`${readyCount}/${assets.length} 个已就绪`} />
              <InfoBox label="分段视频" value={`${completedSegmentCount}/${cloneSegmentClips.length || 1} 个已保存`} />
              <InfoBox label="总时长" value={totalDuration ? `${totalDuration} 秒` : "未计算"} />
              <div className="rounded-lg bg-muted/20 p-3">
                <p className="mb-1 text-xs text-muted-foreground">生图模型</p>
                {imageModels.length > 0 ? (
                  imageModels.map((model) => <Badge key={model} variant="secondary" className="mr-1 text-xs">{model}</Badge>)
                ) : (
                  <p className="text-sm">暂无 AI 生图结果</p>
                )}
              </div>
              <InfoBox label="同步状态" value={isRefreshing ? "正在同步" : "自动同步中"} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-center gap-4">
          <Link href={`/project/${id}/video${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`}>
            <Button variant="outline">
              <LuArrowLeft className="mr-1.5 h-4 w-4" />
              返回视频页
            </Button>
          </Link>
          <Link href="/project/new">
            <Button className="brand-gradient text-white">
              <LuPlus className="mr-1.5 h-4 w-4" />
              再做一个
            </Button>
          </Link>
          <Link href="/">
            <Button variant="outline">
              <LuHouse className="mr-1.5 h-4 w-4" />
              返回项目列表
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/20 p-3">
      <p className="mb-0.5 text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function ClipButton({
  clip,
  active,
  title,
  subtitle,
  onClick,
}: {
  clip: VideoClipItem;
  active: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-all ${
        active ? "border-primary bg-primary/10" : "border-border/50 bg-muted/20 hover:border-primary/40"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <Badge variant={clip.status === "done" ? "secondary" : "outline"} className="text-[10px]">
          {clip.status === "done" ? "已保存" : clip.status}
        </Badge>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{subtitle}</p>
    </button>
  );
}
