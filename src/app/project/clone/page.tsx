"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { LumaSelect, ModelChannelSelect } from "@/components/model-channel-select";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceEmbed } from "@/components/workspace-embed-context";
import { buildCompactMethodInstruction, type CloneMethod } from "@/lib/clone-methods";
import { formatOmniDurationPlan, isGrokVideoModel, isSegmentedVideoModel, splitSegmentedVideoDurations, sumOmniDurations } from "@/lib/omni-video";
import { buildProductLockInstruction, useProductLibraryStore, type ProductItem } from "@/lib/stores/product-library-store";
import { getActiveImageChannel, getActiveVideoChannel, getReadyImageChannels, getReadyVideoChannels, useSettingsStore } from "@/lib/stores/settings-store";

interface IdentityReference {
  id: string;
  title: string;
  role: string;
  url: string;
  status: "draft" | "approved" | "archived";
  group: string;
}

interface IdentityPack {
  id: string;
  packName: string;
  description: string;
  references: IdentityReference[];
  identityLock: string;
}

interface ProgressState {
  percent: number;
  message: string;
}

interface CloneResultSummary {
  planPath?: string;
}

const videoModeOptions = [
  { value: "live_presenter", label: "真人/AI 模特出镜" },
  { value: "scene_demo", label: "场景演示" },
  { value: "product_closeup", label: "产品特写" },
  { value: "graphic_montage", label: "图文混剪" },
];

function normalizeDuration(value: string, customValue: string) {
  const raw = value === "custom" ? customValue : value;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(300, Math.max(5, parsed));
}

function buildIdentityInstruction(pack: IdentityPack | null, references: IdentityReference[]) {
  if (!pack || !references.length) return "";
  return [
    `Identity pack: ${pack.packName}`,
    pack.description,
    `Identity Lock: ${pack.identityLock}`,
    "Only use these manually selected, accepted references:",
    ...references.map((ref) => `- ${ref.title}: ${ref.role}, url=${ref.url}`),
    "Do not automatically add the rest of this identity pack. Do not create a new person identity in this workflow.",
  ].join("\n");
}

function buildProductPackageInstruction(product: ProductItem | null, extraRequirements: string) {
  if (!product) return "";
  return [
    "【当前商品库产品包】",
    `商品名称：${product.name}`,
    `商品品类：${product.category}`,
    product.description ? `卖点描述：${product.description}` : "",
    product.targetAudience ? `目标人群：${product.targetAudience}` : "",
    product.usageScenarios ? `适用/展示场景：${product.usageScenarios}` : "",
    product.negativeConstraints ? `商品负面限制：${product.negativeConstraints}` : "",
    extraRequirements ? `本次额外要求：${extraRequirements}` : "",
    buildProductLockInstruction(product),
  ].filter(Boolean).join("\n");
}

function buildProductSummary(product: ProductItem | null, extraRequirements = "") {
  if (!product) return "";
  return [
    "商品基础信息与结构锁已在当前商品库产品包中提供；这里仅补充本次复刻的卖点摘要，避免同一规则重复进入模型。",
    product.description ? `卖点摘要：${product.description}` : "",
    extraRequirements ? "本次额外要求已随商品库产品包传入，不在摘要里重复。" : "",
  ].filter(Boolean).join("\n");
}

function buildCloneAnalysisFromMethod(method: CloneMethod | null) {
  if (!method) return "";
  return [
    "当前爆款复刻项目从方法库生成，不在此页面重新拆解参考视频。",
    `已选择方法库：${method.name}`,
    "方法库完整规则只通过 cloneMethodInstruction 字段传入；本段只保留短摘要，避免同一方法全文重复进入 LLM。",
    method.methodSummary ? `方法短摘要：${method.methodSummary}` : "",
    method.promptFocus ? `方法重点：${method.promptFocus}` : "",
    "来源视频 mp4 和来源转写只作为方法库沉淀时的证据，不在爆款复刻规划阶段重复传给 LLM。",
  ].filter(Boolean).join("\n\n");
}

