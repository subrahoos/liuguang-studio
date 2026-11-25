"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LuArrowLeft, LuGitBranch, LuPlus, LuTrash2 } from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LumaConfirmDialog } from "@/components/ui/luma-action-dialog";

export interface BoardWorkflowListItem {
  id: string;
  name: string;
  description?: string;
  status: string;
  nodes: unknown[];
  updatedAt: string;
}

type BoardWorkflowListPanelProps = {
  embedded?: boolean;
  onBackToWorkspace?: () => void;
  onOpenWorkflow?: (workflowId: string) => void;
};

const statusLabel: Record<string, string> = {
  draft: "草稿",
  evidence: "已抽帧",
  analyzed: "已拆解",
  assets: "已生成资产",
  video: "已生成视频",
  done: "已完成",
};

function isLikelyLegacyMojibake(value?: string) {
  return Boolean(value && /[鐢绘澘宸ヤ綔娴涓婁紶鍙傝€冭棰戞垚璇佹嵁]/.test(value));
}

function displayWorkflowName(workflow: BoardWorkflowListItem) {
  return isLikelyLegacyMojibake(workflow.name) ? "画板工作流" : workflow.name;
}

function displayWorkflowDescription(workflow: BoardWorkflowListItem) {
  if (isLikelyLegacyMojibake(workflow.description)) return "上传参考视频，拆成证据板，再按节点生成图片和视频。";
  return workflow.description || "暂无说明";
}

