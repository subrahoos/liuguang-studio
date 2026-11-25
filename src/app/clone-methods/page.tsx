"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LuArrowLeft, LuBrain, LuChevronDown, LuFileVideo, LuLibrary, LuRefreshCw, LuUpload } from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceEmbed } from "@/components/workspace-embed-context";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { CloneMethod } from "@/lib/clone-methods";

const sectionConfig: Array<{ title: string; key: keyof CloneMethod; description?: string }> = [
  { title: "方法总结", key: "methodSummary" },
  { title: "来源视频结构拆解", key: "videoStructureBreakdown" },
  { title: "镜头时间轴", key: "shotTimeline" },
  { title: "口播规则", key: "voiceoverRules" },
  { title: "动作规则", key: "actionRules" },
  { title: "表情/口型规则", key: "expressionRules" },
  { title: "场景规则", key: "sceneRules" },
  { title: "产品展示规则", key: "productShowcaseRules" },
  { title: "视觉结构", key: "visualStructure", description: "构图 / 景别 / 角度 / 运镜 / 光影 / 氛围 / 焦段 / 景深" },
  { title: "资产反推", key: "assetNeeds" },
  { title: "视频执行规则", key: "directorRules" },
  { title: "商品替换边界", key: "productReplacementRules" },
  { title: "全片视频提示规则", key: "grokPromptRules" },
  { title: "失败复盘规则", key: "failureReviewRules" },
  { title: "质量验收标准", key: "qualityRubric" },
  { title: "资产角色规则", key: "assetRolePolicy" },
  { title: "英文方法摘要", key: "englishMethodSummary" },
  { title: "英文视觉规则", key: "englishVisualRules" },
  { title: "英文 image-2 规则", key: "englishImagePromptRules" },
  { title: "英文 Grok/Omni 规则", key: "englishVideoPromptRules" },
  { title: "提示词重点", key: "promptFocus" },
  { title: "来源视频", key: "sourceVideoName" },
  { title: "来源分析路径", key: "sourceAnalysisPath" },
  { title: "来源音频转写", key: "sourceTranscript" },
];

