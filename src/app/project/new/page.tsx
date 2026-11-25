"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LuArrowLeft, LuCircleAlert, LuZap, LuBox, LuLayoutGrid, LuEye, LuVideo, LuBookmark } from "react-icons/lu";
import { useTemplateStore } from "@/lib/stores/template-store";
import { getReadyImageChannels, getReadyVideoChannels, useSettingsStore } from "@/lib/stores/settings-store";
import { buildProductLockInstruction, useProductLibraryStore, type ProductItem } from "@/lib/stores/product-library-store";
import { buildCompactMethodInstruction, type CloneMethod } from "@/lib/clone-methods";
import { joinUniqueTextSections } from "@/lib/prompt-dedup";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LumaSelect, ModelChannelSelect } from "@/components/model-channel-select";
import { useWorkspaceEmbed } from "@/components/workspace-embed-context";

type IdentityReference = { id: string; title: string; role: string; status: "draft" | "approved" | "archived"; group: string };
type IdentityPack = { id: string; packName: string; references: IdentityReference[] };

// 目标时长选项
const durationOptions = [
  { value: "10", label: "10s" },
  { value: "15", label: "15s" },
  { value: "30", label: "30s" },
  { value: "60", label: "60s" },
  { value: "custom", label: "自定义" },
];

const aspectRatioOptions = [
  { value: "9:16", label: "竖屏 9:16", desc: "抖音/快手默认推荐" },
  { value: "16:9", label: "横屏 16:9", desc: "横版素材或多平台复用" },
] as const;

const resolutionOptions = [
  { value: "720p", label: "720p", desc: "适合模型名包含 720p 的视频通道" },
  { value: "1080p", label: "1080p", desc: "仅在视频模型明确支持 1080p 时使用" },
] as const;

function recommendedResolution(model?: string): "720p" | "1080p" {
  return /1080/i.test(model ?? "") ? "1080p" : "720p";
}

function normalizeDuration(value: string, customValue: string) {
  const raw = value === "custom" ? customValue : value;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(300, Math.max(5, parsed));
}

// 脚本风格选项
const styleOptions = [
  { value: "auto", label: "智能推荐（LLM 判断）", desc: "由 LLM 根据商品图、卖点和视频模式判断" },
  { value: "pain-point", label: "痛点种草（强制）", desc: "直击用户痛点，激发购买欲" },
  { value: "scenario", label: "场景安利（强制）", desc: "真实场景展示，沉浸式种草" },
  { value: "comparison", label: "对比测评（强制）", desc: "横向对比突出优势" },
  { value: "story", label: "剧情故事（强制）", desc: "故事化包装，增强代入感" },
];

const styleDecisionNotes: Record<string, { title: string; desc: string }> = {
  auto: {
    title: "当前为智能推荐：让 LLM 判断脚本风格",
    desc: "生成时会先结合商品图视觉分析、商品库信息、卖点、视频模式和目标人群，再自动落到痛点种草、场景安利、对比测评或剧情故事之一。",
  },
  "pain-point": {
    title: "当前为手动指定：痛点种草",
    desc: "LLM 不再自行换风格，会按痛点引入、产品解决、效果证明、行动转化的结构生成。",
  },
  scenario: {
    title: "当前为手动指定：场景安利",
    desc: "LLM 不再自行换风格，会按生活场景、自然上身/使用、细节展示、分享推荐的结构生成。",
  },
  comparison: {
    title: "当前为手动指定：对比测评",
    desc: "LLM 不再自行换风格，会按提出问题、横向对比、差异证明、推荐结论的结构生成。",
  },
  story: {
    title: "当前为手动指定：剧情故事",
    desc: "LLM 不再自行换风格，会按人物处境、冲突转折、产品解决、情绪反转的结构生成。",
  },
};