export function BoardWorkflowListPanel({ embedded = false, onBackToWorkspace, onOpenWorkflow }: BoardWorkflowListPanelProps) {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<BoardWorkflowListItem[]>([]);
  const [name, setName] = useState("画板工作流");
  const [description, setDescription] = useState("上传参考视频，拆成证据板，再按节点生成图片和视频。");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BoardWorkflowListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch("/api/board-workflows", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取画板工作流失败");
      setWorkflows(Array.isArray(data.workflows) ? data.workflows : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取画板工作流失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openWorkflow(id: string) {
    if (embedded && onOpenWorkflow) {
      onOpenWorkflow(id);
      return;
    }
    router.push(`/workspace?module=board&boardId=${encodeURIComponent(id)}`);
  }

  async function createWorkflow() {
    setIsCreating(true);
    setError("");
    try {
      const res = await fetch("/api/board-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建画板工作流失败");
      const workflow = data.workflow as BoardWorkflowListItem;
      setWorkflows((items) => [workflow, ...items.filter((item) => item.id !== workflow.id)]);
      openWorkflow(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建画板工作流失败");
    } finally {
      setIsCreating(false);
    }
  }

  async function deleteWorkflow() {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/board-workflows/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "删除画板工作流失败");
      setWorkflows((items) => items.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除画板工作流失败");
    } finally {
      setIsDeleting(false);
    }
  }

  const shellClass = embedded
    ? "luma-board-list-embedded flex h-full min-h-0 flex-col overflow-hidden text-slate-100"
    : "min-h-screen grid-bg";
  const headerClass = embedded
    ? "border-b border-cyan-100/10 bg-[#061019]/58 backdrop-blur-2xl"
    : "border-b border-border/50 bg-background/80 backdrop-blur-xl";
  const mainClass = embedded
    ? "min-h-0 flex-1 overflow-y-auto px-4 py-4"
    : "mx-auto max-w-6xl px-6 py-10";

  return (
    <div className={shellClass}>
      <header className={headerClass}>
        <div className={embedded ? "flex h-14 items-center justify-between px-4" : "mx-auto flex h-14 max-w-6xl items-center justify-between px-6"}>
          {embedded ? (
            <Button variant="ghost" size="sm" className="order-2" onClick={onBackToWorkspace}>
              <LuArrowLeft className="mr-1.5 h-4 w-4" />
              返回工作台
            </Button>
          ) : (
          <Link href="/workspace?module=board" className="order-2">
              <Button variant="ghost" size="sm">
                <LuArrowLeft className="mr-1.5 h-4 w-4" />
                返回首页
              </Button>
            </Link>
          )}
          <div className="order-1 flex items-center gap-2 text-sm font-semibold">
            <LuGitBranch className="h-4 w-4 text-primary" />
            画板工作流
          </div>
        </div>
      </header>

      <main className={mainClass}>
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-bold">画板工作流</h1>
          <p className={embedded ? "text-slate-300/72" : "text-muted-foreground"}>
            用一张可拖拽的画板组织参考视频、关键帧、人物/商品/场景证据、提示词、图片资产和视频结果。
          </p>
        </div>

        <Card className={embedded ? "glass-card mb-6 overflow-hidden border-cyan-100/12 bg-white/[0.045] text-slate-100" : "glass-card mb-8"}>
          <CardContent className={embedded ? "grid min-w-0 items-end gap-4 p-5 lg:grid-cols-[minmax(220px,0.85fr)_minmax(260px,1.15fr)_auto]" : "grid items-end gap-4 p-5 md:grid-cols-[1fr_1.4fr_auto]"}>
            <div className="min-w-0">
              <label className="mb-2 block text-sm font-medium">画板名称</label>
              <Input className="h-11" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="min-w-0">
              <label className="mb-2 block text-sm font-medium">说明</label>
              <Textarea className="h-11 min-h-11 resize-none overflow-hidden py-2.5" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div className="flex min-w-0 items-end">
              <Button className={embedded ? "h-11 w-full whitespace-nowrap bg-cyan-200/16 px-5 text-cyan-50 hover:bg-cyan-200/22 lg:w-auto" : "brand-gradient h-11 px-5 text-white"} onClick={createWorkflow} disabled={isCreating || !name.trim()}>
                <LuPlus className="mr-1.5 h-4 w-4" />
                {isCreating ? "创建中..." : "新建画板"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        {isLoading ? (
          <Card className="glass-card">
            <CardContent className="p-10 text-center text-muted-foreground">正在加载画板...</CardContent>
          </Card>
        ) : workflows.length === 0 ? (
          <Card className="glass-card">
            <CardContent className="p-10 text-center text-muted-foreground">还没有画板，先新建一个。</CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {workflows.map((workflow) => (
              <Card
                key={workflow.id}
                role="button"
                tabIndex={0}
                onClick={() => openWorkflow(workflow.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openWorkflow(workflow.id);
                  }
                }}
                className={embedded ? "glass-card card-hover group cursor-pointer border-cyan-100/12 bg-white/[0.045] text-slate-100" : "glass-card card-hover group cursor-pointer"}
              >
                <CardContent className="p-5">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="min-w-0 text-left">
                      <h3 className="truncate text-lg font-semibold group-hover:text-primary">{displayWorkflowName(workflow)}</h3>
                      <p className={embedded ? "mt-1 line-clamp-2 text-sm text-slate-300/72" : "mt-1 line-clamp-2 text-sm text-muted-foreground"}>
                        {displayWorkflowDescription(workflow)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-full p-2 text-muted-foreground hover:bg-red-50 hover:text-red-500"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(workflow);
                      }}
                      aria-label={`删除画板：${displayWorkflowName(workflow)}`}
                    >
                      <LuTrash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{statusLabel[workflow.status] || workflow.status}</Badge>
                    <Badge variant="outline">{workflow.nodes?.length || 0} 个节点</Badge>
                    <span className={embedded ? "text-xs text-slate-400" : "text-xs text-muted-foreground"}>
                      {workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "未更新"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
      <LumaConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}
        title="删除画板工作流"
        description={<>确认删除“{deleteTarget ? displayWorkflowName(deleteTarget) : "当前画板"}”吗？本地拆解文件也会清理，此操作不可恢复。</>}
        confirmLabel="确认删除"
        onConfirm={() => void deleteWorkflow()}
        pending={isDeleting}
      />
    </div>
  );
}