function CloneMethodsWorkspace({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const { llm } = useSettingsStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [methods, setMethods] = useState<CloneMethod[]>([]);
  const [sourceVideoPath, setSourceVideoPath] = useState("");
  const [sourceVideoFile, setSourceVideoFile] = useState<File | null>(null);
  const [methodName, setMethodName] = useState("");
  const [userRequirements, setUserRequirements] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isDistilling, setIsDistilling] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [progressText, setProgressText] = useState("");
  const [showRequirements, setShowRequirements] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isLlmReady = Boolean(llm.baseUrl.trim() && llm.apiKey.trim() && llm.model.trim());

  const loadMethods = async () => {
    setIsLoading(true);
    setError("");
    setProgressText("步骤 1/2：正在用 FFmpeg 抽帧、提取音频，并提交 LLM 做视频证据拆解...");
    try {
      const res = await fetch("/api/clone-methods", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "方法库加载失败");
      setMethods(Array.isArray(data.methods) ? data.methods : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "方法库加载失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadMethods();
  }, []);

  const handleDistill = async () => {
    if (isDistilling) return;
    if (!isLlmReady) {
      setError("方法库拆解需要先在设置里配置 LLM 的 Base URL、API Key 和模型名。");
      return;
    }
    if (!sourceVideoPath.trim() && !sourceVideoFile) {
      setError("请填写本地视频路径，或上传一个参考视频文件。");
      return;
    }

    setIsDistilling(true);
    setError("");
    setSuccess("");
    setProgressText("正在调用 FFmpeg 抽帧/提取音频，然后交给 LLM 分析并沉淀方法...");
    try {
      const analysisForm = new FormData();
      analysisForm.append("sourceVideoPath", sourceVideoPath.trim());
      if (sourceVideoFile) analysisForm.append("sourceVideoFile", sourceVideoFile);
      analysisForm.append("userRequirements", userRequirements.trim());
      analysisForm.append("baseUrl", llm.baseUrl.trim());
      analysisForm.append("apiKey", llm.apiKey.trim());
      analysisForm.append("model", llm.model.trim());
      analysisForm.append("visionModel", (llm.visionModel || "").trim());

      const analysisRes = await fetch("/api/clone/analyze-video", {
        method: "POST",
        body: analysisForm,
      });
      const analysisData = await analysisRes.json().catch(() => ({}));
      if (!analysisRes.ok) throw new Error(analysisData.error || "视频证据拆解失败");

      setProgressText("步骤 2/2：视频证据拆解已完成，正在让 LLM 沉淀成可复用方法并保存到方法库...");
      const form = new FormData();
      form.append("methodName", methodName.trim());
      form.append("analysisJson", JSON.stringify(analysisData));
      form.append("baseUrl", llm.baseUrl.trim());
      form.append("apiKey", llm.apiKey.trim());
      form.append("model", llm.model.trim());
      form.append("visionModel", (llm.visionModel || "").trim());

      const res = await fetch("/api/clone-methods/distill", {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "方法拆解失败");
      setMethods(Array.isArray(data.methods) ? data.methods : []);
      setSourceVideoFile(null);
      setSourceVideoPath("");
      setMethodName("");
      setSuccess(`已保存方法：${data.method?.styleShortName || data.method?.name || "新方法"}。它会同步到脚本风格下拉里。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "方法拆解失败");
    } finally {
      setProgressText("");
      setIsDistilling(false);
    }
  };

  return (
    <div className="min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          {embedded ? (
            <button type="button" className="hidden">
              <LuArrowLeft className="h-4 w-4" />
              返回工作台
            </button>
          ) : (
            <Link href="/workspace?module=methods" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <LuArrowLeft className="h-4 w-4" />
              返回首页
            </Link>
          )}
          <Badge variant="secondary">高相似复刻方法库</Badge>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <section className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <LuLibrary className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">高相似复刻方法库</h1>
          </div>
          <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
            方法库负责把参考视频沉淀成可复用拍法。页面会提取 1 秒故事板、0.5 秒动作补证与完整音频，先生成详细证据报告，再蒸馏成中文方法字段和英文模型调用规则。
          </p>
        </section>

        <Card className="glass-card mb-6">
          <CardContent className="space-y-5 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <LuBrain className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold">拆解参考视频并沉淀方法</h2>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  服务端提示词是唯一的拆解合同，按 1 秒故事板、0.5 秒动作补证和程序切点逐镜头分析；保存结果会包含中文方法库字段和英文模型调用字段。
                </p>
              </div>
              <Badge variant={isLlmReady ? "secondary" : "destructive"}>
                {isLlmReady ? "LLM 已配置" : "需要 LLM 配置"}
              </Badge>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>方法名称/简称（可选）</Label>
                <Input value={methodName} onChange={(e) => setMethodName(e.target.value)} placeholder="例如：户外对镜自拍 / 车内通勤口播" />
              </div>
              <div className="space-y-2">
                <Label>本地视频路径</Label>
                <Input
                  value={sourceVideoPath}
                  onChange={(e) => setSourceVideoPath(e.target.value)}
                  placeholder="例如 D:\\AI\\参考视频\\xxx.mp4"
                />
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              className="hidden"
              onChange={(e) => setSourceVideoFile(e.target.files?.[0] || null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <LuUpload className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">{sourceVideoFile ? sourceVideoFile.name : "或上传参考视频文件"}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">路径和上传二选一即可；大文件建议用本地路径。</p>
              </div>
            </button>

            <div className="rounded-lg border border-border/50 bg-muted/20">
              <button
                type="button"
                onClick={() => setShowRequirements((value) => !value)}
                className="flex w-full items-center justify-between gap-3 p-4 text-left"
              >
                <div>
                    <p className="text-sm font-medium">补充核对重点（可选）</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      只填写本条视频需要特别核对的画面、动作或节奏。它不能覆盖服务端的证据规则或输出合同。
                  </p>
                </div>
                <LuChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showRequirements ? "rotate-180" : ""}`} />
              </button>
              {showRequirements && (
                <div className="space-y-2 border-t border-border/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <Label>补充核对重点</Label>
                    <button
                      type="button"
                      onClick={() => setUserRequirements("")}
                      className="text-xs text-primary hover:underline"
                    >
                      清空
                    </button>
                  </div>
                    <Textarea
                      value={userRequirements}
                      onChange={(e) => setUserRequirements(e.target.value)}
                      className="min-h-80 font-mono text-xs"
                      maxLength={1200}
                      placeholder="例如：重点核对人物双手在两次切镜前后的接触是否连续。"
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                      不写时使用统一合同。可写中文或英文；请只说明要核对的事实，避免粘贴完整提示词。
                  </p>
                </div>
              )}
            </div>

            {progressText && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
                {progressText}
              </div>
            )}
            {success && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700">{success}</div>}
            {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

            <div className="flex flex-wrap gap-3">
              <Button onClick={handleDistill} disabled={isDistilling || !isLlmReady}>
                {isDistilling ? <LuRefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <LuFileVideo className="mr-2 h-4 w-4" />}
                {isDistilling ? "正在拆解并写入方法库..." : "开始拆解并保存方法"}
              </Button>
              <Button variant="outline" onClick={loadMethods} disabled={isLoading || isDistilling}>
                刷新方法列表
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">已保存方法</h2>
          <span className="text-xs text-muted-foreground">{isLoading ? "加载中..." : `${methods.length} 条方法`}</span>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {methods.map((method) => {
            const isExpanded = Boolean(expanded[method.id]);
            return (
              <Card key={method.id} className="glass-card">
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{method.styleShortName || method.name}</Badge>
                      <Badge variant="outline">{method.category}</Badge>
                      <Badge variant="outline">{method.usageMode || "both"}</Badge>
                      <Badge variant="outline">{method.updatedAt}</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setExpanded((value) => ({ ...value, [method.id]: !isExpanded }))}
                    >
                      {isExpanded ? "收起完整详情" : "展开完整详情"}
                    </Button>
                  </div>

                  <div>
                    <h3 className="text-lg font-semibold">{method.name}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{method.description}</p>
                  </div>

                  <MethodSection title="方法总结" value={method.methodSummary} />
                  <MethodSection title="提示词重点" value={method.promptFocus} />

                  {isExpanded && (
                    <div className="space-y-4">
                      {sectionConfig.map((section) => (
                        <MethodSection
                          key={section.key}
                          title={section.title}
                          description={section.description}
                          value={method[section.key]}
                        />
                      ))}
                      <details className="rounded-lg border border-border/50 bg-muted/20 p-3">
                        <summary className="cursor-pointer text-sm font-medium">原始 JSON（兜底显示全部字段）</summary>
                        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                          {JSON.stringify(method, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function MethodSection({
  title,
  description,
  value,
}: {
  title: string;
  description?: string;
  value: unknown;
}) {
  const items = Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  const text = typeof value === "string" ? value.trim() : "";
  if (!items.length && !text) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="mb-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      {items.length ? (
        <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          {items.map((item, index) => (
            <li key={`${title}-${index}`}>- {item}</li>
          ))}
        </ul>
      ) : (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{text}</p>
      )}
    </div>
  );
}

export default function CloneMethodsPage() {
  const { embedded } = useWorkspaceEmbed();
  return <CloneMethodsWorkspace embedded={embedded} />;
}
