"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LuCopy, LuFilm, LuFileText, LuImage, LuPlus, LuRefreshCw, LuSettings, LuStar, LuTrash2 } from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LumaConfirmDialog, LumaPromptDialog } from "@/components/ui/luma-action-dialog";

export type ProjectVersionItem = {
  id: string;
  name: string;
  versionNumber: number;
  versionType: "normal" | "clone";
  status: string;
  isDefault?: boolean | null;
};

type Props = {
  projectId: string;
  compact?: boolean;
  onRegenerateScript?: () => void;
  regenerateScriptDisabled?: boolean;
  onRegenerateAssets?: () => void;
  regenerateAssetsDisabled?: boolean;
  onRegenerateVideo?: () => void;
  regenerateVideoDisabled?: boolean;
};

const versionTypeLabel = {
  normal: "普通项目",
  clone: "爆款复刻",
} as const;

const modeLabel = {
  blank: "新建空白版本",
  copy_full: "完整复制当前版本",
} as const;

const statusLabel: Record<string, string> = {
  draft: "未开始",
  scripting: "脚本/规划",
  assets: "素材",
  video: "视频",
  composing: "合成中",
  done: "已完成",
};

function typeFromValue(value: string): "normal" | "clone" {
  return value === "clone" ? "clone" : "normal";
}

function modeFromValue(value: string): "blank" | "copy_full" {
  return value === "copy_full" ? "copy_full" : "blank";
}

function labelStatus(status?: string) {
  if (!status) return "未开始";
  return statusLabel[status] || status;
}

