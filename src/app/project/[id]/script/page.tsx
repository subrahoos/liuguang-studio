"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { LuArrowRight, LuBookmarkPlus, LuClock, LuCopy, LuFileText, LuHouse, LuImage, LuWand, LuX } from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { GenerationProgress } from "@/components/generation-progress";
import { ProjectVersionBar } from "@/components/project-version-bar";
import type { Shot } from "@/lib/db/schema";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useTemplateStore } from "@/lib/stores/template-store";
import { buildCompactMethodInstruction, type CloneMethod } from "@/lib/clone-methods";
import { joinUniqueTextSections } from "@/lib/prompt-dedup";

interface ProjectDetail {
  id: string;
  name: string;
  productName?: string | null;
  productCategory?: string | null;
  productDescription?: string | null;
  productImages?: string[] | null;
  productAnalysis?: string | null;
  videoMode?: string | null;
  sourceType?: "manual" | "clone" | null;
  status?: string | null;
  currentVersion?: {
    id: string;
    name: string;
    versionType: "normal" | "clone";
  } | null;
}

interface ScriptRecord {
  id: string;
  title?: string | null;
  styleType: string;
  totalDuration?: number | null;
  shots: Shot[];
  selected?: boolean | null;
}

type UnknownRecord = Record<string, unknown>;

function parseCloneWorkflow(value?: string | null): UnknownRecord | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as UnknownRecord;
    const workflow = parsed.cloneWorkflow;
    return workflow && typeof workflow === "object" && !Array.isArray(workflow)
      ? workflow as UnknownRecord
      : null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return value == null ? "" : String(value);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function listValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const text = asText(value).trim();
  return text ? [text] : [];
}

function planSections(value: unknown) {
  const record = asRecord(value);
  return [
    { key: "personViews", title: "人物视角 / 表情动作", items: listValues(record.personViews) },
    { key: "identityGaps", title: "身份包缺口", items: listValues(record.identityGaps) },
    { key: "productViews", title: "商品结构 / 试穿视角", items: listValues(record.productViews) },
    { key: "outfitCoordination", title: "搭配锁定", items: listValues(record.outfitCoordination) },
    { key: "sceneImages", title: "场景锚图", items: listValues(record.sceneImages) },
    { key: "motionReferences", title: "动作 / 运镜参考", items: listValues(record.motionReferences) },
    { key: "firstFrameAnchors", title: "首帧锚图", items: listValues(record.firstFrameAnchors) },
    { key: "detailAssets", title: "细节资产", items: listValues(record.detailAssets) },
    { key: "atmosphereAssets", title: "氛围资产", items: listValues(record.atmosphereAssets) },
  ].filter((section) => section.items.length > 0);
}

const shotTypeLabels: Record<Shot["type"], { label: string; color: string }> = {
  hook: { label: "钩子", color: "bg-red-500/20 text-red-400" },
  pain_point: { label: "痛点", color: "bg-orange-500/20 text-orange-400" },
  product_reveal: { label: "产品", color: "bg-blue-500/20 text-blue-400" },
  demo: { label: "演示", color: "bg-green-500/20 text-green-400" },
  social_proof: { label: "背书", color: "bg-purple-500/20 text-purple-400" },
  cta: { label: "转化", color: "bg-amber-500/20 text-amber-400" },
};

const styleLabels: Record<string, string> = {
  pain_point: "痛点种草",
  scene: "场景安利",
  comparison: "对比测评",
  story: "剧情故事",
  custom: "自定义",
};

const regenerateStyleOptions = [
  { value: "auto", label: "智能推荐" },
  { value: "pain-point", label: "痛点种草" },
  { value: "scenario", label: "场景安利" },
  { value: "comparison", label: "对比测评" },
  { value: "story", label: "剧情故事" },
];

const regenerateDurationOptions = [
  { value: "10", label: "10 秒" },
  { value: "15", label: "15 秒" },
  { value: "20", label: "20 秒" },
  { value: "30", label: "30 秒" },
  { value: "60", label: "60 秒" },
  { value: "custom", label: "自定义" },
];

const visualSourceLabels: Record<Shot["visualSource"], string> = {
  product_image: "商品原图",
  ai_generate: "AI 生成",
  user_upload: "用户上传",
};

function normalizeRegenerateDuration(value: string, customValue: string) {
  const raw = value === "custom" ? customValue : value;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(300, Math.max(5, parsed));
}

function formatTenSecondPlan(totalDuration: number) {
  const segments: number[] = [];
  let remaining = Math.max(0, totalDuration);
  while (remaining > 0) {
    const next = remaining > 10 ? 10 : remaining;
    segments.push(next);
    remaining -= next;
  }
  return segments.join(" + ") || "30";
}