function NewProjectWorkspace({
  onProjectCreated,
  embedded = false,
}: {
  onProjectCreated?: (targetPath: string) => void;
  embedded?: boolean;
} = {}) {
  const router = useRouter();

  // 检查 LLM API 配置状态
  const { llm, providers } = useSettingsStore();
  const modelProvider = providers["openai-seedance"];
  const imageChannels = useMemo(
    () => getReadyImageChannels(modelProvider, { allowServerManagedCredentials: true }),
    [modelProvider],
  );
  const videoChannels = useMemo(() => getReadyVideoChannels(modelProvider, "shot_clip"), [modelProvider]);
  const isLLMConfigured = llm.apiKey.length > 0;

  // 表单状态
  const [productName, setProductName] = useState("");
  const [category, setCategory] = useState<string>("");
  const [sellingPoints, setSellingPoints] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [duration, setDuration] = useState("30");
  const [customDuration, setCustomDuration] = useState("");
  const [scriptStyle, setScriptStyle] = useState("auto");
  const [cloneMethods, setCloneMethods] = useState<CloneMethod[]>([]);
  const [selectedCloneMethodId, setSelectedCloneMethodId] = useState<string>("none");
  const [videoMode, setVideoMode] = useState<string>("product_closeup");
  const [videoAspectRatio, setVideoAspectRatio] = useState<"9:16" | "16:9">("9:16");
  const [videoResolution, setVideoResolution] = useState<"720p" | "1080p">("720p");
  const [selectedImageChannelId, setSelectedImageChannelId] = useState("");
  const [selectedVideoChannelId, setSelectedVideoChannelId] = useState("");
  const [identityPacks, setIdentityPacks] = useState<IdentityPack[]>([]);
  const [selectedIdentityPackId, setSelectedIdentityPackId] = useState("");
  const [selectedIdentityReferenceIds, setSelectedIdentityReferenceIds] = useState<string[]>([]);

  // 新增字段状态
  const [priceRange, setPriceRange] = useState<string>("");
  const [targetAudience, setTargetAudience] = useState<string[]>([]);
  const platforms = ["douyin"];
  const [usageAdvantage, setUsageAdvantage] = useState("");

  // 模板库
  const { templates, incrementUseCount } = useTemplateStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // 商品库
  const { products, incrementVideoCount } = useProductLibraryStore();

  // 图片上传状态（本地模拟）
  const [images, setImages] = useState<{ id: string; url: string; file?: File }[]>([]);

  const selectedIdentityPack = useMemo(
    () => identityPacks.find((pack) => pack.id === selectedIdentityPackId) || null,
    [identityPacks, selectedIdentityPackId]
  );
  const approvedIdentityReferences = useMemo(
    () => selectedIdentityPack?.references.filter((reference) => reference.status === "approved") || [],
    [selectedIdentityPack]
  );

  // 提交状态
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    step: string;
    percent: number;
    message: string;
  } | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/identity-pack", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const packs = Array.isArray(data.packs) ? data.packs as IdentityPack[] : [];
        setIdentityPacks(packs);
        setSelectedIdentityPackId("");
      })
      .catch(() => {
        if (!cancelled) setIdentityPacks([]);
      });
    return () => { cancelled = true; };
  }, []);

  const selectedCloneMethod = useMemo(
    () => cloneMethods.find((method) => method.id === selectedCloneMethodId) || null,
    [cloneMethods, selectedCloneMethodId]
  );
  const scriptStyleMethods = useMemo(
    () => cloneMethods.filter((method) => method.usageMode !== "clone"),
    [cloneMethods]
  );
  const selectedImageChannel = useMemo(
    () => imageChannels.find((channel) => channel.id === selectedImageChannelId) ?? imageChannels[0] ?? null,
    [imageChannels, selectedImageChannelId]
  );
  const selectedVideoChannel = useMemo(
    () => videoChannels.find((channel) => channel.id === selectedVideoChannelId) ?? videoChannels[0] ?? null,
    [videoChannels, selectedVideoChannelId]
  );
  const selectedVideoModel = selectedVideoChannel?.model || "";
  const recommendedVideoResolution = recommendedResolution(selectedVideoModel);
  const selectedModelForces720p = /720/i.test(selectedVideoModel);
  const effectiveDuration = normalizeDuration(duration, customDuration);

  useEffect(() => {
    if (selectedImageChannel?.id && !selectedImageChannelId) {
      setSelectedImageChannelId(selectedImageChannel.id);
    }
  }, [selectedImageChannel?.id, selectedImageChannelId]);

  useEffect(() => {
    if (selectedVideoChannel?.id && !selectedVideoChannelId) {
      setSelectedVideoChannelId(selectedVideoChannel.id);
    }
  }, [selectedVideoChannel?.id, selectedVideoChannelId]);

  useEffect(() => {
    if (videoResolution !== recommendedVideoResolution) {
      setVideoResolution(recommendedVideoResolution);
    }
  }, [recommendedVideoResolution, videoResolution]);

  const buildTemplateHint = () => {
    if (!selectedTemplateId) return undefined;
    const tpl = templates.find((item) => item.id === selectedTemplateId);
    if (!tpl) return undefined;
    const shotSummary = tpl.shots
      .map((shot) => `${shot.shotId || ""}. ${shot.type} / ${shot.duration}s / ${shot.voiceover || shot.description || ""}`.trim())
      .slice(0, 8)
      .join("\n");

    return [
      "套用用户选择的爆款模板结构，但不要照搬原商品内容。",
      `模板名称：${tpl.name}`,
      tpl.description ? `模板说明：${tpl.description}` : "",
      `模板视频模式：${tpl.videoMode || "未指定"}`,
      `模板脚本风格：${tpl.styleType || "未指定"}`,
      `模板总时长：${tpl.totalDuration || "未指定"}秒`,
      shotSummary ? `模板分镜节奏：\n${shotSummary}` : "",
    ].filter(Boolean).join("\n");
  };

  const buildProductLibraryHint = () => {
    if (!selectedProductId) return undefined;
    const product = products.find((item) => item.id === selectedProductId);
    if (!product) return undefined;
    return [
      "该项目来自商品库。商品卖点、人群、场景等已通过独立字段传入，本段只提供商品库身份与结构锁，避免重复覆盖。",
      `商品库 ID：${product.id}`,
      `商品库名称：${product.name}`,
      `商品库类目：${product.category}`,
      buildProductLockInstruction(product),
    ].filter(Boolean).join("\n");
  };

  const applyProduct = (product: ProductItem) => {
    setSelectedProductId(product.id);
    setProductName(product.name);
    setCategory(product.category === "tech" ? "digital" : product.category);
    setSellingPoints(product.description || "");
    setPriceRange("");
    setTargetAudience(product.targetAudience ? [product.targetAudience] : []);
    setUsageAdvantage([product.usageScenarios, product.negativeConstraints].filter(Boolean).join("\n\n"));
    setImages(
      product.images.slice(0, 5).map((url) => ({
        id: crypto.randomUUID(),
        url,
      }))
    );
  };

  const clearProduct = () => {
    setSelectedProductId(null);
    setProductName("");
    setCategory("");
    setSellingPoints("");
    setPriceRange("");
    setTargetAudience([]);
    setUsageAdvantage("");
    setImages([]);
  };

  const imageToFile = async (
    image: { id: string; url: string; file?: File },
    index: number
  ): Promise<File> => {
    if (image.file) return image.file;
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`商品库图片读取失败，请重新上传第 ${index + 1} 张图片`);
    }
    const blob = await response.blob();
    const ext = blob.type.split("/")[1] || "png";
    return new File([blob], `product-library-${index + 1}.${ext}`, {
      type: blob.type || "image/png",
    });
  };

  // 表单校验
  const isValid = Boolean(
    selectedProductId && productName.trim().length > 0 && images.length >= 1
    && (videoMode !== "live_presenter" || (selectedIdentityPackId && selectedIdentityReferenceIds.length > 0))
  );

  // 提交处理
  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // 第1步：创建项目（先拿到 projectId）
      setProgress({ step: "creating", percent: 15, message: "正在创建项目..." });
      const projectRes = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${productName} 推广`,
          productName,
          productCategory: category,
          productDescription: sellingPoints,
          productImages: [],
          productId: selectedProductId,
          templateId: selectedTemplateId,
          characterId: selectedIdentityReferenceIds.length > 0 ? selectedIdentityPackId : null,
          identityReferenceIds: selectedIdentityReferenceIds,
          videoMode,
          videoAspectRatio,
          videoResolution,
          imageChannelId: selectedImageChannel?.id || null,
          videoChannelId: selectedVideoChannel?.id || null,
        }),
      });
      if (!projectRes.ok) {
        const errData = await projectRes.json().catch(() => ({}));
        throw new Error(errData.error || "项目创建失败，请重试");
      }
      const project = await projectRes.json();
      const createdVersionId = project.currentVersion?.id || project.currentVersionId || "";

      // 第2步：上传图片（携带 projectId）
      setProgress({ step: "uploading", percent: 35, message: "正在上传商品图片..." });
      const formData = new FormData();
      const uploadFiles = await Promise.all(images.map(imageToFile));
      uploadFiles.forEach((file) => formData.append("files", file));
      formData.append("projectId", project.id);
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const errData = await uploadRes.json().catch(() => ({}));
        throw new Error(errData.error || "图片上传失败，请检查网络后重试");
      }
      const { paths } = await uploadRes.json();

      // 第2.5步：更新项目的图片路径
      await fetch(`/api/project/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productImages: paths,
        }),
      });

      // 第3步：生成脚本
      setProgress({ step: "generating", percent: 60, message: "AI 正在分析商品并生成脚本..." });
      const cloneMethodHint = selectedCloneMethod
        ? [
            "用户在脚本风格中选择了高相似复刻方法，请把它作为脚本结构和提示词导演规则。",
            "这不是参考视频拆解，不要假设有来源视频；只复用方法库里的场景、动作、资产反推和导演稿规则。",
            buildCompactMethodInstruction(selectedCloneMethod),
          ].join("\n\n")
        : undefined;
      const extraRequirements = joinUniqueTextSections([buildProductLibraryHint(), buildTemplateHint(), cloneMethodHint]);

      const scriptRes = await fetch("/api/llm/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          versionId: createdVersionId || undefined,
          productName,
          category,
          productDescription: sellingPoints,
          targetDuration: effectiveDuration,
          styleType: selectedCloneMethod ? "custom" : scriptStyle,
          videoMode,
          videoAspectRatio,
          videoResolution,
          productImages: paths,
          forceProductAnalysis: true,
          productId: selectedProductId,
          llmConfig: {
            baseUrl: llm.baseUrl,
            apiKey: llm.apiKey,
            model: llm.model,
            visionModel: llm.visionModel,
          },
          priceRange,
          targetAudience: targetAudience.join(","),
          platforms: platforms.join(","),
          usageAdvantage,
          customRequirements: extraRequirements || undefined,
          // 传入选中的模板 ID
          ...(selectedTemplateId && { templateId: selectedTemplateId }),
        }),
      });

      // 使用了模板时递增使用次数
      if (selectedTemplateId) {
        incrementUseCount(selectedTemplateId);
      }
      if (!scriptRes.ok) {
        const errData = await scriptRes.json().catch(() => ({}));
        throw new Error(errData.error || "脚本生成失败，请检查 LLM 设置后重试");
      }
      if (selectedProductId) {
        incrementVideoCount(selectedProductId);
      }

      // 第4步：完成
      setProgress({
        step: "done",
        percent: 100,
        message: onProjectCreated ? "脚本生成完成，项目已加入工作台。" : "脚本生成完成！正在跳转...",
      });
      await new Promise((r) => setTimeout(r, 800));
      const targetPath = `/project/${project.id}/script${createdVersionId ? `?versionId=${encodeURIComponent(createdVersionId)}` : ""}`;
      if (onProjectCreated) {
        onProjectCreated(targetPath);
      } else {
        router.push(targetPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
      setIsSubmitting(false);
      setProgress(null);
    }
  };

  return (
    <div className="min-h-screen grid-bg">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            {/* 返回按钮 */}
            {embedded ? (
              <Button type="button" variant="ghost" size="sm" className="hidden">
                <LuArrowLeft className="w-4 h-4" />
                <span className="ml-1">返回工作台</span>
              </Button>
            ) : (
              <Link href="/workspace?module=new">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground -ml-2">
                <LuArrowLeft className="w-4 h-4" />
                <span className="ml-1">返回</span>
              </Button>
              </Link>
            )}
            <div className="h-5 w-px bg-border/50" />
            {/* Logo */}
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md brand-gradient">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </div>
              <span className="text-sm font-semibold tracking-tight">流光商影</span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-10">
        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">
            新建<span className="brand-gradient-text">带货项目</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            优先选择商品库产品包，再选择脚本风格或方法库风格生成普通分镜项目
          </p>
        </div>

        {/* LLM 未配置警告 */}
        {!isLLMConfigured && (
          <Link href="/settings">
            <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 cursor-pointer hover:bg-amber-100 transition-colors">
              <LuCircleAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-900">请先配置 LLM 服务</p>
                <p className="text-xs text-amber-700 mt-0.5">脚本生成需要 LLM（如 GPT-4o），请先在设置中配置 API Key。<span className="underline">前往设置 →</span></p>
              </div>
            </div>
          </Link>
        )}

        <div className="space-y-6">
          {(
            <Card className="glass-card">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <LuBox className="w-4 h-4 text-primary" />
                      <span className="text-sm font-semibold">选择商品库产品包</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      选择后会自动读取商品图、卖点、人群、使用场景和负面限制；结构锁由 LLM 看图反推
                    </p>
                  </div>
                  {selectedProductId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={clearProduct}
                    >
                      清除产品包
                    </Button>
                  )}
                </div>
                {products.length === 0 ? (
                  <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700">
                    商品库还没有产品包。请先去商品库添加商品图片和必要信息，再回来创建项目；结构锁会在生成时自动反推。
                    <Link href={embedded ? "/workspace?module=products" : "/products"} className="ml-1 text-primary hover:underline">
                      去商品库
                    </Link>
                  </div>
                ) : !selectedProductId && (
                  <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700">
                    当前未绑定产品包。普通项目现在只从商品库读取商品图和商品信息，避免脚本、分镜图和视频用错商品结构。
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {products.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => applyProduct(product)}
                      className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-all ${
                        selectedProductId === product.id
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted/40 border border-border/40">
                        {product.images[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={product.images[0]}
                            alt={product.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <LuBox className="h-5 w-5 text-muted-foreground/50" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{product.name}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {product.description || "暂无卖点描述"}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                          <span>{product.category}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 视频配置（目标时长 + 视频模式） */}
          <Card className="glass-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">2</span>
                <span className="text-sm font-semibold">选择视频配置</span>
              </div>

              {/* 目标时长 */}
              <Label className="text-sm font-medium mb-3 block">目标时长</Label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {durationOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDuration(opt.value)}
                    className={`relative flex items-center justify-center h-11 rounded-lg border text-sm font-medium transition-all ${
                      duration === opt.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                    {/* 选中指示器 */}
                    {duration === opt.value && (
                      <div className="absolute -top-px -right-px h-4 w-4 flex items-center justify-center">
                        <div className="h-2 w-2 rounded-full brand-gradient" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
              {duration === "custom" && (
                <div className="mt-3">
                  <Label htmlFor="custom-duration" className="mb-1.5 text-xs text-muted-foreground">
                    自定义时长（秒）
                  </Label>
                  <input
                    id="custom-duration"
                    type="number"
                    min={5}
                    max={300}
                    value={customDuration}
                    onChange={(event) => setCustomDuration(event.target.value)}
                    placeholder="例如 20、45、90"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    当前会按 {effectiveDuration} 秒提交，建议 5-300 秒。
                  </p>
                </div>
              )}

              {/* 分隔线 */}
              <div className="my-5 border-t border-border/40" />

              {/* 视频模式 */}
              <div className="mb-3 flex items-center justify-between gap-3">
                <Label className="text-sm font-medium">视频画质设置（选填）</Label>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                  推荐：{videoAspectRatio} / {recommendedVideoResolution}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {aspectRatioOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setVideoAspectRatio(opt.value)}
                    className={`relative flex flex-col items-start rounded-lg border p-3 text-left transition-all ${
                      videoAspectRatio === opt.value
                        ? "border-primary bg-primary/10"
                        : "border-border/50 bg-muted/20 hover:border-primary/40"
                    }`}
                  >
                    <span className={`text-sm font-medium ${videoAspectRatio === opt.value ? "text-primary" : "text-foreground"}`}>
                      {opt.label}
                    </span>
                    <span className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</span>
                    {videoAspectRatio === opt.value && (
                      <div className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full brand-gradient" />
                    )}
                  </button>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {resolutionOptions.map((opt) => {
                  const recommended = opt.value === recommendedVideoResolution;
                  const disabled = selectedModelForces720p && opt.value === "1080p";
                  return (
                    <button
                      key={opt.value}
                      disabled={disabled}
                      onClick={() => setVideoResolution(opt.value)}
                      className={`relative flex flex-col items-start rounded-lg border p-3 text-left transition-all ${
                        videoResolution === opt.value
                          ? "border-primary bg-primary/10"
                          : disabled
                            ? "cursor-not-allowed border-border/30 bg-muted/10 opacity-60"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <span className={`text-sm font-medium ${videoResolution === opt.value ? "text-primary" : "text-foreground"}`}>
                        {opt.label}{recommended ? "（推荐）" : ""}
                      </span>
                      <span className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</span>
                      {videoResolution === opt.value && (
                        <div className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full brand-gradient" />
                      )}
                    </button>
                  );
                })}
              </div>
              {videoResolution === "1080p" && !selectedModelForces720p && (
                <p className="mt-2 text-xs leading-relaxed text-amber-600">
                  请确认当前选择的视频模型支持 1080p；如果模型实际只支持 720p，后续视频页会自动降回 720p。
                </p>
              )}
              {selectedModelForces720p && (
                <p className="mt-2 text-xs leading-relaxed text-amber-600">
                  当前选择的视频模型包含 720p 标记，项目会推荐并锁定 720p，避免后续生成无预览或任务失败。
                </p>
              )}

              <div className="my-5 border-t border-border/40" />

              <div className="mb-3 flex items-center justify-between gap-3">
                <Label className="text-sm font-medium">本项目模型选择</Label>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  来自设置页已开启模型池
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3">
                  <Label htmlFor="image-channel" className="text-xs text-muted-foreground">关键帧生图模型</Label>
                  <ModelChannelSelect
                    id="image-channel"
                    value={selectedImageChannel?.id || selectedImageChannelId}
                    onChange={setSelectedImageChannelId}
                    emptyLabel="未配置生图模型"
                    ariaLabel="关键帧生图模型"
                    options={imageChannels.map((channel) => ({ id: channel.id, label: channel.name || channel.model || channel.id }))}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    用于后续素材页生成分镜关键帧。
                  </p>
                </div>
                <div className="space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3">
                  <Label htmlFor="video-channel" className="text-xs text-muted-foreground">分镜视频模型</Label>
                  <ModelChannelSelect
                    id="video-channel"
                    value={selectedVideoChannel?.id || selectedVideoChannelId}
                    onChange={setSelectedVideoChannelId}
                    emptyLabel="未配置视频模型"
                    ariaLabel="分镜视频模型"
                    options={videoChannels.map((channel) => ({ id: channel.id, label: channel.name || channel.model || channel.id, detail: channel.model || undefined }))}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    用于后续视频页生成单镜头片段。
                  </p>
                </div>
              </div>
              {(!imageChannels.length || !videoChannels.length) && (
                <p className="mt-2 text-xs leading-relaxed text-amber-600">
                  设置页还没有开启且配置完整的生图/视频模型，本项目会先保存配置，后续生成前需要补齐模型。
                </p>
              )}

              <div className="my-5 border-t border-border/40" />

              <Label className="text-sm font-medium mb-3 block">视频模式</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { value: "product_closeup", label: "产品特写", desc: "商品原图为主，真实感最高", icon: LuBox },
                  { value: "graphic_montage", label: "图文混剪", desc: "快节奏图文卡片，适合快消品", icon: LuLayoutGrid },
                  { value: "scene_demo", label: "场景演示", desc: "AI 生成使用场景，不含人脸", icon: LuEye },
                  { value: "live_presenter", label: "真人出镜", desc: "手动选择人物包与已通过参考图", icon: LuVideo },
                ].map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setVideoMode(opt.value)}
                      className={`relative flex items-start gap-3 p-3.5 rounded-lg border text-left transition-all ${
                        videoMode === opt.value
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${videoMode === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                      <div>
                        <span className={`text-sm font-medium ${videoMode === opt.value ? "text-primary" : "text-foreground"}`}>
                          {opt.label}
                        </span>
                        <span className="text-xs text-muted-foreground mt-0.5 block">{opt.desc}</span>
                      </div>
                      {videoMode === opt.value && (
                        <div className="absolute top-2.5 right-2.5">
                          <div className="h-2 w-2 rounded-full brand-gradient" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              {videoMode === "live_presenter" && (
                <div className="mt-4 space-y-3 rounded-lg border border-cyan-100/25 bg-cyan-100/[0.06] p-3">
                  <div>
                    <Label className="text-sm font-medium">人物身份包与参考图</Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">每个项目只选择一个人物包，再勾选本次要调用的已通过图片。不会自动整包带入。</p>
                  </div>
                  <LumaSelect
                    value={selectedIdentityPackId}
                    onChange={(packId) => {
                      setSelectedIdentityPackId(packId);
                      setSelectedIdentityReferenceIds([]);
                    }}
                    emptyLabel="暂无人物包"
                    ariaLabel="项目人物包"
                    options={identityPacks.map((pack) => ({ value: pack.id, label: pack.packName, detail: `${pack.references.filter((reference) => reference.status === "approved").length} 张已通过` }))}
                  />
                  {approvedIdentityReferences.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {approvedIdentityReferences.map((reference) => {
                        const checked = selectedIdentityReferenceIds.includes(reference.id);
                        return <label key={reference.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition ${checked ? "border-cyan-200/55 bg-cyan-200/[0.10]" : "border-border/50 bg-background/35"}`}>
                          <input type="checkbox" checked={checked} onChange={() => setSelectedIdentityReferenceIds((current) => checked ? current.filter((id) => id !== reference.id) : [...current, reference.id])} className="mt-0.5" />
                          <span><span className="block text-sm font-medium">{reference.title}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{reference.role}</span></span>
                        </label>;
                      })}
                    </div>
                  ) : <p className="text-xs text-amber-600">该人物包还没有已通过验收的参考图，请先到人物身份包完成验收。</p>}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 使用爆款模板（仅在有模板时显示） */}
          {templates.length > 0 && (
            <Card className="glass-card">
              <CardContent className="p-5">
                <div className="mb-3">
                  <Label className="text-sm font-medium flex items-center gap-1.5">
                    <LuBookmark className="w-4 h-4 text-primary" />
                    使用爆款模板
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    选择已保存的成功脚本结构，自动套用到新商品
                  </p>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
                  {/* 不使用模板 */}
                  <button
                    onClick={() => setSelectedTemplateId(null)}
                    className={`shrink-0 flex flex-col items-start p-3 rounded-lg border text-left transition-all min-w-[140px] ${
                      selectedTemplateId === null
                        ? "border-primary bg-primary/10"
                        : "border-border/50 bg-muted/20 hover:border-primary/40"
                    }`}
                  >
                    <span className={`text-sm font-medium ${selectedTemplateId === null ? "text-primary" : "text-foreground"}`}>
                      不使用模板
                    </span>
                    <span className="text-[11px] text-muted-foreground mt-0.5">AI 自由生成</span>
                  </button>
                  {/* 模板列表 */}
                  {templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      className={`shrink-0 flex flex-col items-start p-3 rounded-lg border text-left transition-all min-w-[140px] ${
                        selectedTemplateId === tpl.id
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <span className={`text-sm font-medium truncate max-w-[120px] ${selectedTemplateId === tpl.id ? "text-primary" : "text-foreground"}`}>
                        {tpl.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground mt-0.5">
                        {tpl.category || tpl.styleType || "通用"} · 已用 {tpl.useCount} 次
                      </span>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 脚本风格 */}
          <Card className="glass-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">3</span>
                <span className="text-sm font-semibold">选择脚本风格</span>
              </div>
              <Label className="text-sm font-medium mb-3 block">脚本风格</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {styleOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setScriptStyle(opt.value);
                      setSelectedCloneMethodId("none");
                    }}
                    className={`relative flex flex-col items-start p-3.5 rounded-lg border text-left transition-all ${
                      selectedCloneMethodId === "none" && scriptStyle === opt.value
                        ? "border-primary bg-primary/10"
                        : "border-border/50 bg-muted/20 hover:border-primary/40"
                    }`}
                  >
                    <span
                      className={`text-sm font-medium ${
                        selectedCloneMethodId === "none" && scriptStyle === opt.value ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {opt.label}
                    </span>
                    <span className="text-xs text-muted-foreground mt-0.5">
                      {opt.desc}
                    </span>
                    {/* 选中指示器 */}
                    {selectedCloneMethodId === "none" && scriptStyle === opt.value && (
                      <div className="absolute top-2.5 right-2.5">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-primary">
                          <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
                          <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    )}
                  </button>
                ))}
                {scriptStyleMethods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    onClick={() => {
                      setSelectedCloneMethodId(method.id);
                      setScriptStyle("auto");
                    }}
                    className={`relative flex flex-col items-start p-3.5 rounded-lg border text-left transition-all ${
                      selectedCloneMethodId === method.id
                        ? "border-primary bg-primary/10"
                        : "border-border/50 bg-muted/20 hover:border-primary/40"
                    }`}
                  >
                    <span className={`text-sm font-medium ${selectedCloneMethodId === method.id ? "text-primary" : "text-foreground"}`}>
                      {method.styleShortName || method.name}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {method.description}
                    </span>
                    <span className="mt-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                      方法库同步
                    </span>
                    {selectedCloneMethodId === method.id && (
                      <div className="absolute top-2.5 right-2.5">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-primary">
                          <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
                          <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="text-sm font-medium text-primary">
                  {selectedCloneMethod
                    ? `当前为方法库脚本风格：${selectedCloneMethod.styleShortName || selectedCloneMethod.name}`
                    : styleDecisionNotes[scriptStyle]?.title}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {selectedCloneMethod
                    ? "生成时会把该方法的镜头结构、口播节奏、动作表情、资产反推和导演稿规则交给 LLM；当前商品图和人物身份包仍然是最高优先级。"
                    : styleDecisionNotes[scriptStyle]?.desc}
                </p>
              </div>
              <div className="mt-4 flex items-center justify-between rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                <span>方法库保存的方法会以简称同步到这里；这里只显示适合普通项目的 normal/both 方法。</span>
                <Link href={embedded ? "/workspace?module=methods" : "/clone-methods"} className="shrink-0 text-primary hover:underline">
                  管理方法库
                </Link>
              </div>
            </CardContent>
          </Card>

          {/* 提交按钮 */}
          <div className="pt-2 pb-10">
            {/* 错误提示 */}
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive flex items-center gap-2">
                  <LuCircleAlert className="w-4 h-4 shrink-0" />
                  {error}
                </p>
              </div>
            )}

            {/* 进度条 */}
            {progress && (
              <div className="mb-4">
                <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                  <div
                    className="h-full brand-gradient transition-all duration-500 rounded-full"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center mt-2">
                  {progress.message}
                </p>
              </div>
            )}

            <Button
              onClick={handleSubmit}
              disabled={!isValid || isSubmitting || !isLLMConfigured}
              className="w-full h-12 brand-gradient text-white font-semibold text-base shadow-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <svg className="animate-spin mr-2 h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {progress?.message || "处理中..."}
                </>
              ) : (
                <>
                  <LuZap className="w-5 h-5 mr-2" />
                  开始生成脚本
                </>
              )}
            </Button>
            {!isSubmitting && (
              <p className="text-xs text-muted-foreground text-center mt-3">
                {!isLLMConfigured
                  ? "请先在设置中配置 LLM API Key"
                  : !isValid
                    ? "请先选择商品库产品包"
                    : "AI 将根据商品库产品包和脚本风格生成专业带货脚本"}
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function NewProjectPage() {
  const { embedded, onProjectCreated } = useWorkspaceEmbed();
  return <NewProjectWorkspace embedded={embedded} onProjectCreated={onProjectCreated} />;
}