export function ProjectVersionBar({
  projectId,
  compact = false,
  onRegenerateScript,
  regenerateScriptDisabled = false,
  onRegenerateAssets,
  regenerateAssetsDisabled = false,
  onRegenerateVideo,
  regenerateVideoDisabled = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlVersionId = searchParams.get("versionId");
  const [versions, setVersions] = useState<ProjectVersionItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<"normal" | "clone">("clone");
  const [newMode, setNewMode] = useState<"blank" | "copy_full">("blank");
  const [newName, setNewName] = useState("");
  const [copySourceVersionId, setCopySourceVersionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [renameTarget, setRenameTarget] = useState<ProjectVersionItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectVersionItem | null>(null);

  const currentVersion = useMemo(
    () => versions.find((item) => item.id === urlVersionId) ?? versions.find((item) => item.isDefault) ?? versions[0] ?? null,
    [urlVersionId, versions]
  );

  const copySourceVersion = useMemo(
    () => versions.find((item) => item.id === copySourceVersionId) ?? currentVersion,
    [copySourceVersionId, currentVersion, versions]
  );

  const navigateTo = useCallback((path: string, versionId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("versionId", versionId);
    router.push(`${path}?${params.toString()}`);
  }, [router, searchParams]);

  const navigateVersion = useCallback((versionId: string) => {
    navigateTo(pathname, versionId);
  }, [navigateTo, pathname]);

  const navigateStage = useCallback((stage: "script" | "assets" | "video" | "export") => {
    if (!currentVersion) return;
    navigateTo(`/project/${projectId}/${stage}`, currentVersion.id);
  }, [currentVersion, navigateTo, projectId]);

  const openCreatePanel = useCallback((mode: "blank" | "copy_full", source?: ProjectVersionItem) => {
    const baseVersion = source ?? currentVersion;
    setError("");
    setCreating(true);
    setNewMode(mode);
    setNewType(baseVersion?.versionType ?? "clone");
    setCopySourceVersionId(mode === "copy_full" ? baseVersion?.id ?? null : null);
  }, [currentVersion]);

  const handleScriptAction = useCallback(() => {
    if (pathname.endsWith("/script") && onRegenerateScript) {
      onRegenerateScript();
      return;
    }
    navigateStage("script");
  }, [navigateStage, onRegenerateScript, pathname]);

  const handleAssetsAction = useCallback(() => {
    if (pathname.endsWith("/assets") && onRegenerateAssets) {
      onRegenerateAssets();
      return;
    }
    navigateStage("assets");
  }, [navigateStage, onRegenerateAssets, pathname]);

  const handleVideoAction = useCallback(() => {
    if (pathname.endsWith("/video") && onRegenerateVideo) {
      onRegenerateVideo();
      return;
    }
    navigateStage("video");
  }, [navigateStage, onRegenerateVideo, pathname]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/project/${projectId}/versions`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "读取版本失败");

      const nextVersions = Array.isArray(json.versions) ? json.versions as ProjectVersionItem[] : [];
      setVersions(nextVersions);

      if (!urlVersionId && nextVersions.length > 0) {
        const target = nextVersions.find((item) => item.isDefault) ?? nextVersions[0];
        navigateVersion(target.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取版本失败");
    } finally {
      setIsLoading(false);
    }
  }, [navigateVersion, projectId, urlVersionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createVersion() {
    const sourceVersion = newMode === "copy_full" ? copySourceVersion : null;
    if (newMode === "copy_full" && !sourceVersion) {
      setError("完整复制需要先选择一个来源版本。");
      return;
    }

    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/project/${projectId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionType: newMode === "copy_full" ? sourceVersion?.versionType : newType,
          mode: newMode,
          sourceVersionId: sourceVersion?.id,
          name: newName.trim() || undefined,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "创建版本失败");

      setCreating(false);
      setNewName("");
      setCopySourceVersionId(null);
      await load();

      if (json.version?.id) {
        const nextPath = newMode === "copy_full" ? pathname : `/project/${projectId}/script`;
        navigateTo(nextPath, json.version.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建版本失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function renameVersion(name: string) {
    if (!renameTarget || name.trim() === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/project/${projectId}/versions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: renameTarget.id, name: name.trim() }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "重命名失败");
      await load();
      setRenameTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function setDefault(version: ProjectVersionItem) {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/project/${projectId}/versions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: version.id, action: "set_default" }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "设置默认失败");
      await load();
      navigateVersion(version.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置默认失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function deleteVersion() {
    if (!deleteTarget) return;
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/project/${projectId}/versions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: deleteTarget.id }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "删除版本失败");
      await load();

      const remaining = versions.filter((item) => item.id !== deleteTarget.id);
      if (urlVersionId === deleteTarget.id && remaining.length > 0) {
        navigateVersion(remaining[0].id);
      }
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除版本失败");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="glass-card mb-4 border-primary/20">
      <CardContent className={compact ? "space-y-3 p-4" : "space-y-4 p-5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">当前版本</span>
            <select
              className="h-9 rounded-xl border border-border bg-background px-3 text-sm"
              value={currentVersion?.id || ""}
              onChange={(event) => navigateVersion(event.target.value)}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.name} / {versionTypeLabel[version.versionType]}
                </option>
              ))}
            </select>
            {currentVersion && (
              <>
                <Badge variant="secondary">{versionTypeLabel[currentVersion.versionType]}</Badge>
                {currentVersion.isDefault && <Badge>默认</Badge>}
                <Badge variant="outline">{labelStatus(currentVersion.status)}</Badge>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => openCreatePanel("blank")}>
              <LuPlus className="mr-1 h-3.5 w-3.5" />
              新建空白版本
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => openCreatePanel("copy_full")}>
              <LuCopy className="mr-1 h-3.5 w-3.5" />
              完整复制当前版本
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
              <LuSettings className="mr-1 h-3.5 w-3.5" />
              管理版本
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={load} disabled={isLoading}>
              <LuRefreshCw className={`mr-1 h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
        </div>

        {currentVersion && (
          <div className="rounded-2xl border border-primary/15 bg-primary/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                当前操作只影响「{currentVersion.name}」。想做一套新的内容，可以新建空白版本从脚本重新开始，也可以完整复制当前版本后在脚本、素材、视频任一阶段单独重新生成；旧版本会保留。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleScriptAction}
                  disabled={regenerateScriptDisabled}
                >
                  <LuFileText className="mr-1 h-3.5 w-3.5" />
                  {pathname.endsWith("/script") ? "立即重写脚本" : "去脚本页重写"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleAssetsAction}
                  disabled={pathname.endsWith("/assets") && regenerateAssetsDisabled}
                >
                  <LuImage className="mr-1 h-3.5 w-3.5" />
                  {pathname.endsWith("/assets") ? "立即重生成素材" : "去素材页重生成"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleVideoAction}
                  disabled={pathname.endsWith("/video") && regenerateVideoDisabled}
                >
                  <LuFilm className="mr-1 h-3.5 w-3.5" />
                  {pathname.endsWith("/video") ? "立即重生成视频" : "去视频页重生成"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</p>}

        {creating && (
          <div className="grid gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4 md:grid-cols-4">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">创建方式</span>
              <select
                className="w-full rounded-xl border border-border bg-background px-3 py-2"
                value={newMode}
                onChange={(event) => {
                  const mode = modeFromValue(event.target.value);
                  setNewMode(mode);
                  if (mode === "copy_full") {
                    const source = copySourceVersion ?? currentVersion;
                    setCopySourceVersionId(source?.id ?? null);
                    if (source) setNewType(source.versionType);
                  } else {
                    setCopySourceVersionId(null);
                  }
                }}
              >
                <option value="blank">{modeLabel.blank}</option>
                <option value="copy_full">{modeLabel.copy_full}</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{newMode === "copy_full" ? "来源版本" : "版本类型"}</span>
              {newMode === "copy_full" ? (
                <select
                  className="w-full rounded-xl border border-border bg-background px-3 py-2"
                  value={copySourceVersion?.id || ""}
                  onChange={(event) => {
                    const source = versions.find((item) => item.id === event.target.value) ?? null;
                    setCopySourceVersionId(source?.id ?? null);
                    if (source) setNewType(source.versionType);
                  }}
                >
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.name} / {versionTypeLabel[version.versionType]}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="w-full rounded-xl border border-border bg-background px-3 py-2"
                  value={newType}
                  onChange={(event) => setNewType(typeFromValue(event.target.value))}
                >
                  <option value="normal">普通项目</option>
                  <option value="clone">爆款复刻</option>
                </select>
              )}
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">版本名称（可选）</span>
              <input
                className="w-full rounded-xl border border-border bg-background px-3 py-2"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="默认自动命名"
              />
            </label>
            <div className="flex items-end gap-2">
              <Button type="button" className="flex-1" onClick={createVersion} disabled={isLoading}>
                {isLoading ? "创建中..." : "创建"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setCreating(false)} disabled={isLoading}>
                取消
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground md:col-span-4">
              空白版本不会继承旧脚本、旧素材和旧视频，会直接进入脚本页重新生成。完整复制当前版本会保留脚本、素材、视频和本地文件，之后你可以在脚本、素材、视频任一阶段单独点击重新生成。
            </p>
          </div>
        )}

        {expanded && (
          <div className="grid gap-2">
            {versions.map((version) => (
              <div key={version.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/10 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{version.name}</span>
                    <Badge variant="secondary">{versionTypeLabel[version.versionType]}</Badge>
                    {version.isDefault && <Badge>默认</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    版本 {version.versionNumber} / 状态：{labelStatus(version.status)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => navigateVersion(version.id)}>切换</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setRenameTarget(version)}>重命名</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setDefault(version)}>
                    <LuStar className="mr-1 h-3.5 w-3.5" />
                    设为默认
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => {
                    openCreatePanel("copy_full", version);
                    navigateVersion(version.id);
                  }}>
                    <LuCopy className="mr-1 h-3.5 w-3.5" />
                    复制此版本
                  </Button>
                  <Button type="button" variant="destructive" size="sm" onClick={() => setDeleteTarget(version)}>
                    <LuTrash2 className="mr-1 h-3.5 w-3.5" />
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <LumaPromptDialog
        key={renameTarget?.id || "rename-version"}
        open={Boolean(renameTarget)}
        onOpenChange={(open) => { if (!open && !isLoading) setRenameTarget(null); }}
        title="重命名项目版本"
        description="名称只用于当前项目内识别，不会改变版本内容。"
        label="版本名称"
        defaultValue={renameTarget?.name || ""}
        placeholder="输入版本名称"
        confirmLabel="保存名称"
        onConfirm={(value) => void renameVersion(value)}
        pending={isLoading}
      />
      <LumaConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open && !isLoading) setDeleteTarget(null); }}
        title="删除项目版本"
        description={<>确定删除“{deleteTarget?.name || "当前版本"}”吗？这会同时删除这个版本的本地文件夹，此操作不可恢复。</>}
        confirmLabel="确认删除"
        onConfirm={() => void deleteVersion()}
        pending={isLoading}
      />
    </Card>
  );
}