function CloneProjectWorkspace({
  onProjectCreated,
  embedded = false,
}: {
  onProjectCreated?: (targetPath: string) => void;
  embedded?: boolean;
} = {}) {
  const router = useRouter();
  const { llm, providers } = useSettingsStore();
  const { products, incrementVideoCount } = useProductLibraryStore();

  const [identityPacks, setIdentityPacks] = useState<IdentityPack[]>([]);
  const [selectedIdentityPackId, setSelectedIdentityPackId] = useState("");
  const [selectedIdentityReferenceIds, setSelectedIdentityReferenceIds] = useState<string[]>([]);
  const [cloneMethods, setCloneMethods] = useState<CloneMethod[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [duration, setDuration] = useState("30");
  const [customDuration, setCustomDuration] = useState("");
  const [videoMode, setVideoMode] = useState("live_presenter");
  const [selectedImageChannelId, setSelectedImageChannelId] = useState("");
  const [selectedVideoChannelId, setSelectedVideoChannelId] = useState("");
  const [extraRequirements, setExtraRequirements] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasActivePlan, setHasActivePlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [summary, setSummary] = useState<CloneResultSummary | null>(null);
  const activePlanRef = useRef<{ projectId: string; clientRequestId: string } | null>(null);
  const cancelRequestedRef = useRef(false);

  const openaiSeedance = providers["openai-seedance"];
  const imageChannels = useMemo(
    () => getReadyImageChannels(openaiSeedance, { allowServerManagedCredentials: true }),
    [openaiSeedance],
  );
  const videoChannels = useMemo(() => getReadyVideoChannels(openaiSeedance, "full_video"), [openaiSeedance]);
  const selectedImageChannel = useMemo(
    () => getActiveImageChannel(openaiSeedance, selectedImageChannelId),
    [openaiSeedance, selectedImageChannelId],
  );
  const activeCloneVideoChannel = useMemo(
    () => getActiveVideoChannel(openaiSeedance, selectedVideoChannelId, "full_video"),
    [openaiSeedance, selectedVideoChannelId],
  );
  const effectiveImageModel = selectedImageChannel?.model || "";
  const imageApiKey = selectedImageChannel?.apiKey;
  const imageBaseUrl = selectedImageChannel?.baseUrl;
  const llmReady = Boolean(llm.baseUrl && llm.apiKey && llm.model);
  const imageMissing = [
    !imageApiKey ? "图片 API Key" : "",
    !imageBaseUrl ? "图片 API 地址" : "",
    !effectiveImageModel ? "生图模型" : "",
  ].filter(Boolean).join(" / ");
  const imageReady = Boolean(imageApiKey && imageBaseUrl && effectiveImageModel);
  const fullVideoMissing = [
    !openaiSeedance?.enabled ? "平台开关" : "",
    activeCloneVideoChannel?.enabled === false ? "通道已暂停" : "",
    !activeCloneVideoChannel?.apiKey ? "视频 API Key" : "",
    !activeCloneVideoChannel?.baseUrl ? "视频 API 地址" : "",
    !activeCloneVideoChannel?.model ? "视频模型" : "",
  ].filter(Boolean).join(" / ");
  const fullVideoReady = Boolean(
    openaiSeedance?.enabled &&
    activeCloneVideoChannel?.enabled !== false &&
    activeCloneVideoChannel?.model &&
    activeCloneVideoChannel?.apiKey &&
    activeCloneVideoChannel?.baseUrl
  );

  const cloneStyleMethods = useMemo(
    () => cloneMethods.filter((method) => method.usageMode !== "normal"),
    [cloneMethods],
  );
  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) || null,
    [products, selectedProductId],
  );
  const selectedMethod = useMemo(
    () => cloneMethods.find((method) => method.id === selectedMethodId) || null,
    [cloneMethods, selectedMethodId],
  );
  const identityPack = useMemo(
    () => identityPacks.find((pack) => pack.id === selectedIdentityPackId) || null,
    [identityPacks, selectedIdentityPackId]
  );
  const approvedIdentityReferences = useMemo(
    () => identityPack?.references.filter((reference) => reference.status === "approved") || [],
    [identityPack]
  );
  const selectedIdentityReferences = useMemo(
    () => approvedIdentityReferences.filter((reference) => selectedIdentityReferenceIds.includes(reference.id)),
    [approvedIdentityReferences, selectedIdentityReferenceIds]
  );
  const identityInstruction = useMemo(
    () => buildIdentityInstruction(identityPack, selectedIdentityReferences),
    [identityPack, selectedIdentityReferences]
  );
  const productPackageInstruction = useMemo(
    () => buildProductPackageInstruction(selectedProduct, extraRequirements),
    [selectedProduct, extraRequirements],
  );
  const methodInstruction = useMemo(() => buildCompactMethodInstruction(selectedMethod), [selectedMethod]);
  const cloneAnalysis = useMemo(() => buildCloneAnalysisFromMethod(selectedMethod), [selectedMethod]);
  const effectiveDuration = normalizeDuration(duration, customDuration);
  const isGrokCloneVideoModel = isGrokVideoModel(activeCloneVideoChannel?.model);
  const isSegmentedCloneVideoModel = isSegmentedVideoModel(activeCloneVideoChannel?.model);
  const segmentedModelLabel = isGrokCloneVideoModel ? "Grok" : "Omni";
  const segmentedModelDurationTip = isGrokCloneVideoModel
    ? "Grok each segment must be 6 or 10 seconds"
    : "Omni supports 4/6/8/10 seconds per segment";
  const omniDurationSegments = useMemo(
    () => splitSegmentedVideoDurations(activeCloneVideoChannel?.model, effectiveDuration),
    [activeCloneVideoChannel?.model, effectiveDuration]
  );
  const omniDurationPlan = formatOmniDurationPlan(omniDurationSegments);
  const omniGeneratedDuration = sumOmniDurations(omniDurationSegments);

  const canGenerate = Boolean(
    selectedProduct &&
    selectedProduct.images.length > 0 &&
    selectedMethod &&
    llmReady &&
    imageReady &&
    fullVideoReady &&
    (videoMode !== "live_presenter" || selectedIdentityReferences.length > 0) &&
    !isSubmitting,
  );

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      const [identityRes, methodsRes] = await Promise.all([
        fetch("/api/identity-pack", { cache: "no-store" }),
        fetch("/api/clone-methods", { cache: "no-store" }),
      ]);
      const identityData = await identityRes.json().catch(() => null);
      const methodsData = await methodsRes.json().catch(() => null);
      if (!cancelled) {
        const packs = Array.isArray(identityData?.packs) ? identityData.packs as IdentityPack[] : [];
        setIdentityPacks(packs);
        setSelectedIdentityPackId("");
        const methods = Array.isArray(methodsData?.methods) ? methodsData.methods : [];
        setCloneMethods(methods);
        const firstCloneMethod = methods.find((method: CloneMethod) => method.usageMode !== "normal");
        if (firstCloneMethod) setSelectedMethodId((current) => current || firstCloneMethod.id);
      }
    }
    loadData().catch((err) => setError(err instanceof Error ? err.message : "加载身份包或方法库失败"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedProductId && products[0]) setSelectedProductId(products[0].id);
  }, [products, selectedProductId]);

  useEffect(() => {
    if (selectedImageChannel?.id && !selectedImageChannelId) {
      setSelectedImageChannelId(selectedImageChannel.id);
    }
  }, [selectedImageChannel?.id, selectedImageChannelId]);

  useEffect(() => {
    if (activeCloneVideoChannel?.id && !selectedVideoChannelId) {
      setSelectedVideoChannelId(activeCloneVideoChannel.id);
    }
  }, [activeCloneVideoChannel?.id, selectedVideoChannelId]);

  async function submitCloneProject() {
    if (!canGenerate || !selectedProduct || !selectedMethod) return;
    setIsSubmitting(true);
    setError(null);
    setSummary(null);
    cancelRequestedRef.current = false;
    let planProgressTimer: number | null = null;

    try {
      setProgress({ percent: 10, message: "创建爆款复刻项目..." });
      const projectRes = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${selectedProduct.name} 高相似复刻`,
          productName: selectedProduct.name,
          productCategory: selectedProduct.category === "tech" ? "digital" : selectedProduct.category,
          productDescription: productPackageInstruction,
          productImages: selectedProduct.images,
          productId: selectedProduct.id,
          characterId: selectedIdentityReferenceIds.length > 0 ? selectedIdentityPackId : null,
          identityReferenceIds: selectedIdentityReferenceIds,
          sourceType: "clone",
          sourceVideoUrl: selectedMethod.source || selectedMethod.sourceVideoName || selectedMethod.sourceAnalysisPath || "",
          videoMode,
          videoAspectRatio: "9:16",
          videoResolution: "720p",
          imageChannelId: selectedImageChannel?.id || null,
          videoChannelId: activeCloneVideoChannel?.id || null,
        }),
      });
      const project = await projectRes.json().catch(() => null);
      if (!projectRes.ok || !project?.id) throw new Error(project?.error || "项目创建失败");
      const createdVersionId = project.currentVersion?.id || project.currentVersionId || "";
      const clientRequestId = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      activePlanRef.current = { projectId: project.id, clientRequestId };
      setHasActivePlan(true);

      setProgress({ percent: 35, message: "LLM 正在根据方法库拆解和商品包反推完整视频方案..." });
      planProgressTimer = window.setInterval(() => {
        setProgress((current) => {
          if (!current || current.percent >= 84) return current;
          return {
            percent: Math.min(84, current.percent + 3),
            message: "LLM 正在流式生成爆款复刻规划，已连接模型，请继续等待返回...",
          };
        });
      }, 12000);
      const planRes = await fetch("/api/clone/plan-full-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          versionId: createdVersionId || undefined,
          clientRequestId,
          productName: selectedProduct.name,
          productFeatures: buildProductSummary(selectedProduct, extraRequirements),
          category: selectedProduct.category === "tech" ? "digital" : selectedProduct.category,
          duration: effectiveDuration,
          videoMode,
          productImages: selectedProduct.images,
          cloneAnalysis,
          transcript: "",
          userRequirements: productPackageInstruction,
          cloneMethodInstruction: methodInstruction,
          identityPackInstruction: identityInstruction,
          llmConfig: {
            baseUrl: llm.baseUrl,
            apiKey: llm.apiKey,
            model: llm.model,
            visionModel: llm.visionModel,
          },
        }),
      });
      if (planProgressTimer) {
        window.clearInterval(planProgressTimer);
        planProgressTimer = null;
      }
      const planJson = await planRes.json().catch(() => ({}));
      if (!planRes.ok) throw new Error(planJson.error || "完整视频规划失败");
      activePlanRef.current = null;
      setHasActivePlan(false);

      const cloneContext = {
        type: "high_similarity_clone",
        source: "method_library",
        selectedMethodId: selectedMethod.id,
        selectedMethodName: selectedMethod.name,
        selectedProductId: selectedProduct.id,
        identitySelection: selectedIdentityReferenceIds.length > 0 ? {
          packId: selectedIdentityPackId,
          referenceIds: selectedIdentityReferenceIds,
        } : null,
        transcript: "",
        referenceAnalysis: cloneAnalysis,
        methodLibraryInstruction: methodInstruction,
        identityPackInstruction: identityInstruction,
        productPackageInstruction,
        plan: planJson.plan || {},
        generatedAssetPackage: [],
        generatedAssetManifestPath: null,
        savedMarkdownPath: {
          plan: planJson.savedMarkdownPath,
        },
      };

      setProgress({ percent: 88, message: "正在保存爆款复刻方案，准备进入预览确认页..." });
      const savePlanRes = await fetch(`/api/project/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "scripting",
          versionId: createdVersionId || undefined,
          productAnalysis: JSON.stringify({
            productVisualAnalysis: planJson.plan?.productVisualAnalysis || null,
            productStructureLock: planJson.plan?.productStructureLock || null,
            cloneWorkflow: cloneContext,
          }, null, 2),
        }),
      });
      const savePlanJson = await savePlanRes.json().catch(() => ({}));
      if (!savePlanRes.ok) throw new Error(savePlanJson.error || "爆款复刻方案保存失败");

      incrementVideoCount(selectedProduct.id);
      setSummary({ planPath: planJson.savedMarkdownPath });
      setProgress({
        percent: 100,
        message: onProjectCreated ? "爆款复刻方案已生成，项目已加入工作台。" : "爆款复刻方案已生成，正在进入预览确认页...",
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      const targetPath = `/project/${project.id}/script${createdVersionId ? `?versionId=${encodeURIComponent(createdVersionId)}` : ""}`;
      if (onProjectCreated) {
        onProjectCreated(targetPath);
      } else {
        router.push(targetPath);
      }
    } catch (err) {
      if (planProgressTimer) {
        window.clearInterval(planProgressTimer);
      }
      activePlanRef.current = null;
      setHasActivePlan(false);
      setError(cancelRequestedRef.current ? "已取消本次高相似复刻生成。" : err instanceof Error ? err.message : "爆款复刻项目生成失败");
      setIsSubmitting(false);
      setProgress(null);
    }
  }

  async function cancelClonePlanning() {
    const activePlan = activePlanRef.current;
    if (!activePlan) return;
    cancelRequestedRef.current = true;
    setProgress({ percent: 100, message: "正在取消本次 LLM 规划请求..." });
    try {
      await fetch("/api/clone/plan-full-video", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activePlan),
      });
    } catch {
      // The running POST will surface the final cancelled state.
    }
  }

  return (
    <div className="min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            {embedded ? (
              <Button type="button" variant="ghost" size="sm" className="hidden">
                <span className="mr-1.5 text-xl">←</span>
                返回工作台
              </Button>
            ) : (
              <Link href="/workspace?module=clone">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                <span className="text-xl">←</span>
              </Button>
              </Link>
            )}
            <div className="flex h-8 w-8 items-center justify-center rounded-lg brand-gradient text-sm font-bold text-white">AI</div>
            <span className="text-lg font-bold tracking-tight">流光商影</span>
          </div>
          <Badge variant="secondary">方法库驱动爆款复刻</Badge>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 text-center">
          <h1 className="mb-3 text-3xl font-bold tracking-tight">
            <span className="brand-gradient-text">爆款复刻</span>
          </h1>
          <p className="mx-auto max-w-3xl text-base text-muted-foreground">
            这里不再临时拆参考视频。请先在方法库拆解参考视频并沉淀方法，再在这里选择商品库产品包、复刻方法、身份包和视频配置，系统会按方法库拆解结果反推资产并生成完整视频方案。
          </p>
        </div>

        <Card className="mb-8 glass-card">
          <CardContent className="grid gap-3 p-5 md:grid-cols-4">
            <StatusPill label="LLM 脚本/规划" ready={llmReady} detail={llm.model || "未配置"} />
            <StatusPill label="生图模型" ready={imageReady} detail={imageReady ? selectedImageChannel?.name || effectiveImageModel : `缺少：${imageMissing || "未知"}`} />
            <StatusPill label="视频模型" ready={fullVideoReady} detail={fullVideoReady ? activeCloneVideoChannel?.name || activeCloneVideoChannel?.model || "已配置" : `缺少：${fullVideoMissing || "未知"}`} />
            <StatusPill label="全局身份包" ready={Boolean(identityPack?.references?.length)} detail={`${identityPack?.references?.length || 0} 张参考`} />
          </CardContent>
        </Card>

        <Card className="mb-8 glass-card">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">人物身份包与参考图</h2>
                <p className="mt-1 text-sm text-muted-foreground">先选择一个人物包，再手动勾选本次复刻要使用的已通过图片。不会自动带入整套人物包。</p>
              </div>
              <Badge variant="secondary">已选 {selectedIdentityReferences.length} 张</Badge>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[280px_1fr]">
              <LumaSelect
                value={selectedIdentityPackId}
                onChange={(packId) => {
                  setSelectedIdentityPackId(packId);
                  setSelectedIdentityReferenceIds([]);
                }}
                emptyLabel="暂无人物包"
                ariaLabel="爆款复刻人物包"
                options={identityPacks.map((pack) => ({ value: pack.id, label: pack.packName, detail: `${pack.references.filter((reference) => reference.status === "approved").length} 张已通过` }))}
              />
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {approvedIdentityReferences.map((reference) => {
                  const checked = selectedIdentityReferenceIds.includes(reference.id);
                  return <label key={reference.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition ${checked ? "border-cyan-200/55 bg-cyan-200/[0.10]" : "border-border/50 bg-background/35"}`}>
                    <input type="checkbox" checked={checked} onChange={() => setSelectedIdentityReferenceIds((current) => checked ? current.filter((id) => id !== reference.id) : [...current, reference.id])} className="mt-0.5" />
                    <span><span className="block text-sm font-medium">{reference.title}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{reference.role}</span></span>
                  </label>;
                })}
                {!approvedIdentityReferences.length && <p className="text-sm text-amber-600">此人物包没有已通过的参考图，请先到人物身份包验收。</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="mb-8 grid gap-6 md:grid-cols-2">
          <Card className="glass-card">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">选择商品库产品包</h2>
                  <p className="mt-1 text-xs text-muted-foreground">商品图和基础信息从商品库读取；结构锁由 LLM 根据商品图自动反推。</p>
                </div>
                <Link href={embedded ? "/workspace?module=products" : "/products"} className="text-xs text-primary hover:underline">管理商品库</Link>
              </div>
              {products.length === 0 ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
                  还没有产品包。请先去商品库添加商品图片和信息。
                </div>
              ) : (
                <div className="space-y-3">
                  {products.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => setSelectedProductId(product.id)}
                      className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-all ${
                        selectedProductId === product.id
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border/40 bg-muted/40">
                        {product.images[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={product.images[0]} alt={product.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">无图</div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{product.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{product.description || "暂无卖点描述"}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground/80">{product.images.length} 张图 · {product.category}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">选择复刻方法</h2>
                  <p className="mt-1 text-xs text-muted-foreground">方法来自方法库拆解记录，会同步作为脚本风格。</p>
                </div>
                <Link href={embedded ? "/workspace?module=methods" : "/clone-methods"} className="text-xs text-primary hover:underline">去方法库拆解</Link>
              </div>
              {cloneStyleMethods.length === 0 ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
                  还没有适合爆款复刻的方法。请先在方法库用参考视频拆解并保存方法。
                </div>
              ) : (
                <div className="space-y-3">
                  {cloneStyleMethods.map((method) => (
                    <button
                      key={method.id}
                      type="button"
                      onClick={() => setSelectedMethodId(method.id)}
                      className={`w-full rounded-lg border p-3 text-left transition-all ${
                        selectedMethodId === method.id
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium">{method.styleShortName || method.name}</p>
                        <Badge variant="outline">{method.usageMode || "both"}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{method.description}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground/80">
                        结构拆解 {method.videoStructureBreakdown?.length || 0} 条 · 资产规则 {method.assetNeeds.length} 条
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="mb-8 glass-card">
          <CardContent className="space-y-5 p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="duration">目标时长</Label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: "10", label: "10 秒" },
                    { value: "15", label: "15 秒" },
                    { value: "30", label: "30 秒" },
                    { value: "60", label: "60 秒" },
                    { value: "120", label: "120 秒" },
                    { value: "custom", label: "自定义" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setDuration(option.value)}
                      className={`h-10 rounded-md border px-3 text-sm transition-all ${
                        duration === option.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-input bg-background text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {duration === "custom" && (
                  <div>
                    <input
                      type="number"
                      min={5}
                      max={300}
                      value={customDuration}
                      onChange={(event) => setCustomDuration(event.target.value)}
                      placeholder="例如 20、45、90"
                      className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      当前会按 {effectiveDuration} 秒提交，建议 5-300 秒。
                    </p>
                  </div>
                )}
                {isSegmentedCloneVideoModel && (
                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
                    <p className="font-medium text-foreground">{segmentedModelLabel} 拆段预览：{effectiveDuration} 秒 → {omniDurationPlan}</p>
                    <p className="mt-1">
                      执行时会先让 LLM 写完一篇完整 {effectiveDuration} 秒英文导演稿，再按这个顺序拆成 {segmentedModelLabel} 任务；素材页每段生成 7 张资产图，视频页会试验追加 1 张商品正面结构锁图，生成后由 FFmpeg 按顺序合成。
                    </p>
                    <p className="mt-1">{segmentedModelDurationTip}。</p>
                    {omniGeneratedDuration > effectiveDuration && (
                      <p className="mt-1 text-amber-600">
                        {segmentedModelLabel} 实际会生成 {omniGeneratedDuration} 秒，合成后自动裁到目标 {effectiveDuration} 秒。
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="video-mode">视频模式</Label>
                <LumaSelect
                  id="video-mode"
                  value={videoMode}
                  onChange={setVideoMode}
                  emptyLabel="选择视频模式"
                  ariaLabel="视频模式"
                  options={videoModeOptions.map((option) => ({ value: option.value, label: option.label }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="image-channel">资产包生图模型</Label>
                <ModelChannelSelect
                  id="image-channel"
                  value={selectedImageChannel?.id || selectedImageChannelId}
                  onChange={setSelectedImageChannelId}
                  emptyLabel="未配置生图模型"
                  ariaLabel="资产包生图模型"
                  options={imageChannels.map((channel) => ({ id: channel.id, label: channel.name || channel.model || channel.id }))}
                />
                <p className="text-[11px] text-muted-foreground">
                  用于人物多视图、产品结构图、首帧锚图和场景锚图。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="video-channel">完整视频模型</Label>
                <ModelChannelSelect
                  id="video-channel"
                  value={activeCloneVideoChannel?.id || selectedVideoChannelId}
                  onChange={setSelectedVideoChannelId}
                  emptyLabel="未配置视频模型"
                  ariaLabel="完整视频模型"
                  options={videoChannels.map((channel) => ({ id: channel.id, label: channel.name || channel.model || channel.id, detail: channel.model || undefined }))}
                />
                <p className="text-[11px] text-muted-foreground">
                  来自设置页的视频模型池，本次任务类型为完整视频。
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="extra-requirements">本次额外要求（可选）</Label>
              <Textarea
                id="extra-requirements"
                rows={4}
                value={extraRequirements}
                onChange={(event) => setExtraRequirements(event.target.value)}
                placeholder="例如：更强调腰线比例、口播更像朋友推荐、动作不要太慢、场景更像真实手机记录等"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardContent className="p-5 text-sm text-muted-foreground">
            <div className="mb-2 font-medium text-foreground">执行顺序</div>
            <p>1. 读取商品库产品包和方法库结构拆解；2. LLM 反推复刻脚本、仿写音频和资产计划；3. 用本次选择的生图模型生成辅助资产包；4. 进入项目脚本预览；5. 你确认后到视频页用视频模型池生成成片。</p>
          </CardContent>
        </Card>

        {error && <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}
        {!canGenerate && (
          <div className="mb-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700">
            需要同时满足：商品库有产品包、方法库有复刻方法，并完成 LLM、生图模型、视频模型接口配置。
          </div>
        )}
        {progress && (
          <div className="mb-6 rounded-lg border border-border/60 bg-background/50 p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span>{progress.message}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full brand-gradient transition-all duration-500" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}
        {summary && (
          <Card className="mb-6 glass-card">
            <CardContent className="space-y-2 p-4 text-sm">
              <div>完整视频规划：{summary.planPath}</div>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap justify-center gap-3 pb-10">
          <Button size="lg" className="brand-gradient px-10 text-base font-semibold text-white" disabled={!canGenerate || isSubmitting} onClick={submitCloneProject}>
            {isSubmitting ? "正在生成脚本预览..." : "开始高相似复刻"}
          </Button>
          {isSubmitting && hasActivePlan && (
            <Button size="lg" variant="outline" className="px-8 text-base font-semibold" onClick={cancelClonePlanning}>
              取消生成
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}

function StatusPill({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge className={ready ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-600"}>
          {ready ? "已就绪" : "未就绪"}
        </Badge>
      </div>
      <p className="truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function ClonePage() {
  const { embedded, onProjectCreated } = useWorkspaceEmbed();
  return <CloneProjectWorkspace embedded={embedded} onProjectCreated={onProjectCreated} />;
}