export default function ScriptPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const versionId = searchParams.get("versionId");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [selectedScript, setSelectedScript] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [error, setError] = useState("");
  const [scriptProgress, setScriptProgress] = useState<{
    percentage: number;
    stage: string;
    detail: string;
    elapsedSeconds: number;
    etaSeconds: number;
  } | null>(null);

  const { addTemplate } = useTemplateStore();
  const { llm } = useSettingsStore();
  const [regenerateStyle, setRegenerateStyle] = useState("auto");
  const [cloneMethods, setCloneMethods] = useState<CloneMethod[]>([]);
  const [selectedCloneMethodId, setSelectedCloneMethodId] = useState("none");
  const [regenerateDuration, setRegenerateDuration] = useState("30");
  const [customRegenerateDuration, setCustomRegenerateDuration] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [savedTip, setSavedTip] = useState(false);
  const [promptPreview, setPromptPreview] = useState<{
    title: string;
    chineseDescription: string;
    englishPrompt: string;
    voiceover: string;
  } | null>(null);

  const loadProject = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [projectRes, scriptsRes] = await Promise.all([
        fetch(`/api/project/${id}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`, { cache: "no-store" }),
        fetch(`/api/project/${id}/scripts${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`, { cache: "no-store" }),
      ]);
      const projectData = await projectRes.json().catch(() => ({}));
      const scriptsData = await scriptsRes.json().catch(() => []);

      if (!projectRes.ok) throw new Error(projectData.error || "项目读取失败");
      if (!scriptsRes.ok) throw new Error(scriptsData.error || "脚本读取失败");

      const loadedScripts = Array.isArray(scriptsData) ? scriptsData : [];
      setProject(projectData);
      setScripts(loadedScripts);
      const selectedIndex = loadedScripts.findIndex((script: ScriptRecord) => script.selected);
      setSelectedScript(selectedIndex >= 0 ? selectedIndex : 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "页面加载失败");
    } finally {
      setIsLoading(false);
    }
  }, [id, versionId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/clone-methods", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setCloneMethods(Array.isArray(data.methods) ? data.methods : []);
      })
      .catch(() => {
        if (!cancelled) setCloneMethods([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentScript = scripts[selectedScript];
  const effectiveVersionId = versionId || project?.currentVersion?.id || "";
  const isCloneProject = project?.currentVersion?.versionType === "clone" || project?.sourceType === "clone";
  const cloneWorkflow = useMemo(() => parseCloneWorkflow(project?.productAnalysis), [project?.productAnalysis]);
  const clonePlan = useMemo(() => asRecord(cloneWorkflow?.plan), [cloneWorkflow]);
  const cloneAssetPrompts = useMemo(() => asArray(clonePlan.image2AssetPrompts), [clonePlan]);
  const cloneSegmentAssetPlans = useMemo(() => asArray(clonePlan.segmentAssetPlans), [clonePlan]);
  const cloneAssetPlanSections = useMemo(() => planSections(clonePlan.assetPlan), [clonePlan]);
  const hasClonePreviewPlan = isCloneProject && Boolean(cloneWorkflow && Object.keys(clonePlan).length > 0);
  const availableCloneMethods = useMemo(
    () =>
      cloneMethods.filter((method) =>
        isCloneProject ? method.usageMode !== "normal" : method.usageMode !== "clone"
      ),
    [cloneMethods, isCloneProject]
  );
  const selectedCloneMethod = useMemo(
    () => availableCloneMethods.find((method) => method.id === selectedCloneMethodId) || null,
    [availableCloneMethods, selectedCloneMethodId]
  );
  const methodLibraryActive = Boolean(selectedCloneMethod);
  const regenerateTargetDuration = useMemo(
    () => normalizeRegenerateDuration(regenerateDuration, customRegenerateDuration),
    [regenerateDuration, customRegenerateDuration]
  );
  const regenerateDurationPlan = useMemo(
    () => formatTenSecondPlan(regenerateTargetDuration),
    [regenerateTargetDuration]
  );
  const voiceoverText = useMemo(
    () => currentScript?.shots.map((shot) => shot.voiceover).filter(Boolean).join("\n\n") || "",
    [currentScript]
  );
  const shotPlanText = useMemo(
    () =>
      currentScript?.shots
        .map((shot) =>
          [
            `分镜 ${String(shot.shotId).padStart(2, "0")}｜${shot.duration}s｜${shot.type}`,
            `中文画面：${shot.description || "未填写"}`,
            `中文运镜：${shot.camera || "未填写"}`,
            `配音：${shot.voiceover || "未填写"}`,
            shot.prompt ? `英文关键帧 prompt：${shot.prompt}` : "",
          ].filter(Boolean).join("\n")
        )
        .join("\n\n") || "",
    [currentScript]
  );
  const voiceoverLength = voiceoverText.replace(/\s/g, "").length;

  useEffect(() => {
    if (!currentScript?.totalDuration) return;
    const totalDuration = String(currentScript.totalDuration);
    const hasPreset = regenerateDurationOptions.some((option) => option.value === totalDuration);
    setRegenerateDuration(hasPreset ? totalDuration : "custom");
    if (!hasPreset) setCustomRegenerateDuration(totalDuration);
  }, [currentScript?.totalDuration]);

  useEffect(() => {
    if (!isCloneProject || scripts.length > 0) return;
    const planDuration = Number(
      cloneWorkflow?.targetDuration
      ?? clonePlan.duration
      ?? clonePlan.targetDuration
      ?? clonePlan.totalDuration
    );
    if (!Number.isFinite(planDuration) || planDuration <= 0) return;
    const totalDuration = String(planDuration);
    const hasPreset = regenerateDurationOptions.some((option) => option.value === totalDuration);
    setRegenerateDuration(hasPreset ? totalDuration : "custom");
    if (!hasPreset) setCustomRegenerateDuration(totalDuration);
  }, [clonePlan.duration, clonePlan.targetDuration, clonePlan.totalDuration, cloneWorkflow?.targetDuration, isCloneProject, scripts.length]);

  useEffect(() => {
    const methodId = asText(cloneWorkflow?.selectedMethodId);
    if (!methodId || !availableCloneMethods.some((method) => method.id === methodId)) return;
    setSelectedCloneMethodId(methodId);
  }, [availableCloneMethods, cloneWorkflow?.selectedMethodId]);

  const openPromptPreview = useCallback((shot: Shot) => {
    setPromptPreview({
      title: `Shot ${String(shot.shotId).padStart(2, "0")} English prompt preview`,
      chineseDescription: shot.description || "",
      englishPrompt: shot.prompt || "",
      voiceover: shot.voiceover || "",
    });
  }, []);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
  }, []);

  const handleSaveAsTemplate = () => {
    setTemplateName("");
    setShowSaveDialog(true);
  };

  const doSaveTemplate = () => {
    if (!templateName.trim() || !currentScript) return;
    addTemplate({
      id: crypto.randomUUID(),
      name: templateName.trim(),
      styleType: currentScript.styleType,
      shots: currentScript.shots,
      totalDuration: currentScript.totalDuration || 0,
      useCount: 0,
      createdAt: new Date(),
    });
    setShowSaveDialog(false);
    setSavedTip(true);
    setTimeout(() => setSavedTip(false), 3000);
  };

  const handleRegenerateScript = async () => {
    if (!project || isRegenerating) return;

    if (!llm.baseUrl || !llm.apiKey || !llm.model) {
      setError("Please configure LLM baseUrl, API Key, and model first.");
      return;
    }

    const productName = project.productName || project.name.replace(/\s*推广$/, "");
    if (!productName.trim()) {
      setError("Current project has no product name, so script generation cannot start.");
      return;
    }

    setIsRegenerating(true);
    setError("");
    setScriptProgress({
      percentage: 2,
      stage: "Connecting to script generation API...",
      detail: "Listening for real backend events from the API call.",
      elapsedSeconds: 0,
      etaSeconds: isCloneProject ? 720 : 90,
    });

    try {
      if (isCloneProject) {
        if (!selectedCloneMethod) {
          setError("爆款复刻版本需要先选择一个方法库方法，再生成完整视频规划。");
          return;
        }

        const startedAt = Date.now();
        const clonePlanTimer = window.setInterval(() => {
          setScriptProgress((current) => {
            if (!current || current.percentage >= 84) return current;
            const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
            return {
              percentage: Math.min(84, current.percentage + 3),
              stage: "LLM 正在生成爆款复刻完整规划...",
              detail: "真实调用 /api/clone/plan-full-video：长规划请求会等待模型完整返回，本地上限 12 分钟。",
              elapsedSeconds,
              etaSeconds: Math.max(0, 720 - elapsedSeconds),
            };
          });
        }, 12_000);

        try {
          const clientRequestId = typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const methodInstruction = buildCompactMethodInstruction(selectedCloneMethod);
          const productPackageInstruction = joinUniqueTextSections([
            project.productDescription || "",
            `当前商品名称：${productName}`,
            `当前商品品类：${project.productCategory || "other"}`,
            "必须先根据商品参考图识别真实商品结构，再写入商品结构锁；方法库和旧案例不能覆盖商品图。",
          ]);
          const cloneAnalysis = [
            "当前版本从方法库直接生成爆款复刻规划，不在此处重新拆解参考视频。",
            `已选择方法库：${selectedCloneMethod.name}。`,
            "方法库完整规则只通过 cloneMethodInstruction 传入，本段只作为短摘要，避免重复放大 prompt。",
            "商品、人物身份和本版本配置优先级高于历史版本内容。",
          ].join("\n\n");

          setScriptProgress({
            percentage: 25,
            stage: "正在提交爆款复刻完整规划请求...",
            detail: `目标时长：${regenerateTargetDuration} 秒；方法库：${selectedCloneMethod.name}。已带 versionId=${effectiveVersionId || "默认版本"} 提交，等待 LLM 完整返回。`,
            elapsedSeconds: 0,
            etaSeconds: 720,
          });

          const planRes = await fetch("/api/clone/plan-full-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: project.id,
              versionId: effectiveVersionId || undefined,
              clientRequestId,
              productName,
              productFeatures: [
                "商品基础信息和结构锁已通过 userRequirements 传入。",
                "这里不重复商品包全文，避免同一规则多次进入 LLM。",
              ].join("\n"),
              category: project.productCategory || "other",
              duration: regenerateTargetDuration,
              videoMode: project.videoMode || "live_presenter",
              productImages: project.productImages || [],
              cloneAnalysis,
              transcript: "",
              userRequirements: productPackageInstruction,
              cloneMethodInstruction: methodInstruction,
              identityPackInstruction: "",
              llmConfig: {
                baseUrl: llm.baseUrl,
                apiKey: llm.apiKey,
                model: llm.model,
                visionModel: llm.visionModel,
              },
            }),
          });
          const planJson = await planRes.json().catch(() => ({}));
          if (!planRes.ok) throw new Error(planJson.error || "爆款复刻完整视频规划失败");

          const cloneContext = {
            type: "high_similarity_clone",
            source: "method_library",
            selectedMethodId: selectedCloneMethod.id,
            selectedMethodName: selectedCloneMethod.name,
            selectedProductId: project.id,
            transcript: "",
            referenceAnalysis: cloneAnalysis,
            methodLibraryInstruction: methodInstruction,
            identityPackInstruction: "",
            productPackageInstruction,
            targetDuration: regenerateTargetDuration,
            plan: planJson.plan || {},
            generatedAssetPackage: [],
            generatedAssetManifestPath: null,
            savedMarkdownPath: {
              plan: planJson.savedMarkdownPath,
            },
          };

          setScriptProgress({
            percentage: 92,
            stage: "正在保存当前版本的爆款复刻规划...",
            detail: "只写入当前 versionId，不覆盖旧版本。",
            elapsedSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
            etaSeconds: 5,
          });

          const savePlanRes = await fetch(`/api/project/${project.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "scripting",
              versionId: effectiveVersionId || undefined,
              productAnalysis: JSON.stringify({
                productVisualAnalysis: planJson.plan?.productVisualAnalysis || null,
                productStructureLock: planJson.plan?.productStructureLock || null,
                cloneWorkflow: cloneContext,
              }, null, 2),
            }),
          });
          const savePlanJson = await savePlanRes.json().catch(() => ({}));
          if (!savePlanRes.ok) throw new Error(savePlanJson.error || "爆款复刻规划保存失败");

          setScriptProgress({
            percentage: 100,
            stage: "爆款复刻完整规划已生成",
            detail: "当前版本已写入新的完整导演稿和资产反推计划。",
            elapsedSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
            etaSeconds: 0,
          });
          await loadProject();
          return;
        } finally {
          window.clearInterval(clonePlanTimer);
        }
      }

      const cloneMethodHint = selectedCloneMethod
        ? [
            "用户在脚本方案页选择了高相似复刻方法，请用它重新生成脚本方案。",
            "这不是参考视频拆解，不要假设有来源视频；只复用方法库里的场景、动作、资产反推和导演稿规则。",
            buildCompactMethodInstruction(selectedCloneMethod),
          ].join("\n\n")
        : undefined;
      const response = await fetch("/api/llm/script/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          versionId: effectiveVersionId || undefined,
          productName,
          productCategory: project.productCategory || "other",
          productDescription: project.productDescription || "",
          productAnalysis: project.productAnalysis || undefined,
          forceProductAnalysis: true,
          targetDuration: regenerateTargetDuration,
          styleType: selectedCloneMethod ? "custom" : regenerateStyle,
          videoMode: project.videoMode || "product_closeup",
          productImages: project.productImages || [],
          customRequirements: cloneMethodHint,
          llmConfig: {
            baseUrl: llm.baseUrl,
            apiKey: llm.apiKey,
            model: llm.model,
            visionModel: llm.visionModel,
          },
        }),
      });

      if (!response.ok || !response.body) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Script generation failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const startedAt = Date.now();
      let buffer = "";
      let isComplete = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const eventBlocks = buffer.split("\n\n");
        buffer = eventBlocks.pop() || "";

        for (const block of eventBlocks) {
          const eventName = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "progress";
          const dataLine = block.match(/^data:\s*(.+)$/m)?.[1];
          if (!dataLine) continue;

          const eventData = JSON.parse(dataLine) as {
            progress?: number;
            label?: string;
            stage?: string;
            source?: string;
            chars?: number;
            error?: string;
          };

          if (eventName === "error") {
            throw new Error(eventData.error || eventData.label || "Script generation failed.");
          }

          const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
          const percentage = Math.min(100, Math.max(1, Math.round(eventData.progress || 1)));
          const etaSeconds = percentage >= 100
            ? 0
            : Math.max(5, Math.round((elapsedSeconds / Math.max(percentage, 1)) * (100 - percentage)));

          setScriptProgress({
            percentage,
            stage: eventData.label || eventData.stage || "Script generation is running.",
            detail: eventData.source
              ? "Real event source: " + eventData.source + (eventData.chars ? ", received " + eventData.chars + " chars" : "")
              : "Listening for backend events.",
            elapsedSeconds,
            etaSeconds,
          });

          if (eventName === "complete") {
            isComplete = true;
          }
        }
      }

      if (!isComplete) {
        throw new Error("Script stream ended before a completion event was received.");
      }
      await loadProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Script generation failed.");
    } finally {
      setIsRegenerating(false);
      setScriptProgress(null);
    }
  };

  const regenerateDurationPanel = (
    <div className="rounded-xl border border-border/50 bg-background/60 p-3">
      <Label className="text-xs font-medium">目标时长</Label>
      <div className="mt-2 grid grid-cols-3 gap-2 md:grid-cols-6">
        {regenerateDurationOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setRegenerateDuration(option.value)}
            className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
              regenerateDuration === option.value
                ? "border-primary bg-primary/10 text-primary"
                : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {regenerateDuration === "custom" && (
        <Input
          type="number"
          min={5}
          max={300}
          value={customRegenerateDuration}
          onChange={(event) => setCustomRegenerateDuration(event.target.value)}
          placeholder="例如 45"
          className="mt-2 h-9 text-xs"
        />
      )}
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        本次会按 {regenerateTargetDuration} 秒重新生成。{isCloneProject
          ? `爆款复刻会先写完整导演稿，再按约 10 秒规划资产段：${regenerateDurationPlan}。`
          : "普通项目会按该时长重新分配分镜数量和分镜时长。"}
      </p>
    </div>
  );

  return (
    <div className="min-h-screen grid-bg">
      {promptPreview && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-6" onClick={() => setPromptPreview(null)}>
          <div
            className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-border/50 bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
              <div>
                <h3 className="text-base font-semibold">{promptPreview.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  左侧是给你看的中文翻译/说明；右侧英文 prompt 是后续 image-2 的主提示词基础。
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-border/50 p-2 hover:bg-muted/40"
                onClick={() => setPromptPreview(null)}
              >
                <LuX className="h-4 w-4" />
              </button>
            </div>

            <div className="grid max-h-[72vh] gap-4 overflow-y-auto p-5 lg:grid-cols-2">
              <section className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">中文预览</h4>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void copyText(promptPreview.chineseDescription)}>
                    <LuCopy className="mr-1 h-3.5 w-3.5" />
                    复制中文
                  </Button>
                </div>
                <pre className="max-h-[52vh] whitespace-pre-wrap rounded-xl border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-foreground">
                  {[promptPreview.chineseDescription, promptPreview.voiceover ? `口播：${promptPreview.voiceover}` : ""].filter(Boolean).join("\n\n")}
                </pre>
              </section>

              <section className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">英文主提示词</h4>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void copyText(promptPreview.englishPrompt)}>
                    <LuCopy className="mr-1 h-3.5 w-3.5" />
                    复制英文
                  </Button>
                </div>
                <pre className="max-h-[52vh] whitespace-pre-wrap rounded-xl border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-foreground">
                  {promptPreview.englishPrompt || "当前脚本没有返回英文 prompt，请重新生成脚本。"}
                </pre>
              </section>
            </div>
          </div>
        </div>
      )}

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
            <span className="text-sm text-muted-foreground truncate max-w-md">
              {project?.name || "项目脚本"}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <Link href="/">
              <Button variant="outline" size="sm" className="mr-2 h-8">
                <LuHouse className="mr-1.5 h-4 w-4" />
                回首页
              </Button>
            </Link>
            {["脚本", "素材", "视频", "导出"].map((step, index) => (
              <div key={step} className="flex items-center">
                <div className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${index === 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${index === 0 ? "bg-white/20" : "bg-muted"}`}>
                    {index + 1}
                  </span>
                  {step}
                </div>
                {index < 3 && <div className="mx-1 h-px w-4 bg-border" />}
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <ProjectVersionBar
          projectId={id}
          onRegenerateScript={handleRegenerateScript}
          regenerateScriptDisabled={isRegenerating || isLoading}
        />
        {isLoading ? (
          <Card className="glass-card">
            <CardContent className="py-16 text-center text-muted-foreground">
              正在加载项目脚本...
            </CardContent>
          </Card>
        ) : error ? (
          <Card className="glass-card">
            <CardContent className="py-16 text-center">
              <p className="text-destructive">{error}</p>
              <Link href="/" className="mt-4 inline-block">
                <Button variant="outline">返回项目列表</Button>
              </Link>
            </CardContent>
          </Card>
        ) : hasClonePreviewPlan && scripts.length === 0 ? (
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <Card className="glass-card">
              <CardContent className="space-y-5 p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Badge variant="secondary">爆款复刻规划预览</Badge>
                    <h2 className="mt-3 text-2xl font-bold">先确认 LLM 的完整视频方案</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      这一步只展示完整导演稿、口播仿写和资产反推计划；确认没问题后，再进入 image-2 资产生成页。
                    </p>
                  </div>
                  <Link href={`/project/${id}/assets${effectiveVersionId ? `?versionId=${encodeURIComponent(effectiveVersionId)}` : ""}`}>
                    <Button className="brand-gradient text-white">
                      确认方案，进入 image-2 资产生成
                      <LuArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Link>
                </div>

                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">重新生成当前版本规划</h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        如果这版时长、方法或方向不满意，可以在这里改完后点“重新生成规划”。只会覆盖当前版本，不会动旧版本。
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="brand-gradient text-white"
                      onClick={handleRegenerateScript}
                      disabled={isRegenerating}
                    >
                      <LuWand className="mr-1.5 h-4 w-4" />
                      {isRegenerating ? "正在生成..." : "重新生成规划"}
                    </Button>
                  </div>
                  <div className="mt-4 space-y-4">
                    {regenerateDurationPanel}
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium">爆款复刻方法</span>
                        <Link href="/clone-methods" className="text-xs text-primary hover:underline">方法库</Link>
                      </div>
                      <select
                        value={selectedCloneMethodId}
                        onChange={(event) => setSelectedCloneMethodId(event.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                      >
                        <option value="none">请选择方法库方法</option>
                        {availableCloneMethods.map((method) => (
                          <option key={method.id} value={method.id}>
                            {method.name}
                          </option>
                        ))}
                      </select>
                      {selectedCloneMethod ? (
                        <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-relaxed text-amber-700">
                          当前将按「{selectedCloneMethod.name}」和上方目标时长重新写完整导演稿与资产反推计划。
                        </p>
                      ) : (
                        <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-xs leading-relaxed text-destructive">
                          重写爆款复刻规划前必须选择一个方法库方法，避免误走普通项目逻辑。
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">方法类型</p>
                    <p className="mt-1 font-semibold">{asText(clonePlan.methodType) || "未返回"}</p>
                  </div>
                  <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">资产提示词</p>
                    <p className="mt-1 font-semibold">{cloneAssetPrompts.length} 条</p>
                  </div>
                  <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">项目商品</p>
                    <p className="mt-1 line-clamp-1 font-semibold">{project?.productName || project?.name}</p>
                  </div>
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-semibold">中文复刻概述</h3>
                  <div className="rounded-xl border border-border/50 bg-muted/20 p-4 text-sm leading-relaxed whitespace-pre-wrap">
                    {asText(clonePlan.chineseSummary) || "LLM 没有返回中文概述。"}
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">商品视觉分析</h3>
                    <pre className="max-h-[280px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/50 bg-muted/20 p-4 text-xs leading-relaxed">
                      {JSON.stringify(clonePlan.productVisualAnalysis || {}, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">商品结构锁</h3>
                    <pre className="max-h-[280px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/50 bg-muted/20 p-4 text-xs leading-relaxed">
                      {JSON.stringify(clonePlan.productStructureLock || {}, null, 2)}
                    </pre>
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-semibold">完整视频导演稿（给 Grok / 完整视频模型）</h3>
                  <pre className="max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/50 bg-black/20 p-4 text-xs leading-relaxed">
                    {asText(clonePlan.fullVideoPrompt) || "未生成 fullVideoPrompt。"}
                  </pre>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-semibold">口播仿写</h3>
                  <div className="rounded-xl border border-border/50 bg-muted/20 p-4 text-sm leading-relaxed whitespace-pre-wrap">
                    {asText(clonePlan.voiceoverRewrite) || "未返回口播仿写。"}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-semibold">质量验收检查项</h3>
                  <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                    {asArray(clonePlan.qualityChecklist).length === 0 ? (
                      <p className="text-sm text-muted-foreground">未返回质量检查项。</p>
                    ) : (
                      <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                        {asArray(clonePlan.qualityChecklist).map((item, index) => (
                          <li key={index} className="flex gap-2">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                            <span>{asText(item)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="text-base font-semibold">资产反推计划</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    这里决定下一页 image-2 要生成哪些辅助图，不会在本页自动生图。
                  </p>
                  {cloneAssetPlanSections.length === 0 ? (
                    <p className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-3 text-sm text-muted-foreground">
                      未返回 assetPlan。
                    </p>
                  ) : (
                    <div className="mt-4 grid gap-3">
                      {cloneAssetPlanSections.map((section) => (
                        <div key={section.key} className="rounded-xl border border-border/50 bg-muted/20 p-3">
                          <h4 className="text-sm font-medium">{section.title}</h4>
                          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                            {section.items.map((item, itemIndex) => (
                              <li key={itemIndex} className="flex gap-2">
                                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="text-base font-semibold">按完整稿拆出的分段资产计划</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    正确顺序是：先看完整视频导演稿，再按目标时长拆段；哪怕目标时长只有 10 秒，也应该有 1 组 segmentAssetPlans。每组资产都从对应时间段的动作、人物、商品和场景反推，最多 7 张 image-2 参考资产。
                  </p>
                  <div className="mt-4 space-y-3">
                    {cloneSegmentAssetPlans.length === 0 ? (
                      <p className="text-sm text-muted-foreground">当前方案没有返回 segmentAssetPlans，这属于异常兼容情况。系统只能读取顶层 image2AssetPrompts 这个扁平副本继续展示；正常流程应返回至少 1 组分段资产包。</p>
                    ) : (
                      cloneSegmentAssetPlans.map((item, index) => {
                        const segment = asRecord(item);
                        const prompts = asArray(segment.image2AssetPrompts);
                        return (
                          <div key={index} className="rounded-xl border border-border/50 bg-muted/20 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-medium">
                                任务 {asText(segment.segmentIndex) || index + 1}｜{asText(segment.timeRange) || `${index * 10}-${(index + 1) * 10}s`}
                              </p>
                              <Badge variant="outline">{prompts.length}/7 张资产</Badge>
                            </div>
                            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                              {asText(segment.segmentDirectorSummary) || asText(segment.storyPurpose) || "未返回本段导演摘要。"}
                            </p>
                            <div className="mt-3 space-y-2">
                              {prompts.map((promptItem, promptIndex) => {
                                const prompt = asRecord(promptItem);
                                return (
                                  <div key={promptIndex} className="rounded-lg border border-border/40 bg-background/60 p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-xs font-medium">{asText(prompt.assetName) || `资产 ${promptIndex + 1}`}</p>
                                      <Badge variant="outline">{asText(prompt.assetRole) || "asset"}</Badge>
                                    </div>
                                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                                      {asText(prompt.promptChinesePreview) || asText(prompt.purpose) || "未返回中文预览。"}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="text-base font-semibold">分段视频提示词草案</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    这里是给 Grok/Omni 的段落级草案。后续视频页会再结合已验收资产图和商品结构锁，生成最终提交提示词。
                  </p>
                  <div className="mt-4 space-y-3">
                    {asArray(clonePlan.segmentVideoPromptDrafts).length === 0 ? (
                      <p className="text-sm text-muted-foreground">未返回 segmentVideoPromptDrafts。</p>
                    ) : (
                      asArray(clonePlan.segmentVideoPromptDrafts).map((item, index) => {
                        const draft = asRecord(item);
                        return (
                          <div key={index} className="rounded-xl border border-border/50 bg-muted/20 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-medium">
                                任务 {asText(draft.segmentIndex) || index + 1}｜{asText(draft.timeRange) || `${index * 10}-${(index + 1) * 10}s`}
                              </p>
                              <Badge variant="outline">{asText(draft.durationSeconds) || "?"}s</Badge>
                            </div>
                            <pre className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/40 bg-background/60 p-3 text-xs leading-relaxed">
                              {asText(draft.promptEnglishDraft) || "未返回英文段落草案。"}
                            </pre>
                          </div>
                        );
                      })
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="text-base font-semibold">image-2 资产提示词预览</h3>
                  <div className="mt-4 space-y-3">
                    {cloneAssetPrompts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">没有资产提示词，请返回爆款复刻页重新生成方案。</p>
                    ) : (
                      cloneAssetPrompts.map((item, index) => {
                        const prompt = asRecord(item);
                        return (
                          <div key={index} className="rounded-xl border border-border/50 bg-muted/20 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm font-medium">{asText(prompt.assetName) || `资产 ${index + 1}`}</p>
                              <Badge variant="outline">{asText(prompt.referencePriority) || "auto"}</Badge>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">{asText(prompt.purpose)}</p>
                            <p className="mt-2 line-clamp-4 text-xs leading-relaxed">{asText(prompt.promptEnglish)}</p>
                          </div>
                        );
                      })
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : scripts.length === 0 ? (
          <Card className="glass-card">
            <CardContent className="py-10">
              <h2 className="text-lg font-semibold">这个项目还没有保存脚本</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                当前版本是空白脚本版本：{project?.productName || project?.name || "未命名商品"}。先选择脚本风格或方法库，再生成这一版的新内容。
              </p>

              <div className="mt-5 rounded-2xl border border-primary/20 bg-primary/5 p-4 text-left">
                <h3 className="text-sm font-semibold">生成这一版脚本前的设置</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  空白版本不会继承旧脚本、旧素材和旧视频。这里选择的风格/方法只作用于当前版本。
                </p>
                <div className="mt-4">
                  {regenerateDurationPanel}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
                  {regenerateStyleOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setRegenerateStyle(option.value);
                        setSelectedCloneMethodId("none");
                      }}
                      disabled={methodLibraryActive}
                      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                        methodLibraryActive
                          ? "cursor-not-allowed border-border/40 bg-muted/20 text-muted-foreground/50"
                          : regenerateStyle === option.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 bg-background/70 text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {methodLibraryActive && (
                  <p className="mt-2 rounded-lg border border-primary/20 bg-primary/10 p-2 text-xs leading-relaxed text-primary">
                    已由方法库接管：上方“智能推荐/脚本风格”暂不参与本次生成。清空方法库选择后，才会重新使用上方风格。
                  </p>
                )}
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium">
                      {isCloneProject ? "爆款复刻方法（可选）" : "方法库风格（可选）"}
                    </span>
                    <Link href="/clone-methods" className="text-xs text-primary hover:underline">方法库</Link>
                  </div>
                  <select
                    value={selectedCloneMethodId}
                    onChange={(event) => setSelectedCloneMethodId(event.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                  >
                    <option value="none">不使用方法库，按上方风格生成</option>
                    {availableCloneMethods.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.name}
                      </option>
                    ))}
                  </select>
                  {availableCloneMethods.length === 0 && (
                    <p className="mt-2 rounded-lg border border-border/50 bg-muted/20 p-2 text-xs leading-relaxed text-muted-foreground">
                      当前没有适合{isCloneProject ? "爆款复刻" : "普通项目"}的可用方法。可到方法库新增或调整方法的使用场景。
                    </p>
                  )}
                  {selectedCloneMethod && (
                    <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-relaxed text-amber-700">
                      已选择「{selectedCloneMethod.name}」，生成时只按该方法库规则写脚本和提示词，上方风格按钮不会叠加参与。
                    </p>
                  )}
                </div>
              </div>

              <Button
                className="brand-gradient mt-5 text-white"
                onClick={handleRegenerateScript}
                disabled={isRegenerating}
              >
                <LuWand className="mr-1.5 h-4 w-4" />
                {isRegenerating ? "正在生成..." : "生成脚本"}
              </Button>
              {scriptProgress && (
                <GenerationProgress
                  className="mx-auto mt-5 max-w-lg text-left"
                  title="Script generation monitor"
                  percentage={scriptProgress.percentage}
                  elapsedSeconds={scriptProgress.elapsedSeconds}
                  etaSeconds={scriptProgress.etaSeconds}
                  stage={scriptProgress.stage}
                  detail={scriptProgress.detail}
                />
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold">脚本方案</h2>
                <div className="flex items-center gap-2">
                  {savedTip && <span className="text-xs text-green-400 animate-in fade-in">已保存为模板</span>}
                  <Button variant="outline" size="sm" className="text-xs" onClick={handleSaveAsTemplate}>
                    <LuBookmarkPlus className="w-3.5 h-3.5 mr-1" />
                    存为模板
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isRegenerating}
                    className="text-xs"
                    onClick={handleRegenerateScript}
                  >
                    <LuWand className="w-3.5 h-3.5 mr-1" />
                    {isRegenerating ? "生成中..." : "重新生成"}
                  </Button>
                </div>
              </div>
              {scriptProgress && (
                <GenerationProgress
                  className="mb-4"
                  title="Script generation monitor"
                  percentage={scriptProgress.percentage}
                  elapsedSeconds={scriptProgress.elapsedSeconds}
                  etaSeconds={scriptProgress.etaSeconds}
                  stage={scriptProgress.stage}
                  detail={scriptProgress.detail}
                />
              )}

              <Card className="glass-card mb-4">
                <CardContent className="space-y-4 p-4">
                  <div>
                    <h3 className="text-sm font-semibold">重新生成脚本风格</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      已创建项目也可以在这里切换风格或选择复刻方法，再点击重新生成。
                    </p>
                  </div>
                  {regenerateDurationPanel}
                  <div className="grid grid-cols-2 gap-2">
                    {regenerateStyleOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setRegenerateStyle(option.value);
                          setSelectedCloneMethodId("none");
                        }}
                        disabled={methodLibraryActive}
                        className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                          methodLibraryActive
                            ? "cursor-not-allowed border-border/40 bg-muted/20 text-muted-foreground/50"
                            : regenerateStyle === option.value
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {methodLibraryActive && (
                    <p className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-xs leading-relaxed text-primary">
                      已由方法库接管：上方“智能推荐/脚本风格”暂不参与本次生成。清空方法库选择后，才会重新使用上方风格。
                    </p>
                  )}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium">
                        {isCloneProject ? "爆款复刻方法（可选）" : "方法库风格（可选）"}
                      </span>
                      <Link href="/clone-methods" className="text-xs text-primary hover:underline">方法库</Link>
                    </div>
                    <select
                      value={selectedCloneMethodId}
                      onChange={(event) => setSelectedCloneMethodId(event.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                    >
                      <option value="none">不使用方法库，按上方风格生成</option>
                      {availableCloneMethods.map((method) => (
                        <option key={method.id} value={method.id}>
                          {method.name}
                        </option>
                      ))}
                    </select>
                    {availableCloneMethods.length === 0 && (
                      <p className="mt-2 rounded-lg border border-border/50 bg-muted/20 p-2 text-xs leading-relaxed text-muted-foreground">
                        当前没有适合{isCloneProject ? "爆款复刻" : "普通项目"}的可用方法。可到方法库新增或调整方法的使用场景。
                      </p>
                    )}
                    {selectedCloneMethod && (
                      <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-relaxed text-amber-700">
                        已选择「{selectedCloneMethod.name}」，重新生成时只按该方法库规则写脚本和提示词，上方风格按钮不会叠加参与。
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-3">
                {scripts.map((script, index) => (
                  <Card
                    key={script.id}
                    className={`cursor-pointer transition-all ${selectedScript === index ? "ring-2 ring-primary neon-glow" : "glass-card card-hover"}`}
                    onClick={() => setSelectedScript(index)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="font-medium text-sm">{script.title || `脚本方案 ${index + 1}`}</h3>
                        <Badge variant="secondary" className="text-xs shrink-0 ml-2">
                          {styleLabels[script.styleType] || script.styleType}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{script.shots.length} 个镜头</span>
                        <span>{script.totalDuration || 0}s</span>
                      </div>
                      <div className="mt-3 flex gap-0.5 h-1.5 rounded-full overflow-hidden">
                        {script.shots.map((shot) => {
                          const colors: Record<string, string> = {
                            hook: "bg-red-500",
                            pain_point: "bg-orange-500",
                            product_reveal: "bg-blue-500",
                            demo: "bg-green-500",
                            social_proof: "bg-purple-500",
                            cta: "bg-amber-500",
                          };
                          return (
                            <div
                              key={shot.shotId}
                              className={`${colors[shot.type]} opacity-70`}
                              style={{ flex: shot.duration }}
                            />
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            <div className="lg:col-span-2">
              <Tabs defaultValue="timeline" className="w-full">
                <div className="flex items-center justify-between mb-4">
                  <TabsList>
                    <TabsTrigger value="timeline">分镜时间线</TabsTrigger>
                    <TabsTrigger value="text">文案编辑</TabsTrigger>
                  </TabsList>
                  <Link href={`${isCloneProject ? `/project/${id}/video` : `/project/${id}/assets`}${effectiveVersionId ? `?versionId=${encodeURIComponent(effectiveVersionId)}` : ""}`}>
                    <Button className="brand-gradient text-white text-sm">
                      {isCloneProject ? "下一步：生成完整视频" : "下一步：生成素材"}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>

                <TabsContent value="timeline" className="mt-0">
                  <div className="space-y-3">
                    {currentScript?.shots.map((shot, index) => {
                      const typeInfo = shotTypeLabels[shot.type];
                      return (
                        <Card key={shot.shotId} className="glass-card overflow-hidden">
                          <CardContent className="p-0">
                            <div className="flex">
                              <div className="flex flex-col items-center justify-center w-16 py-4 border-r border-border/50 shrink-0">
                                <span className="text-lg font-bold text-muted-foreground/50">{String(index + 1).padStart(2, "0")}</span>
                                <Badge className={`${typeInfo.color} border-0 text-[10px] mt-1`}>{typeInfo.label}</Badge>
                                <span className="text-[10px] text-muted-foreground mt-1">{shot.duration}s</span>
                              </div>
                              <div className="flex-1 p-4">
                                <div className="flex items-start justify-between gap-4">
                                  <div className="flex-1">
                                    <p className="text-sm leading-relaxed mb-2">{shot.description}</p>
                                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                      <span className="flex items-center gap-1">
                                        <LuClock className="w-3 h-3" />
                                        {shot.camera}
                                      </span>
                                      <span>{visualSourceLabels[shot.visualSource]}</span>
                                      <button
                                        type="button"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                        onClick={() => openPromptPreview(shot)}
                                      >
                                        <LuFileText className="h-3 w-3" />
                                        英文 prompt 预览
                                      </button>
                                    </div>
                                  </div>
                                  <div className="w-20 h-14 bg-muted/30 rounded-md shrink-0 flex items-center justify-center border border-border/30">
                                    {shot.visualSource === "product_image" ? (
                                      <span className="text-[10px] text-muted-foreground">商品图</span>
                                    ) : (
                                      <LuImage className="w-4 h-4 text-muted-foreground/40" />
                                    )}
                                  </div>
                                </div>
                                {shot.voiceover && (
                                  <div className="mt-3 p-2.5 bg-muted/30 rounded-md">
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                      {shot.voiceover}
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </TabsContent>

                <TabsContent value="text" className="mt-0">
                  <Card className="glass-card">
                    <CardContent className="p-6 space-y-4">
                      <h3 className="font-medium text-sm mb-2">完整分镜中文提示词 / 配音文案</h3>
                      <Label className="text-xs text-muted-foreground">分镜画面、运镜、配音和英文关键帧 prompt</Label>
                      <Textarea
                        className="min-h-[300px] bg-background/50 text-sm leading-relaxed"
                        value={shotPlanText}
                        readOnly
                      />
                      <Label className="text-xs text-muted-foreground">纯配音文案</Label>
                      <Textarea
                        className="min-h-[180px] bg-background/50 text-sm leading-relaxed"
                        value={voiceoverText}
                        readOnly
                      />
                      <p className="text-xs text-muted-foreground">
                        总字数：{voiceoverLength} 字 · 预计时长：{currentScript?.totalDuration || 0}s ·
                        语速：约 {Math.round((voiceoverLength / (currentScript?.totalDuration || 1)) * 10) / 10} 字/秒
                      </p>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        )}
      </main>

      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <Card className="glass-card w-full max-w-md mx-4">
            <CardContent className="p-6 space-y-4">
              <h3 className="text-base font-semibold">保存为模板</h3>
              <p className="text-xs text-muted-foreground">
                保存当前脚本结构为模板，下次可直接套用到其他商品
              </p>
              <Input
                placeholder="模板名称，如：痛点种草-服饰通用"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowSaveDialog(false)}>
                  取消
                </Button>
                <Button size="sm" className="brand-gradient text-white" onClick={doSaveTemplate} disabled={!templateName.trim()}>
                  保存
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
