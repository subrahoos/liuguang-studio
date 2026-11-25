"use client";

import { useCallback, useEffect, useState } from "react";
import { LuChevronDown, LuCopy, LuFolderOpen, LuRefreshCw } from "react-icons/lu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type ArchiveResponse = {
  version?: {
    id: string;
    name: string;
    versionNumber: number;
  };
  paths: {
    root: string;
    versionDir: string;
    assetsDir: string;
    videosDir: string;
    compositionsDir: string;
  };
  synced?: {
    assets: number;
    videos: number;
    compositions: number;
  };
};

type Props = {
  projectId: string;
  versionId?: string | null;
  compact?: boolean;
};

function PathRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copyPath() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={copyPath}>
          <LuCopy className="mr-1 h-3.5 w-3.5" />
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <code className="block break-all text-xs text-foreground">{value}</code>
    </div>
  );
}

export function ProjectLocalArchive({ projectId, versionId, compact = false }: Props) {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
      const response = await fetch(`/api/project/${projectId}/local-archive${query}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "读取本地版本位置失败");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取本地版本位置失败");
    } finally {
      setIsLoading(false);
    }
  }, [projectId, versionId]);

  useEffect(() => {
    if (projectId) void load();
  }, [projectId, versionId, load]);

  const fileCount = data?.synced
    ? data.synced.assets + data.synced.videos + data.synced.compositions
    : 0;

  return (
    <Card className="glass-card mb-4 border-primary/20">
      <CardContent className={compact ? "space-y-3 p-4" : "space-y-4 p-5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <LuFolderOpen className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">本地版本位置</h3>
              {data?.version && (
                <Badge variant="secondary" className="text-[10px]">
                  {data.version.name}
                </Badge>
              )}
              {data?.synced && (
                <Badge variant="secondary" className="text-[10px]">
                  可用 {fileCount} 个文件
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              生成结果保存在 本机数据目录中的 projects 的项目版本目录中，网页预览读取同一份文件。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
              <LuChevronDown className={`mr-1 h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
              {expanded ? "收起" : "展开"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={load} disabled={isLoading}>
              <LuRefreshCw className={`mr-1 h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
        </div>

        {!expanded ? null : error ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</p>
        ) : !data ? (
          <p className="text-xs text-muted-foreground">正在读取本地路径...</p>
        ) : (
          <div className={compact ? "grid gap-2" : "grid gap-3 md:grid-cols-2"}>
            <PathRow label="项目根目录" value={data.paths.root} />
            <PathRow label="当前版本目录" value={data.paths.versionDir} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
