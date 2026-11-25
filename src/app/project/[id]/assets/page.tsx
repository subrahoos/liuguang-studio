"use client";

/* eslint-disable @next/next/no-img-element -- Preview URLs include local API files and data URLs that should not pass through Next image optimization. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LuArrowLeft, LuZap, LuCheck, LuCircleX, LuImage, LuArrowRight, LuRefreshCw, LuX, LuUpload, LuTrash2, LuCopy, LuFileText, LuHouse } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GenerationProgress } from "@/components/generation-progress";
import { ProjectLocalArchive } from "@/components/project-local-archive";
import { ProjectVersionBar } from "@/components/project-version-bar";
import { getActiveImageChannel, hasProviderCredential, useSettingsStore } from "@/lib/stores/settings-store";
import { imageDimensionsForPreset } from "@/lib/image-output-size";
import { joinUniqueTextSections, uniqueStrings } from "@/lib/prompt-dedup";
import type { Shot } from "@/lib/db/schema";

interface AssetItem {
  id: string | null;
  shotId: number;
  segmentIndex?: number;
  assetRole?: string;
  shotType: Shot["type"];
  duration: number;
  description: string;
  camera: string;
  voiceover: string;
  prompt: string;
  finalPrompt: string | null;
  visualSource: Shot["visualSource"];
  transition: Shot["transition"];
  assetType: "ai_generated" | "product_image" | "user_upload";
  status: "pending" | "generating" | "done" | "failed";
  filePath: string | null;
  thumbnailPath: string | null;
  provider: string | null;
  model: string | null;
}

interface AssetsResponse {
  project: {
    id: string;
    name: string;
    productName: string | null;
    productCategory?: string | null;
    productDescription?: string | null;
    productAnalysis?: string | null;
    productImages: string[];
    sourceType?: "manual" | "clone" | null;
    characterId?: string | null;
    imageChannelId?: string | null;
    videoChannelId?: string | null;
    currentVersion?: { configSnapshot?: Record<string, unknown> | null } | null;
  };
  script: {
    id: string;
    title: string | null;
  } | null;
  assets: AssetItem[];
}

const shotTypeLabels: Record<Shot["type"], { label: string; color: string }> = {
  hook: { label: "钩子", color: "bg-red-500/20 text-red-400" },
  pain_point: { label: "痛点", color: "bg-orange-500/20 text-orange-400" },
  product_reveal: { label: "产品", color: "bg-blue-500/20 text-blue-400" },
  demo: { label: "演示", color: "bg-green-500/20 text-green-400" },
  social_proof: { label: "背书", color: "bg-purple-500/20 text-purple-400" },
  cta: { label: "转化", color: "bg-amber-500/20 text-amber-400" },
};

type UnknownRecord = Record<string, unknown>;

type IdentityReference = { id: string; url: string; status: "draft" | "approved" | "archived"; title: string };

function readIdentitySelection(configSnapshot?: Record<string, unknown> | null) {
  const value = configSnapshot?.identitySelection;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { packId: "", referenceIds: [] as string[] };
  const selection = value as { packId?: unknown; referenceIds?: unknown };
  return {
    packId: typeof selection.packId === "string" ? selection.packId : "",
    referenceIds: Array.isArray(selection.referenceIds) ? selection.referenceIds.map(String).filter(Boolean) : [],
  };
}

function isIdentityReference(image: string, identityImages: string[]): boolean {
  return identityImages.includes(image);
}

function isPersonShot(asset: AssetItem): boolean {
  const source = `${asset.description}\n${asset.prompt}\n${asset.voiceover}`.toLowerCase();
  return asset.visualSource === "user_upload"
    || /出镜|真人|人物|模特|上身|穿着|试穿|口播|主播|女生|女人|女性|girl|woman|female|model|person|presenter|wearing|try-on|on body|talking head|spokesperson/.test(source);
}

function parseAnalysis(value?: string | null): UnknownRecord | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : null;
  } catch {
    return null;
  }
}

function stringifyFact(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(stringifyFact).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as UnknownRecord)
      .map(([key, item]) => `${key}: ${stringifyFact(item)}`)
      .filter(Boolean)
      .join("; ");
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function pickAnalysisFacts(analysis: UnknownRecord | null): string[] {
  if (!analysis) return [];
  const keys = [
    "productName",
    "category",
    "brand",
    "visualFeatures",
    "productLock",
    "sellingPoints",
    "usageScenarios",
    "keyVisuals",
    "videoSuggestions",
  ];
  return keys
    .map((key) => {
      const text = stringifyFact(analysis[key]);
      return text ? `${key}: ${text}` : "";
    })
    .filter(Boolean);
}

function cloneWorkflowFacts(analysis: UnknownRecord | null): string[] {
  const workflow = analysis?.cloneWorkflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return [];
  const clone = workflow as UnknownRecord;
  const plan = clone.plan && typeof clone.plan === "object" && !Array.isArray(clone.plan)
    ? clone.plan as UnknownRecord
    : {};
  const assetPlan = plan.assetPlan && typeof plan.assetPlan === "object" && !Array.isArray(plan.assetPlan)
    ? plan.assetPlan as UnknownRecord
    : {};
  return [
    `product visual analysis: ${stringifyFact(analysis?.productVisualAnalysis)}`,
    `product structure lock: ${stringifyFact(analysis?.productStructureLock)}`,
    `clone method type: ${stringifyFact(plan.methodType)}`,
    `clone method reason: ${stringifyFact(plan.selectedMethodReason)}`,
    `clone summary: ${stringifyFact(plan.chineseSummary)}`,
    `clone first-frame anchors: ${stringifyFact(assetPlan.firstFrameAnchors)}`,
    `clone motion references: ${stringifyFact(assetPlan.motionReferences)}`,
    `clone product views: ${stringifyFact(assetPlan.productViews)}`,
    `clone scene images: ${stringifyFact(assetPlan.sceneImages)}`,
    `clone detail assets: ${stringifyFact(assetPlan.detailAssets)}`,
    `clone atmosphere assets: ${stringifyFact(assetPlan.atmosphereAssets)}`,
    `clone replacement boundaries: ${stringifyFact(plan.replacementBoundaries)}`,
    `clone quality checklist: ${stringifyFact(plan.qualityChecklist)}`,
    "clone prompt safety: method-library style controls pose, rhythm, scene, and account-template feeling only. It must not inject garment structure terms that conflict with the current product reference images.",
  ].map(asciiOnly).filter(Boolean);
}

function asciiOnly(value?: string | null): string {
  return (value ?? "").replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasCjkText(value?: string | null): boolean {
  return /[\u3400-\u9FFF]/.test(value ?? "");
}

function englishCategory(category?: string | null): string {
  const normalized = (category ?? "").toLowerCase();
  const categoryMap: Record<string, string> = {
    fashion: "fashion apparel",
    beauty: "beauty product",
    food: "food or packaged snack",
    home: "home and daily-use product",
    digital: "consumer electronics product",
    tech: "consumer electronics product",
    other: "ecommerce product",
  };
  return categoryMap[normalized] ?? "ecommerce product";
}

function englishShotIntent(asset: AssetItem): string {
  const source = `${asset.description}\n${asset.prompt}`.toLowerCase();
  const parts: string[] = [];

  if (/情感共鸣|痛点|尴尬|烦恼|不满意|pain|problem|frustrat/.test(source)) {
    parts.push("Show one realistic user pain point or emotional moment before the product benefit becomes clear.");
  }
  if (/卧室|居家|衣柜|bedroom|home|closet/.test(source)) {
    parts.push("Use a clean home bedroom or wardrobe scene with natural daylight and a believable lifestyle atmosphere.");
  }
  if (/通勤|上班|办公室|commute|office|work/.test(source)) {
    parts.push("Use a daily commute or office-ready lifestyle scene with restrained ecommerce styling.");
  }
  if (/平铺|桌面|flat lay|tabletop/.test(source)) {
    parts.push("Use a clean flat-lay or tabletop product composition.");
  }
  if (/挂拍|衣架|悬挂|hanging|hanger/.test(source)) {
    parts.push("Use a clean hanging garment or rack display composition.");
  }
  if (/细节|纹理|领口|袖口|下摆|detail|texture|macro/.test(source)) {
    parts.push("Show a close-up product detail with material texture, edges, stitching, trim, or functional details clearly visible.");
  }
  if (/上身|真人|模特|穿着|试穿|wearing|model|try-on|on body/.test(source)) {
    parts.push("Show the product worn by one main model/person, keeping the product unobstructed and accurate to the reference.");
  }
  if (/特写|close-up/.test(source)) {
    parts.push("Use a close-up or medium-close composition with shallow depth of field.");
  }
  if (/全景|全身|full body|wide shot/.test(source)) {
    parts.push("Use a wider composition that keeps the full product silhouette readable.");
  }

  if (parts.length > 0) return parts.join(" ");

  const fallback: Record<Shot["type"], string> = {
    hook: "Create a clear opening hook image where the product or product benefit is immediately readable.",
    pain_point: "Create one realistic pain-point scene with a single main subject and no exaggerated claim visuals.",
    product_reveal: "Create a product-first reveal frame with structure, material, and key details clearly visible.",
    demo: "Create one simple realistic usage or try-on demonstration frame.",
    social_proof: "Create a believable lifestyle or trust-building scene with one clear main subject.",
    cta: "Create a clean closing hero frame with the product clearly visible and empty space for later manual overlay.",
  };
  return fallback[asset.shotType];
}

function inferProductPresentation(asset: AssetItem): string {
  const source = `${asset.description}\n${asset.prompt}`.toLowerCase();
  if (/平铺|铺在|桌面|flat lay|tabletop|table/.test(source)) {
    return "Follow this shot description: present the product as a clean flat-lay or tabletop hero shot. Keep the whole product readable, with detail close enough to verify structure and material.";
  }
  if (/挂拍|衣架|悬挂|hanging|hanger/.test(source)) {
    return "Follow this shot description: present the product hanging cleanly on a hanger or rack. Keep the full outline visible and reserve clean background space if the shot needs later text overlay.";
  }
  if (/微距|特写|细节|纹理|领口|袖口|下摆|macro|close-up|detail|texture/.test(source)) {
    return "Follow this shot description: present a single close-up detail keyframe. Show the product's real material, structure, edge details, pattern, stitching, packaging, or functional detail from the current reference image.";
  }
  if (/上身|真人|模特|穿着|试穿|转身|wearing|model|outfit|try-on|on body/.test(source)) {
    return "Follow this shot description: present the product worn or used by one main model/person when appropriate. The product must remain unobstructed and must match the reference image.";
  }
  if (/手持|手拿|使用|操作|涂抹|打开|holding|hands|using|apply|operate/.test(source)) {
    return "Follow this shot description: present the product in use with simple realistic hands or body interaction. Hands must not cover the product's key identifying details.";
  }
  if (asset.shotType === "product_reveal") {
    return "Shot presentation: product reveal. Choose the clearest product-first appearance based on the shot description, such as hero product shot, hanging shot, flat-lay, or close-up detail.";
  }
  if (asset.shotType === "cta") {
    return "Shot presentation: closing hero frame. Show the product clearly with clean negative space reserved for later manual overlay, but do not generate any text or shopping UI.";
  }
  return "Follow the shot description to decide how the product appears: worn, held, laid flat, hanging, close-up detail, in-use scene, hero product shot, or lifestyle scene.";
}

function cloneAssetRoleInstruction(asset: AssetItem): string {
  const role = `${asset.assetRole ?? ""} ${asset.description ?? ""}`.toLowerCase();
  const source = `${role} ${asset.prompt ?? ""}`.toLowerCase();
  const isCar = /car|vehicle|steering|seatbelt|seat|dashboard|driver|passenger|车内|汽车|方向盘|安全带|座椅|副驾|驾驶/.test(source);
  const isHomeMirror = /home|indoor|bedroom|wardrobe|room|mirror|室内|居家|卧室|衣柜|房间|全身镜/.test(source) && !isCar;
  const isOutdoorMirror = /outdoor|street|storefront|sidewalk|parked car|tree|mirror|reflection|glass|户外|街|橱窗|玻璃|树影|白车|对镜/.test(source) && !isCar;
  const isBrandOrMagazine = /brand|ad|advertising|magazine|editorial|emotional|cinematic|品牌|广告|杂志|情绪片/.test(source);
  const base = [
    "CLONE ASSET ROLE OVERRIDE:",
    "Follow the assetRole and canonical prompt from the clone plan. Do not apply normal-project product hero, flat-lay, tabletop, catalog, or generic close-up fallback instructions unless the assetRole explicitly asks for a detail close-up.",
    "Choose framing by method type: outdoor/home mirror can use full-body or 3/4-body; car OOTD should remain seated inside the car container; brand/ad/magazine should follow the method's designed shot grammar.",
    "HUMAN ANATOMY SAFETY OVERRIDE: if a person appears, show one natural adult with exactly two arms and two hands. Use one simple non-overlapping hand action per asset. In mirror/selfie shots, one hand may hold the phone and the other may touch the product, sleeve, collar, hem, pocket, or bag. Avoid crossed arms, both hands reaching across the torso, hidden elbows, overlapping forearms, ambiguous reflected limbs, or any pose that could read as extra arms.",
  ];
  if (role.includes("a1") || role.includes("first_frame")) {
    if (isCar) {
      base.push("A1 must establish the car-account container: seated model, product readable, steering wheel/seat/seatbelt/window/cupholder or car-door anchors visible. Do not force standing full-body framing.");
    } else {
      base.push("A1 must be a full-body or near full-body account-template opening frame when the method supports it: whole outfit visible, product readable, phone/selfie/reflection logic clear, scene anchors visible.");
    }
  } else if (role.includes("a2") || role.includes("identity_expression")) {
    base.push("A2 may be a medium shot for identity, phone, eyes, expression, and mouth-shape, but it must still keep the product neckline and upper garment readable.");
  } else if (role.includes("a3") || role.includes("product_on_body")) {
    if (isCar) {
      base.push("A3 must be a seated 2/3-body or waist-up car try-on structure frame. Show product on body plus seat/steering/window/torso direction and, when possible, lap/leg relation. Do not crop into a garment-only close-up and do not move the model outside the car.");
    } else if (isBrandOrMagazine) {
      base.push("A3 must be a method-appropriate product-on-body/use-state structure frame. It can be editorial or ad-like, but it must prove product silhouette, fit, and key structure without becoming a generic close-up.");
    } else if (isOutdoorMirror || isHomeMirror) {
      base.push("A3 must be full-body or 3/4-body on-body try-on structure. Show legs/support outfit/body direction/weight shift. Do not crop into a garment close-up.");
    } else {
      base.push("A3 must use the selected method's natural product-on-body/use-state framing. It must prove product silhouette, fit, and key structure without becoming a generic close-up.");
    }
  } else if (role.includes("a4") || role.includes("front_structure")) {
    base.push("A4 is the main upper-body product-structure frame. It may be closer, but it must still belong to the selected method's scene container and must not become a clean catalog photo.");
  } else if (role.includes("a5") || role.includes("detail_interaction")) {
    base.push("A5 is the detail interaction frame. It may be a close-up, but use only one clear visible hand touching one product detail such as sleeve edge, collar, hem, fabric texture, pocket edge, or waistline. The other hand should either hold the phone or stay outside the interaction. Do not use crossed arms or two hands touching opposite sleeves.");
  } else if (role.includes("a6") || role.includes("motion_transition")) {
    if (isCar) {
      base.push("A6 must be a seated car-container motion transition: taking cup, holding steering wheel, adjusting collar/sleeve/bag, turning toward the window, or shifting posture. Show torso direction, hand path, seat/steering/window anchors, and garment inertia. Do not crop into a garment-only close-up and do not force standing full-body framing.");
    } else if (isBrandOrMagazine) {
      base.push("A6 must be a method-appropriate motion bridge with visible body/product movement, fabric inertia, and camera continuity. It may be editorial/ad framing, but it must not become a static close-up.");
    } else if (isOutdoorMirror || isHomeMirror) {
      base.push("A6 must be full-body or knee-up motion transition. Show body direction, legs/feet or grounded stance, hand path, and fabric inertia. Do not crop into a garment close-up.");
    } else {
      base.push("A6 must use the selected method's natural motion framing. Show body/product movement, hand path, scene continuity, and material inertia; do not crop into a generic garment close-up.");
    }
  } else if (role.includes("a7") || role.includes("ending_continuity")) {
    if (isCar) {
      base.push("A7 should be a seated ending continuity frame inside the same car container, with stable product, posture, props, and natural blank space for later captions.");
    } else {
      base.push("A7 should follow the method's natural ending continuity framing, usually full-body or 3/4-body for mirror/street methods, with same scene and outfit plus natural blank space for later captions.");
    }
  }
  return base.join("\n");
}

function categoryNegativeConstraints(category?: string | null): string {
  const normalized = (category ?? "").toLowerCase();
  const common = [
    "wrong product",
    "altered product structure",
    "missing key details",
    "different colorway",
    "different material",
    "generic replacement product",
    "unrelated props distracting from product",
    "cheap promotional poster",
    "collage",
    "split screen",
    "multiple panels",
    "before-after layout",
    "generated typography",
    "any readable text",
    "corner watermark",
    "faint watermark",
    "brand watermark",
    "stock photo watermark",
    "Chinese characters",
    "letters or numbers in the image",
    "price tag",
    "shopping cart icon",
    "logo hallucination",
    "watermark",
    "distorted hands",
    "extra arms",
    "extra hands",
    "extra fingers",
    "missing arms",
    "missing hands",
    "fused arms",
    "fused fingers",
    "duplicated limbs",
    "ambiguous mirror limbs",
    "crossed arms causing extra limbs",
    "overlapping forearms",
    "twisted wrists",
    "deformed body",
    "broken anatomy",
    "blurry product details",
  ];
  const byCategory: Record<string, string[]> = {
    fashion: ["changed garment type", "changed neckline", "changed sleeve length", "changed silhouette", "wrong fabric pattern", "missing trim or edge details", "overly transparent fabric", "extra pockets/buttons/zippers not in reference"],
    beauty: ["changed packaging shape", "changed bottle/cap/pump design", "wrong label placement", "fake brand text", "spilled product obscuring packaging"],
    food: ["changed food form", "wrong package size", "incorrect flavor/color packaging", "unrealistic inedible texture", "messy food blocking product"],
    home: ["changed device shape", "changed interface/ports/buttons", "wrong functional structure", "unsafe or impossible usage scene"],
    tech: ["changed screen/device shape", "wrong buttons/ports/camera layout", "invented brand marks", "impossible cable or accessory structure"],
  };
  return [...common, ...(byCategory[normalized] ?? [])].join(", ");
}

function chooseProductReferenceImage(asset: AssetItem, images: string[]): string | null {
  if (images.length === 0) return null;
  const source = `${asset.description}\n${asset.prompt}`.toLowerCase();
  if (/上身|真人|模特|穿着|试穿|wearing|model|outfit|try-on|on body/.test(source) && images[1]) {
    return images[1];
  }
  if (/平铺|铺在|桌面|挂拍|衣架|悬挂|产品|特写|细节|纹理|laid flat|flat lay|hanging|hanger|product|detail|texture/.test(source)) {
    return images[2] ?? images[0];
  }
  return images[1] ?? images[0];
}

function chooseReferenceImages(asset: AssetItem, images: string[], identityImages: string[]): string[] {
  const productReference = chooseProductReferenceImage(asset, images);
  const productReferences = [
    productReference,
    ...images.filter((image) => image !== productReference),
  ].filter((item): item is string => Boolean(item));

  if (isPersonShot(asset)) {
    return [...productReferences, ...identityImages].filter((item): item is string => Boolean(item));
  }
  return productReferences;
}

function extractCommonImagePrompt(fullPrompt: string): string {
  const markers = [
    "CLONE ASSET ROLE OVERRIDE:",
    "Shot role:",
    "Canonical English shot prompt from script:",
    "English shot intent:",
  ];
  const indexes = markers
    .map((marker) => fullPrompt.indexOf(marker))
    .filter((index) => index >= 0);
  const firstAssetSpecificIndex = indexes.length > 0 ? Math.min(...indexes) : -1;
  return (firstAssetSpecificIndex >= 0 ? fullPrompt.slice(0, firstAssetSpecificIndex) : fullPrompt).trim();
}

function buildMultiAssetPrompt(commonPrompt: string, assets: AssetItem[]): string {
  const assetBlocks = assets.map((asset, index) => {
    const label = `IMAGE ${index + 1} / Shot ${String(asset.shotId).padStart(2, "0")}`;
    return [
      `${label}:`,
      asset.assetRole ? `Asset role: ${asset.assetRole}` : "",
      asset.segmentIndex ? `Segment index: ${asset.segmentIndex}` : "",
      asset.description ? `Asset purpose and Chinese/English summary: ${asciiOnly(asset.description)}` : "",
      cloneAssetRoleInstruction(asset),
      asciiOnly(asset.prompt) ? `Canonical English asset prompt: ${asciiOnly(asset.prompt)}` : "",
      "This output image must only satisfy this numbered asset. Do not merge it with any other asset. Do not make collage, split-screen, poster, text overlay, app UI, watermark, or duplicate panels.",
    ].filter(Boolean).join("\n");
  });

  return joinUniqueTextSections([
    commonPrompt,
    [
      "MULTI-IMAGE SEGMENT OUTPUT CONTRACT:",
      `Generate exactly ${assets.length} separate vertical 9:16 image outputs in the same order as the numbered asset list below.`,
      "Use the shared product lock, identity lock, method style, and negative constraints once for the whole batch.",
      "Each returned image must be a different useful video-reference keyframe for the same segment, not seven variations of the same pose.",
      "Keep the same product garment, same model identity, same outfit coordination, same scene container, and same lighting logic across all images.",
      "Do not let later asset instructions override the product reference images. Product reference images remain the highest-priority source of garment truth.",
    ].join("\n"),
    assetBlocks.join("\n\n"),
    "Batch-level consistency priority: product accuracy > identity consistency > segment continuity > method/account-template feeling > scene beauty. If any conflict appears, simplify the scene and preserve the exact product and same model.",
  ], "\n");
}

function groupCloneAssetsBySegment(assets: AssetItem[]): Array<{ segmentIndex: number; assets: AssetItem[] }> {
  const groups = new Map<number, AssetItem[]>();
  for (const asset of assets) {
    const segmentIndex = Number.isFinite(asset.segmentIndex)
      ? Math.max(1, Math.round(asset.segmentIndex || 1))
      : Math.floor((asset.shotId - 1) / 7) + 1;
    groups.set(segmentIndex, [...(groups.get(segmentIndex) || []), asset]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([segmentIndex, segmentAssets]) => ({
      segmentIndex,
      assets: segmentAssets.sort((a, b) => a.shotId - b.shotId).slice(0, 7),
    }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function AssetsPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const versionId = searchParams.get("versionId");
  const { providers } = useSettingsStore();
  const [data, setData] = useState<AssetsResponse | null>(null);
  const [identityReferences, setIdentityReferences] = useState<IdentityReference[]>([]);
  const imageProvider = providers["openai-seedance"];
  const imageChannel = getActiveImageChannel(imageProvider, data?.project.imageChannelId || undefined);
  const imageModel = imageChannel?.model || "gpt-image-2";
  const fixedImageSize = useMemo(() => imageDimensionsForPreset("9:16", "4k"), []);
  const imageRequestOptions = useMemo(() => ({
    count: 1,
    ...(fixedImageSize ? { width: fixedImageSize.width, height: fixedImageSize.height } : {}),
    ...(fixedImageSize
      ? { extra: { quality: "auto" } }
      : {}),
  }), [fixedImageSize]);

  const [isLoading, setIsLoading] = useState(true);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [isUpdatingProductImages, setIsUpdatingProductImages] = useState(false);
  const [assetProgress, setAssetProgress] = useState<{
    percentage: number;
    stage: string;
    detail: string;
    elapsedSeconds: number;
    etaSeconds: number;
    startedAt: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageReloadTokens, setImageReloadTokens] = useState<Record<string, number>>({});
  const [activeCloneSegmentIndex, setActiveCloneSegmentIndex] = useState<number | null>(null);
  const [promptPreview, setPromptPreview] = useState<{
    title: string;
    scriptPrompt: string;
    finalPrompt: string;
    referenceImages: string[];
  } | null>(null);
  const productImageInputRef = useRef<HTMLInputElement>(null);

  const assets = useMemo(() => data?.assets ?? [], [data?.assets]);
  const isCloneAssetPackage = data?.project.sourceType === "clone" && !data?.script;
  const parsedAnalysis = useMemo(() => parseAnalysis(data?.project.productAnalysis), [data?.project.productAnalysis]);
  const cloneWorkflow = useMemo(() => {
    const workflow = parsedAnalysis?.cloneWorkflow;
    return workflow && typeof workflow === "object" && !Array.isArray(workflow) ? workflow as UnknownRecord : {};
  }, [parsedAnalysis]);
  const clonePlan = useMemo(() => {
    const plan = cloneWorkflow.plan;
    return plan && typeof plan === "object" && !Array.isArray(plan) ? plan as UnknownRecord : {};
  }, [cloneWorkflow]);
  const cloneAssetSegments = useMemo(
    () => isCloneAssetPackage ? groupCloneAssetsBySegment(assets) : [],
    [assets, isCloneAssetPackage]
  );
  const generatableAssets = assets.filter((asset) => asset.visualSource !== "user_upload");
  const doneCount = assets.filter((asset) => asset.status === "done").length;
  const allDone = assets.length > 0 && doneCount === assets.length;
  const isAnyAssetGenerating = assets.some((asset) => asset.status === "generating");
  const activeGeneratingAsset = assets.find((asset) => asset.status === "generating");
  const activeSegmentIndex = activeCloneSegmentIndex ?? activeGeneratingAsset?.segmentIndex ?? null;
  const isAssetProgressActive = Boolean(assetProgress && assetProgress.percentage < 100 && (isBatchGenerating || isAnyAssetGenerating));
  const canUseImage2 = Boolean(imageProvider?.enabled && hasProviderCredential(imageProvider) && imageChannel?.apiKey && imageChannel?.baseUrl && imageChannel?.model);
  const productReferenceImages = useMemo(() => data?.project.productImages ?? [], [data?.project.productImages]);
  const identitySelection = useMemo(
    () => readIdentitySelection(data?.project.currentVersion?.configSnapshot),
    [data?.project.currentVersion?.configSnapshot]
  );
  const selectedIdentityPackId = identitySelection.packId || data?.project.characterId || "";
  const selectedIdentityReferenceIds = identitySelection.referenceIds;
  const selectedIdentityImageUrls = useMemo(
    () => identityReferences
      .filter((reference) => selectedIdentityReferenceIds.includes(reference.id))
      .map((reference) => reference.url),
    [identityReferences, selectedIdentityReferenceIds]
  );

  const loadAssets = useCallback(async (silent = false) => {
    if (!id) return;
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/project/${id}/assets${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "读取素材失败");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取素材失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [id, versionId]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!selectedIdentityPackId || selectedIdentityReferenceIds.length === 0) {
      setIdentityReferences([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/identity-pack?packId=${encodeURIComponent(selectedIdentityPackId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (cancelled) return;
        const references = Array.isArray(json.pack?.references) ? json.pack.references as IdentityReference[] : [];
        setIdentityReferences(references);
      })
      .catch(() => {
        if (!cancelled) setIdentityReferences([]);
      });
    return () => { cancelled = true; };
  }, [selectedIdentityPackId, selectedIdentityReferenceIds]);

  useEffect(() => {
    if (!assetProgress) return;
    if (isBatchGenerating || isAnyAssetGenerating || assetProgress.percentage < 100) return;

    const isFailed = assetProgress.stage.toLowerCase().includes("failed");
    const timer = window.setTimeout(() => {
      setAssetProgress(null);
    }, isFailed ? 8000 : 1800);

    return () => window.clearTimeout(timer);
  }, [assetProgress, isAnyAssetGenerating, isBatchGenerating]);

  useEffect(() => {
    if (!assetProgress || assetProgress.percentage >= 100) return;
    const timer = window.setInterval(() => {
      setAssetProgress((prev) => {
        if (!prev) return prev;
        const elapsedSeconds = Math.max(0, Math.round((Date.now() - prev.startedAt) / 1000));
        const etaSeconds = prev.percentage >= 100
          ? 0
          : Math.max(5, Math.round((elapsedSeconds / Math.max(prev.percentage, 1)) * (100 - prev.percentage)));
        return { ...prev, elapsedSeconds, etaSeconds };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [assetProgress]);

  const updateAssetProgress = useCallback((patch: {
    percentage: number;
    stage: string;
    detail: string;
    startedAt?: number;
  }) => {
    const startedAt = patch.startedAt ?? assetProgress?.startedAt ?? Date.now();
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const etaSeconds = patch.percentage >= 100
      ? 0
      : Math.max(5, Math.round((elapsedSeconds / Math.max(patch.percentage, 1)) * (100 - patch.percentage)));

    setAssetProgress({
      ...patch,
      startedAt,
      elapsedSeconds,
      etaSeconds,
    });
  }, [assetProgress?.startedAt]);

  const saveProductImages = useCallback(async (nextImages: string[]) => {
    if (!id || !data?.project) return;
    setIsUpdatingProductImages(true);
    setError(null);
    try {
      const response = await fetch(`/api/project/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productImages: nextImages }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Product images update failed");
      setData((prev) => prev
        ? {
          ...prev,
          project: {
            ...prev.project,
            productImages: nextImages,
          },
        }
        : prev
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Product images update failed");
    } finally {
      setIsUpdatingProductImages(false);
    }
  }, [data?.project, id]);

  const handleAddProductImages = useCallback(async (files: FileList | null) => {
    if (!files?.length || !id) return;
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    setIsUpdatingProductImages(true);
    setError(null);
    try {
      const formData = new FormData();
      imageFiles.forEach((file) => formData.append("files", file));
      formData.append("projectId", id);

      const response = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Product images upload failed");

      const paths = Array.isArray(json.paths) ? json.paths as string[] : [];
      const nextImages = [...productReferenceImages, ...paths].slice(0, 8);
      await saveProductImages(nextImages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Product images upload failed");
      setIsUpdatingProductImages(false);
    }
  }, [id, productReferenceImages, saveProductImages]);

  const handleRemoveProductImage = useCallback(async (image: string) => {
    const nextImages = productReferenceImages.filter((item) => item !== image);
    await saveProductImages(nextImages);
  }, [productReferenceImages, saveProductImages]);

  const updateLocalAsset = useCallback((shotId: number, patch: Partial<AssetItem>) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        assets: prev.assets.map((asset) =>
          asset.shotId === shotId ? { ...asset, ...patch } : asset
        ),
      };
    });
  }, []);

  const imageSrcWithReloadToken = useCallback((src: string | null | undefined) => {
    if (!src) return null;
    const token = imageReloadTokens[src] ?? 0;
    if (!token || !src.startsWith("/api/files/")) return src;
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}previewReload=${token}`;
  }, [imageReloadTokens]);

  const retryImagePreview = useCallback((src: string | null | undefined) => {
    if (!src) return;
    setImageReloadTokens((current) => {
      const nextToken = (current[src] ?? 0) + 1;
      if (nextToken > 3) return current;
      return { ...current, [src]: nextToken };
    });
  }, []);

  const persistAsset = useCallback(async (asset: AssetItem, filePath: string) => {
    const response = await fetch(`/api/project/${id}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        versionId: versionId || undefined,
        shotId: asset.shotId,
        type: asset.assetType,
        filePath,
        thumbnailPath: filePath,
        provider: asset.assetType === "ai_generated" ? "openai-seedance" : null,
        model: asset.assetType === "ai_generated" ? imageModel : null,
        prompt: asset.prompt,
        status: "done",
      }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "保存素材失败");
    return json as { id: string };
  }, [id, imageModel, versionId]);

  const buildProductLockedPrompt = useCallback((asset: AssetItem, referenceImages: string[] = []) => {
    const project = data?.project;
    const personShot = isPersonShot(asset);
    const hasProductReference = personShot
      ? referenceImages.some((image) => !isIdentityReference(image, selectedIdentityImageUrls))
      : referenceImages.length > 0;
    const hasIdentityReference = referenceImages.some((image) => isIdentityReference(image, selectedIdentityImageUrls));
    const productReferenceCount = referenceImages.filter((image) => !isIdentityReference(image, selectedIdentityImageUrls)).length;
    const productName = asciiOnly(project?.productName) || asciiOnly(project?.name) || "the attached product";
    const analysis = parseAnalysis(project?.productAnalysis);
    const analysisFacts = pickAnalysisFacts(analysis);
    const cloneFacts = cloneWorkflowFacts(analysis);
    const safeAnalysisFacts = analysisFacts.map(asciiOnly).filter(Boolean);
    const projectFacts = [
      `category: ${englishCategory(project?.productCategory)}`,
      asciiOnly(project?.productDescription) ? `productDescription: ${asciiOnly(project?.productDescription)}` : "",
      ...safeAnalysisFacts,
      ...cloneFacts,
    ].filter(Boolean);

    const productLock = [
      "VISUAL-FIRST RULE: before generating the keyframe, inspect the attached reference images. Ground the final image in the visible product and identity evidence first, then use the text prompt only to decide scene, action, composition, and commercial framing.",
      `LOCKED PRODUCT: ${productName}.`,
      hasProductReference && !personShot
        ? `Use the attached ${productReferenceCount} product reference image(s) as the highest-priority Product Lock.`
        : personShot && hasProductReference && hasIdentityReference
          ? `Use the first ${productReferenceCount} attached reference image(s) as the highest-priority Product Lock for the garment. Use the following manually selected project identity reference image(s) only as the human identity lock for face, body proportions, posture temperament, age impression, multi-angle facial consistency, and natural real-person presence. Product reference images have priority over all identity references for clothing details.`
          : personShot
            ? hasIdentityReference
              ? "The attached reference images are the manually selected project identity references. Use them for face, body proportions, posture temperament, age impression, multi-angle facial consistency, and natural real-person presence. Do not copy the calibration sportswear outfit unless it is the current product."
              : "No project identity reference has been selected for this person shot. Do not claim or imitate a fixed person identity."
            : "No product reference image is attached for this request; follow the English product category and shot intent only, and do not invent readable labels or brand text.",
      hasProductReference && !personShot
        ? "Extract the product's actual category, silhouette, structure, colorway, material, texture, pattern, logo/label placement, functional parts, scale, and front/back differences from the reference image. Keep those facts unchanged."
        : personShot && hasProductReference && hasIdentityReference
          ? "Extract the current product garment from the first reference image: garment category, silhouette, neckline/collar, sleeve shape, hem, fabric texture, colorway, pattern, trim, fit, scale, and front/back differences. Dress the identity-locked model in that exact garment. Do not preserve the identity-reference sportswear. Do not invent a different clothing style."
          : personShot
            ? hasIdentityReference
              ? "Dress this same selected identity in the current product garment. Replace the calibration outfit with the project's product clothing based on the product facts and script prompt. Preserve the current product's garment category, silhouette, collar, sleeve, hem, colorway, fabric texture, pattern, trim, and fit as described by the product analysis and shot prompt."
              : "If a person is necessary for this shot, use a non-identifiable generic model and keep the current product garment accurate. Preserve the current product's garment category, silhouette, collar, sleeve, hem, colorway, fabric texture, pattern, trim, and fit as described by the product analysis and shot prompt."
            : "Keep the product visually plausible for the stated ecommerce category, with clean material detail and no invented brand logos.",
      projectFacts.length > 0 ? `Current product facts in English: ${projectFacts.join(" | ")}` : "If text facts are incomplete, rely on the uploaded product reference image rather than inventing details.",
      "PRODUCT VISUAL TRUTH OVERRIDE: if the written product name, selling point, method-library text, previous generated plan, or script says any decorative structure, material, pattern, trim, collar, sleeve, hem, logo, label, or category detail that is not visibly present in the product reference images, ignore that written descriptor and follow the product reference images exactly.",
      "Do not add decorative appliques, lace/openwork/crochet motifs, flowers, new holes, changed neckline, extra or missing trim, changed sleeve structure, changed hem, generic fabric, logos, labels, or a different product category unless those details are clearly visible in the attached product images.",
      "Do not copy product details from examples or previous projects. Do not redesign, replace, simplify, upgrade, stylize away, or genericize the product.",
    ].join("\n");

    const identityLock = personShot && hasIdentityReference
      ? [
          "VISUAL-FIRST CHARACTER RULE: inspect the attached identity references before composing the person shot. Use them to identify the same face/body/skin-tone baseline, then dress that identity in the current product from the product reference.",
          "MANUALLY SELECTED PROJECT IDENTITY LOCK:",
          hasProductReference && hasIdentityReference
            ? "Use the attached identity references as the highest-priority human identity lock for face and body only. The product reference remains the highest-priority clothing lock."
            : "Use the attached identity references as the highest-priority human identity lock for this person shot.",
          "REFERENCE PRIORITY: use the manually selected full-body and face references as the baseline for face, full-body proportions, body silhouette, height impression, shoulder width, waist-to-hip ratio, limb proportions, posture temperament, natural skin tone, and facial complexion.",
          "SECONDARY SELECTED REFERENCES: use each selected camera or expression image only for its visible angle, pose, and expression consistency. Do not inherit their calibration outfit, local lighting problems, patchy tone, compression artifacts, pixel blocks, oily highlights, uneven shadows, or background details.",
          "SKIN TONE AND CALIBRATION LIGHT LOCK: keep one coherent natural skin tone across face, neck, shoulders, arms, hands, waist, and visible legs. Use very soft, flat, diffuse front lighting like a clean commercially retouched real-person ID calibration photo, not beauty studio lighting, not makeup campaign lighting, not a glam portrait.",
          "Reduce facial specular highlights. No oily shine, no glossy beauty-light effect, no dramatic contour lighting, no over-warm or over-cool body parts, no patchy skin color, no local color blocks, no uneven tint, no pixel blocks.",
          "White background rule for identity/person shots: keep a clean pure white background when the shot calls for a studio/calibration look, but do not overexpose it. No mottled highlight patches, no local bright spots, no grainy reflection, no compression artifacts, no visible pixel blocks, no blown-out white areas.",
          "Keep the same face shape, facial proportions, eye spacing, nose bridge, mouth shape, jawline, hairline, body proportions, shoulder width, waist-to-hip ratio, limb proportions, posture temperament, natural skin tone, and overall age impression from the selected identity references.",
          "Do not create a different person. Do not beautify into a new face. Do not change ethnicity, age impression, body type, face structure, or hairstyle logic.",
          "Wardrobe rule: the identity reference only defines the model's face and body. Replace the reference outfit with the current product clothing. The current product must look worn on this same model, not on a new model.",
          "Weighted movement readiness: pose the body with believable physical mass and grounded balance. Feet, knees, hips, shoulders, hands, and fabric should imply real gravity and inertia, not a floating mannequin pose. Clothing hems, sleeves, straps, ties, and loose fabric must show natural tension, drape, and momentum consistent with the shot action.",
          "Soulful eyes and micro-expression rule: include clear catchlights, focused gaze direction, and subtle shot-specific emotion in the eyes, brows, cheeks, and mouth. Avoid vacant eyes, frozen blank face, plastic skin, exaggerated beauty retouching, or an expression that changes the model identity.",
          "Facial performance rule: do not apply a fixed expression template. Follow the shot-specific facial expression and mouth-shape described in the canonical script prompt. If the script prompt is missing facial performance, infer one only from this shot's voiceover, emotional role, and product action; keep it restrained and unique to this shot. Avoid exaggerated laughter, over-open mouth, stiff frozen face, distorted lips, or expression changes that alter identity.",
        ].join("\n")
      : "";

    const directorFrame = [
      "OUTPUT FORMAT: one single vertical 9:16 storyboard keyframe, not a poster, not a collage, not split screen, not multiple panels, not before-and-after layout.",
      "No generated text, no Chinese characters, no English labels, no price tags, no UI icons, no subtitles, no watermark-like graphic overlays.",
      "TEXT AND WATERMARK BAN: no readable text, no logo, no signature, no faint corner watermark, no stock-photo watermark, no Chinese characters, no letters, and no numbers anywhere in the frame. Keep all corners visually clean.",
      cloneFacts.length > 0
        ? "Photorealistic raw phone-recorded fashion-account video keyframe, natural body/object structure, believable material physics, imperfect handheld composition, slight phone compression, and real street or mirror-capture texture."
        : "Photorealistic commercial ecommerce keyframe, natural body/object structure, stable exposure, clean composition, believable material physics.",
      "Camera must be specific and simple: one camera angle, one main subject, one clear composition, realistic depth of field.",
      "Lighting should be defined by the shot: soft directional daylight or controlled studio light, gentle shadows, true product texture, no overexposure on key product details.",
      cloneFacts.length > 0
        ? "Account-template feeling must come from real capture evidence: mirror/reflection edge, off-center framing, street anchors, tree-shadow rhythm, natural posture, garment physics, and a frame caught during motion; do not polish it into a studio lookbook."
        : "Premium feeling must come from accurate material detail, restrained styling, clean background, natural posture or product placement, and stable composition, not from vague luxury props.",
    ].join("\n");

    const cloneFrameStyle = cloneFacts.length > 0
      ? [
          "HIGH-SIMILARITY CLONE ASSET FRAME STYLE:",
          "This is not a clean catalog photo. Generate an editable no-text fashion video keyframe that can become part of a high-similarity ecommerce clone workflow.",
          "For outdoor mirror selfie or street OOTD methods, use a real vertical fashion video keyframe look: asymmetric composition, model slightly off-center, mid-motion outfit pose, phone mirror selfie logic, outdoor full-length mirror or storefront-window/glass-door reflection edge, dappled hard tree sunlight, parked car and sidewalk anchors, natural street reflections, believable handheld camera framing.",
          "Keep the frame closer to a phone-recorded fashion-account capture than a refined commercial still: imperfect crop, realistic mirror/reflection edge, slight compression, uneven natural street shadows, and a body pose caught during movement.",
          "For a 7-slot clone asset package, avoid over-producing close-ups. A1, A3, A6, and A7 should be full-body or 3/4-body whenever the clone plan permits; A4/A5 are the main product-structure/detail slots.",
          "Keep natural composition space where an editor may later add title or subtitle overlays, but do not generate any text, status bar, progress bar, watermark, logo, account name, or app interface.",
          "The image must serve its segment role: first-frame anchor, motion pose, product structure, product detail, scene anchor, identity angle, or transition reference. Do not repeat the same standing full-body mirror selfie for every asset.",
        ].join("\n")
      : "";

    const assetPackageRules = [
      "ECOMMERCE ASSET PACKAGE RULES:",
      "This keyframe belongs to a multi-shot ecommerce asset package. Keep the same model, same face, same hairstyle, same body proportions, same skin tone, and same current product outfit across all person shots in this project.",
      "Generate only what the script needs: if the script needs side face, show side face; if it needs back view, show back view; if it needs a walking or try-on action, show the corresponding body posture; if it needs phone, coffee, bag, or document, show only that prop in a product-safe way.",
      "Do not add content that is not in the script. Do not invent extra people, extra accessories, brand marks, functional claims, text labels, or decorative props.",
      "Every keyframe must serve one asset purpose: full-body outfit, script-required model angle/action, product detail, or product/prop use state.",
      "For clone projects, every 10-second segment should form a complete 7-slot asset package: A1 first-frame composition, A2 identity/expression, A3 product-on-body structure, A4 product front structure, A5 product detail interaction, A6 motion transition pose, A7 ending continuity anchor. Each slot must carry the exact same product garment.",
      cloneFacts.length > 0 ? "For clone A3 and A6, do not use generic product close-up logic. Use the selected method's natural body framing: outdoor/home mirror usually full-body or 3/4-body, car OOTD seated 2/3-body or waist-up inside the car, and brand/magazine method-appropriate editorial/ad framing." : "",
      "For clothing, lock mutation-prone areas: collar/neckline, sleeve shape and length, hem, waistline, opening/placket, tie/belt/strap, pocket line, trim color, fabric texture, silhouette, length, and front/back/side differences.",
      "If the product is shown on a model, the product clothing must replace the identity-reference outfit while preserving the current product structure exactly.",
      cloneFacts.length > 0 ? "HIGH-SIMILARITY CLONE WORKFLOW RULE: this project came from a reference-video clone plan. Use the clone workflow facts above as the asset-package guide. The keyframe must serve the clone asset plan first, then the shot script, while still keeping product and identity locks highest priority." : "",
    ].join("\n");

    const shotDirector: Record<Shot["type"], string> = {
      hook: "Shot role: opening hook. Make the product or product benefit readable immediately, using one clear visual idea only.",
      pain_point: "Shot role: pain point. Show one realistic user problem or contrast without split-screen, exaggerated body/product claims, or distracting extra elements.",
      product_reveal: "Shot role: product reveal. Product-first keyframe with the most important structure, material, packaging, pattern, or functional detail clearly visible.",
      demo: "Shot role: demo. Show one simple realistic use, try-on, operation, handling, or material proof action that can fit this shot duration.",
      social_proof: "Shot role: trust/lifestyle proof. Show the product in a believable usage/lifestyle context with one clear main subject; avoid unrelated people looking at camera.",
      cta: "Shot role: closing frame. Clean product hero composition with blank safe space reserved for later manual overlay; no generated price text or shopping icons.",
    };

    return joinUniqueTextSections([
      productLock,
      identityLock,
      directorFrame,
      cloneFrameStyle,
      assetPackageRules,
      cloneFacts.length > 0 ? cloneAssetRoleInstruction(asset) : shotDirector[asset.shotType],
      asciiOnly(asset.prompt) ? `Canonical English shot prompt from script: ${asciiOnly(asset.prompt)}` : "",
      cloneFacts.length > 0 ? "" : inferProductPresentation(asset),
      cloneFacts.length > 0 ? "" : `English shot intent: ${englishShotIntent(asset)}`,
      "Consistency priority: product accuracy is more important than scene beauty. If product accuracy conflicts with styling, simplify the scene and keep the exact product. If person consistency conflicts with dramatic styling, keep person consistency.",
      `Negative constraints: ${categoryNegativeConstraints(project?.productCategory)}.`,
    ], "\n");
  }, [data?.project, selectedIdentityImageUrls]);

  const buildImageRequestForAsset = useCallback((asset: AssetItem) => {
    const referenceImages = uniqueStrings(chooseReferenceImages(asset, productReferenceImages, selectedIdentityImageUrls));
    const prompt = buildProductLockedPrompt(asset, referenceImages);

    return {
      prompt,
      referenceImage: referenceImages[0] ?? null,
      referenceImages,
      mode: referenceImages.length > 0 ? "image-to-image" as const : "text-to-image" as const,
    };
  }, [buildProductLockedPrompt, productReferenceImages, selectedIdentityImageUrls]);

  const buildImageRequestForSegment = useCallback((segmentAssets: AssetItem[]) => {
    const assetsToGenerate = segmentAssets.filter((asset) => asset.visualSource !== "user_upload");
    const referenceImages = uniqueStrings(assetsToGenerate.flatMap((asset) => chooseReferenceImages(asset, productReferenceImages, selectedIdentityImageUrls)));
    const firstAsset = assetsToGenerate[0];
    const firstPrompt = firstAsset ? buildProductLockedPrompt(firstAsset, referenceImages) : "";
    const commonPrompt = extractCommonImagePrompt(firstPrompt);
    const prompt = buildMultiAssetPrompt(commonPrompt, assetsToGenerate);

    return {
      prompt,
      referenceImage: referenceImages[0] ?? null,
      referenceImages,
      mode: referenceImages.length > 0 ? "image-to-image" as const : "text-to-image" as const,
      assets: assetsToGenerate,
    };
  }, [buildProductLockedPrompt, productReferenceImages, selectedIdentityImageUrls]);

  const openPromptPreview = useCallback((asset: AssetItem) => {
    const imageRequest = buildImageRequestForAsset(asset);
    const scriptPrompt = [
      `分镜 ${String(asset.shotId).padStart(2, "0")}`,
      asset.description ? `中文画面描述：${asset.description}` : "",
      asset.assetRole ? `资产角色：${asset.assetRole}` : "",
      asset.segmentIndex ? `所属分段：S${asset.segmentIndex}` : "",
      asset.prompt && hasCjkText(asset.prompt) ? `中文脚本提示词：${asset.prompt}` : "",
      asset.voiceover ? `口播：${asset.voiceover}` : "",
      asset.prompt && !hasCjkText(asset.prompt) ? "提示：脚本原始 prompt 是英文，左侧隐藏；右侧显示真实提交给 image-2 的英文最终 prompt。" : "",
    ].filter(Boolean).join("\n\n");

    setPromptPreview({
      title: `Shot ${String(asset.shotId).padStart(2, "0")} prompt preview`,
      scriptPrompt,
      finalPrompt: imageRequest.prompt,
      referenceImages: imageRequest.referenceImages,
    });
  }, [buildImageRequestForAsset]);

  const openSegmentPromptPreview = useCallback((segmentIndex: number, segmentAssets: AssetItem[]) => {
    const imageRequest = buildImageRequestForSegment(segmentAssets);
    const scriptPrompt = [
      `爆款复刻分段 S${segmentIndex}：一次点击生成 ${imageRequest.assets.length} 张资产图`,
      "接口执行方式：系统会按 A1-A7 逐张提交 image-2，每次 count=1，哪张成功就立刻保存到对应资产卡。",
      "保守队列：每张成功后等待 25 秒再请求下一张；如果某张失败，队列会停住，未完成的卡片保留为重试状态。",
      "这样可以避免上游批量返回数量不足或连续请求不稳定时，已经付费生成的图片因为顺序不完整而被整段丢弃。",
      "",
      ...imageRequest.assets.map((asset, index) => [
        `A${index + 1} / Shot ${String(asset.shotId).padStart(2, "0")}`,
        asset.assetRole ? `资产角色：${asset.assetRole}` : "",
        asset.description ? `中文资产说明：${asset.description}` : "",
        asset.prompt ? `英文资产 prompt：${asciiOnly(asset.prompt)}` : "",
      ].filter(Boolean).join("\n")),
    ].filter(Boolean).join("\n\n");

    setPromptPreview({
      title: `Segment ${segmentIndex} image-2 prompt overview`,
      scriptPrompt,
      finalPrompt: imageRequest.prompt,
      referenceImages: imageRequest.referenceImages,
    });
  }, [buildImageRequestForSegment]);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
  }, []);

  const generateOne = useCallback(async (asset: AssetItem) => {
    if (asset.visualSource === "user_upload") {
      updateLocalAsset(asset.shotId, { status: "failed" });
      setError("This shot requires a user-uploaded asset before generation can continue.");
      return;
    }

    if (!canUseImage2) {
      setError("Please enable the OpenAI / Seedance image provider and configure image API credentials first.");
      return;
    }

    updateLocalAsset(asset.shotId, { status: "generating" });
    setError(null);
    const startedAt = Date.now();
    updateAssetProgress({
      percentage: 8,
      stage: `Shot ${asset.shotId}: preparing image request`,
      detail: "Building product-locked prompt and selecting the latest product reference image.",
      startedAt,
    });

    try {
      const imageRequest = buildImageRequestForAsset(asset);

      updateAssetProgress({
        percentage: 18,
        stage: `Shot ${asset.shotId}: calling image API`,
        detail: imageRequest.referenceImage
          ? "Real request sent with a product reference image."
          : "Real request sent without a product reference image.",
        startedAt,
      });

      const response = await fetch("/api/ai/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai-seedance",
          model: imageModel,
          prompt: imageRequest.prompt,
          imageUrl: imageRequest.referenceImage,
          imageUrls: imageRequest.referenceImages,
          mode: imageRequest.mode,
          apiKey: imageChannel?.apiKey,
          baseUrl: imageChannel?.baseUrl,
          imageApiKey: imageChannel?.apiKey,
          imageBaseUrl: imageChannel?.baseUrl,
          projectId: id,
          versionId: versionId || undefined,
          shotId: asset.shotId,
          options: imageRequestOptions,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "image-2 generation failed");

      updateAssetProgress({
        percentage: 82,
        stage: `Shot ${asset.shotId}: image API returned`,
        detail: "The provider returned a result. Saving it to the local project now.",
        startedAt,
      });

      const imageUrl = result.imageUrls?.[0];
      if (!imageUrl) throw new Error("image-2 did not return an image URL");

      const saved = await persistAsset(
        { ...asset, assetType: "ai_generated", prompt: imageRequest.prompt },
        imageUrl
      );
      updateLocalAsset(asset.shotId, {
        id: saved.id,
        status: "done",
        filePath: imageUrl,
        thumbnailPath: imageUrl,
        provider: "openai-seedance",
        model: imageModel,
      });
      await loadAssets(true);
      updateAssetProgress({
        percentage: 100,
        stage: `Shot ${asset.shotId}: done`,
        detail: "Image result saved to local project assets.",
        startedAt,
      });
    } catch (err) {
      updateLocalAsset(asset.shotId, { status: "failed" });
      const message = err instanceof Error ? err.message : "image-2 generation failed";
      setError(message);
      updateAssetProgress({
        percentage: 100,
        stage: `Shot ${asset.shotId}: failed`,
        detail: message,
        startedAt,
      });
    }
  }, [buildImageRequestForAsset, canUseImage2, id, imageChannel?.apiKey, imageChannel?.baseUrl, imageModel, imageRequestOptions, loadAssets, persistAsset, updateAssetProgress, updateLocalAsset, versionId]);

  const generateCloneSegmentBatch = useCallback(async (segmentAssets: AssetItem[], forceRegenerate = false) => {
    const pending = forceRegenerate
      ? segmentAssets.filter((asset) => asset.visualSource !== "user_upload")
      : segmentAssets.filter((asset) => asset.status === "pending" || asset.status === "failed");
    if (pending.length === 0) {
      setAssetProgress(null);
      return;
    }
    const startedAt = Date.now();
    const segmentIndex = pending[0]?.segmentIndex ?? Math.floor((pending[0]?.shotId ?? 1) / 7) + 1;
    setActiveCloneSegmentIndex(segmentIndex);
    if (pending.length === 1) {
      try {
        await generateOne(pending[0]);
      } finally {
        setActiveCloneSegmentIndex(null);
      }
      return;
    }
    if (!canUseImage2) {
      setActiveCloneSegmentIndex(null);
      setError("Please enable the OpenAI / Seedance image provider and configure image API credentials first.");
      return;
    }
    setError(null);
    updateAssetProgress({
      percentage: 8,
      stage: `Segment ${segmentIndex}: preparing ${pending.length} image-2 assets`,
      detail: "Building one shared product/identity/method contract plus numbered A1-A7 asset prompts.",
      startedAt,
    });

    let activeShotId: number | null = null;
    try {
      updateAssetProgress({
        percentage: 18,
        stage: `Segment ${segmentIndex}: calling image-2 one asset at a time`,
        detail: "Each A1-A7 asset is submitted as count=1 and saved immediately after it returns, so a partial provider response will not waste successful paid images.",
        startedAt,
      });

      for (const [index, asset] of pending.entries()) {
        activeShotId = asset.shotId;
        const assetRequest = buildImageRequestForAsset(asset);
        updateLocalAsset(asset.shotId, { status: "generating" });
        updateAssetProgress({
          percentage: 18 + Math.round((index / pending.length) * 64),
          stage: `Segment ${segmentIndex}: image-2 asset ${index + 1}/${pending.length}`,
          detail: `Generating shot ${asset.shotId}${asset.assetRole ? ` (${asset.assetRole})` : ""} with count=1.`,
          startedAt,
        });

        const response = await fetch("/api/ai/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "openai-seedance",
            model: imageModel,
            prompt: assetRequest.prompt,
            imageUrl: assetRequest.referenceImage,
            imageUrls: assetRequest.referenceImages,
            mode: assetRequest.mode,
            apiKey: imageChannel?.apiKey,
            baseUrl: imageChannel?.baseUrl,
            imageApiKey: imageChannel?.apiKey,
            imageBaseUrl: imageChannel?.baseUrl,
            projectId: id,
            versionId: versionId || undefined,
            shotId: asset.shotId,
            options: imageRequestOptions,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `image-2 asset ${index + 1} generation failed`);
        const imageUrl = Array.isArray(result.imageUrls) ? result.imageUrls.find(Boolean) : null;
        if (!imageUrl) {
          throw new Error(`image-2 asset ${index + 1}/${pending.length} did not return an image URL.`);
        }

        const saved = await persistAsset(
          { ...asset, assetType: "ai_generated", prompt: assetRequest.prompt },
          imageUrl
        );
        activeShotId = null;
        updateLocalAsset(asset.shotId, {
          id: saved.id,
          status: "done",
          filePath: imageUrl,
          thumbnailPath: imageUrl,
          provider: "openai-seedance",
          model: imageModel,
        });

        if (index < pending.length - 1) {
          updateAssetProgress({
            percentage: 18 + Math.round(((index + 1) / pending.length) * 64),
            stage: `Segment ${segmentIndex}: cooling down before next image-2 asset`,
            detail: "Waiting 25 seconds before the next asset request to reduce upstream image-2 edit failures.",
            startedAt,
          });
          await delay(25000);
        }
      }

      updateAssetProgress({
        percentage: 82,
        stage: `Segment ${segmentIndex}: all image-2 assets returned`,
        detail: "Refreshing local project records and previews.",
        startedAt,
      });

      await loadAssets(true);
      updateAssetProgress({
        percentage: 100,
        stage: `Segment ${segmentIndex}: done`,
        detail: `Saved ${pending.length} image-2 assets. Each asset was generated and stored independently.`,
        startedAt,
      });
      setActiveCloneSegmentIndex(null);
    } catch (err) {
      if (activeShotId !== null) {
        updateLocalAsset(activeShotId, { status: "failed" });
      }
      const message = err instanceof Error ? err.message : "image-2 segment generation failed";
      setError(message);
      updateAssetProgress({
        percentage: 100,
        stage: `Segment ${segmentIndex}: failed`,
        detail: message,
        startedAt,
      });
      setActiveCloneSegmentIndex(null);
    }
  }, [buildImageRequestForAsset, canUseImage2, generateOne, id, imageChannel?.apiKey, imageChannel?.baseUrl, imageModel, imageRequestOptions, loadAssets, persistAsset, updateAssetProgress, updateLocalAsset, versionId]);

  const generateAll = useCallback(async () => {
    const pending = assets.filter((asset) => asset.status === "pending" || asset.status === "failed");
    if (pending.length === 0) {
      setAssetProgress(null);
      return;
    }

    setIsBatchGenerating(true);
    try {
      if (isCloneAssetPackage) {
        for (const segment of cloneAssetSegments) {
          await generateCloneSegmentBatch(segment.assets);
        }
      } else {
        for (const asset of pending) {
          await generateOne(asset);
        }
      }
    } finally {
      setIsBatchGenerating(false);
    }
  }, [assets, cloneAssetSegments, generateCloneSegmentBatch, generateOne, isCloneAssetPackage]);

  const generateSegmentAssets = useCallback(async (segmentAssets: AssetItem[], forceRegenerate = false) => {
    if (isCloneAssetPackage) {
      setIsBatchGenerating(true);
      try {
        await generateCloneSegmentBatch(segmentAssets, forceRegenerate);
      } finally {
        setIsBatchGenerating(false);
      }
      return;
    }
    const pending = forceRegenerate
      ? segmentAssets.filter((asset) => asset.visualSource !== "user_upload")
      : segmentAssets.filter((asset) => asset.status === "pending" || asset.status === "failed");
    if (pending.length === 0) {
      setAssetProgress(null);
      return;
    }

    setIsBatchGenerating(true);
    try {
      for (const asset of pending) {
        await generateOne(asset);
      }
    } finally {
      setIsBatchGenerating(false);
    }
  }, [generateCloneSegmentBatch, generateOne, isCloneAssetPackage]);

  const regenerateAiAssets = useCallback(async () => {
    if (generatableAssets.length === 0) {
      setAssetProgress(null);
      return;
    }

    setIsBatchGenerating(true);
    try {
      if (isCloneAssetPackage) {
        for (const segment of cloneAssetSegments) {
          await generateCloneSegmentBatch(segment.assets, true);
        }
      } else {
        for (const asset of generatableAssets) {
          await generateOne(asset);
        }
      }
    } finally {
      setIsBatchGenerating(false);
    }
  }, [cloneAssetSegments, generatableAssets, generateCloneSegmentBatch, generateOne, isCloneAssetPackage]);

  const progressWidth = useMemo(() => {
    if (assets.length === 0) return "0%";
    return `${(doneCount / assets.length) * 100}%`;
  }, [assets.length, doneCount]);

  const renderAssetCard = useCallback((asset: AssetItem, labelPrefix = "Shot") => {
    const typeInfo = shotTypeLabels[asset.shotType];
    const preview = asset.thumbnailPath || asset.filePath;
    const previewSrc = imageSrcWithReloadToken(preview);
    return (
      <Card key={asset.shotId} className="glass-card overflow-hidden">
        <CardContent className="p-0">
          <div className="flex">
            <div className="flex w-16 shrink-0 flex-col items-center justify-center border-r border-border/50 py-4">
              <span className="text-lg font-bold text-muted-foreground/50">{String(asset.shotId).padStart(2, "0")}</span>
              <Badge className={`${typeInfo.color} mt-1 border-0 text-[10px]`}>{typeInfo.label}</Badge>
              {asset.segmentIndex && <span className="mt-1 text-[10px] text-primary">S{asset.segmentIndex}</span>}
            </div>

            <div className="flex-1 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {asset.assetRole && <Badge variant="outline" className="text-[10px]">{asset.assetRole}</Badge>}
                {isCloneAssetPackage && <Badge variant="secondary" className="text-[10px]">爆款资产包</Badge>}
              </div>
              <p className="mb-2 text-sm leading-relaxed">{asset.description}</p>
              {asset.prompt && (
                <div className="mb-2 rounded bg-muted/20 px-2 py-1.5">
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    Prompt: {asset.prompt}
                  </p>
                  <button
                    type="button"
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    onClick={() => openPromptPreview(asset)}
                  >
                    <LuFileText className="h-3 w-3" />
                    预览最终 image-2 提示词
                  </button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{asset.visualSource === "product_image" ? `商品图参考 / ${imageModel}` : asset.visualSource === "ai_generate" ? `AI 生成 / ${imageModel}` : "用户上传"}</span>
                {asset.model && <span>模型：{asset.model}</span>}
                {!asset.prompt && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                    onClick={() => openPromptPreview(asset)}
                  >
                    <LuFileText className="h-3 w-3" />
                    预览提示词
                  </button>
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-col items-center justify-center gap-2 p-4">
              <button
                className="flex h-16 w-24 items-center justify-center overflow-hidden rounded-md border border-border/30 bg-muted/30"
                disabled={!preview}
                onClick={() => preview && setPreviewUrl(preview)}
              >
                {asset.status === "done" && preview ? (
                  <img
                    src={previewSrc ?? preview}
                    alt={`${labelPrefix}-${asset.shotId}`}
                    className="h-full w-full object-cover"
                    onError={() => retryImagePreview(preview)}
                  />
                ) : asset.status === "done" ? (
                  <LuCheck className="h-5 w-5 text-primary" />
                ) : asset.status === "generating" ? (
                  <LuRefreshCw className="h-5 w-5 animate-spin text-primary" />
                ) : asset.status === "failed" ? (
                  <LuCircleX className="h-5 w-5 text-destructive" />
                ) : (
                  <LuImage className="h-4 w-4 text-muted-foreground/40" />
                )}
              </button>

              <Button
                variant="outline"
                size="sm"
                className="w-24 text-xs"
                disabled={asset.status === "generating"}
                onClick={() => generateOne(asset)}
              >
                {asset.status === "generating" ? "生成中..." : asset.status === "done" ? "重新生成" : asset.status === "failed" ? "重试" : "生成素材"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }, [generateOne, imageModel, imageSrcWithReloadToken, isCloneAssetPackage, openPromptPreview, retryImagePreview]);

  return (
    <div className="min-h-screen grid-bg">
      {previewUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6" onClick={() => setPreviewUrl(null)}>
          <button
            className="absolute right-6 top-6 rounded-full border border-white/20 bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setPreviewUrl(null)}
          >
            <LuX className="h-5 w-5" />
          </button>
          <img
            src={imageSrcWithReloadToken(previewUrl) ?? previewUrl}
            alt="分镜图片预览"
            className="max-h-[88vh] max-w-[88vw] rounded-xl object-contain shadow-2xl"
            onError={() => retryImagePreview(previewUrl)}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}

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
                  左侧是中文说明；右侧是本次真实提交给 image-2 的最终提示词。
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
                  <h4 className="text-sm font-medium">{isCloneAssetPackage ? "中文资产说明" : "中文脚本提示词"}</h4>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void copyText(promptPreview.scriptPrompt)}>
                    <LuCopy className="mr-1 h-3.5 w-3.5" />
                    复制中文
                  </Button>
                </div>
                <pre className="max-h-[52vh] whitespace-pre-wrap rounded-xl border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-foreground">
                  {promptPreview.scriptPrompt}
                </pre>
              </section>

              <section className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">最终给 image-2 的提示词</h4>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void copyText(promptPreview.finalPrompt)}>
                    <LuCopy className="mr-1 h-3.5 w-3.5" />
                    复制最终
                  </Button>
                </div>
                {promptPreview.referenceImages.length > 0 && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2">
                    {promptPreview.referenceImages.map((image, index) => (
                      <div key={`${image}-${index}`} className="flex items-center gap-1.5">
                        <img src={image} alt={`selected-reference-${index + 1}`} className="h-12 w-12 rounded-md object-cover" />
                        <span className="text-[10px] text-muted-foreground">{index === 0 ? "商品图" : "身份图"}</span>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">本镜头会带这些参考图一起提交。</p>
                  </div>
                )}
                <pre className="max-h-[52vh] whitespace-pre-wrap rounded-xl border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-foreground">
                  {promptPreview.finalPrompt}
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
            <span className="text-sm text-muted-foreground">{data?.project.name ?? "项目素材"}</span>
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
                <div className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${i === 1 ? "bg-primary text-primary-foreground" : i < 1 ? "text-primary" : "text-muted-foreground"}`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i === 1 ? "bg-white/20" : i < 1 ? "bg-primary/20" : "bg-muted"}`}>
                    {i < 1 ? "✓" : i + 1}
                  </span>
                  {step}
                </div>
                {i < 3 && <div className="mx-1 h-px w-4 bg-border" />}
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{isCloneAssetPackage ? "爆款复刻资产包生成" : "素材生成"}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {isLoading ? "正在读取真实项目数据..." : isCloneAssetPackage ? `${doneCount}/${assets.length} 张资产图已就绪` : `${doneCount}/${assets.length} 个素材已就绪`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href={`/project/${id}/script${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`}>
              <Button variant="outline" size="sm" className="text-xs">
                <LuArrowLeft className="mr-1 h-3.5 w-3.5" />
                返回脚本
              </Button>
            </Link>
            <Button
              onClick={generateAll}
              disabled={isBatchGenerating || allDone || isLoading || assets.length === 0}
              className="brand-gradient text-xs text-white"
            >
              {isBatchGenerating ? (
                <>
                  <LuRefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  生成中...
                </>
              ) : allDone ? (
                "全部完成"
              ) : (
                <>
                  <LuZap className="mr-1 h-3.5 w-3.5" />
                  {isCloneAssetPackage ? "生成全部资产包" : "一键全部生成"}
                </>
              )}
            </Button>
            <Button
              onClick={regenerateAiAssets}
              disabled={isBatchGenerating || isLoading || generatableAssets.length === 0}
              variant="outline"
              className="text-xs"
            >
              <LuRefreshCw className="mr-1 h-3.5 w-3.5" />
              {isCloneAssetPackage ? "重新生成资产包" : "重新生成分镜图片"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <ProjectVersionBar
          projectId={id}
          onRegenerateAssets={() => void regenerateAiAssets()}
          regenerateAssetsDisabled={isBatchGenerating || isLoading || generatableAssets.length === 0}
        />
        <ProjectLocalArchive projectId={id} versionId={versionId} />

        {!canUseImage2 && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">
            AI 生成镜头会调用 image-2。当前未检测到已启用的“自有 OpenAI / Seedance”生图配置，商品图镜头不受影响。
          </div>
        )}

        <Card className="glass-card mb-4">
          <CardContent className="p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Product reference images for storyboard generation</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add or remove product images here before generating storyboards. The next image-2 call will use this latest list.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <input
                  ref={productImageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void handleAddProductImages(event.target.files);
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={isUpdatingProductImages || productReferenceImages.length >= 8}
                  onClick={() => productImageInputRef.current?.click()}
                >
                  {isUpdatingProductImages ? (
                    <LuRefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LuUpload className="mr-1 h-3.5 w-3.5" />
                  )}
                  Add image
                </Button>
              </div>
            </div>

            {productReferenceImages.length > 0 ? (
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 md:grid-cols-8">
                {productReferenceImages.map((image, index) => (
                  <div key={image} className="group relative overflow-hidden rounded-lg border border-border/50 bg-muted/20">
                    <button
                      type="button"
                      className="block aspect-square w-full"
                      onClick={() => setPreviewUrl(image)}
                    >
                      <img src={image} alt={`product-reference-${index + 1}`} className="h-full w-full object-cover" />
                    </button>
                    <div className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                      #{index + 1}
                    </div>
                    <button
                      type="button"
                      className="absolute right-1 top-1 rounded bg-black/65 p-1 text-white opacity-0 transition group-hover:opacity-100"
                      disabled={isUpdatingProductImages}
                      onClick={() => void handleRemoveProductImage(image)}
                      title="Remove this product reference image"
                    >
                      <LuTrash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">
                No product reference image is attached. Storyboard images can still be generated from text, but product consistency will be weaker.
              </div>
            )}

            <p className="mt-3 text-[11px] text-muted-foreground">
              Reference selection is automatic per shot: model/try-on shots prefer the second image, flat-lay/detail/product shots prefer the third or first image.
            </p>
          </CardContent>
        </Card>

        <div className="mb-6">
          <div className="h-2 overflow-hidden rounded-full bg-muted/30">
            <div className="h-full rounded-full brand-gradient transition-all duration-700" style={{ width: progressWidth }} />
          </div>
        </div>

        {assetProgress && (
          <GenerationProgress
            className="mb-6"
            title="Storyboard image generation monitor"
            active={isAssetProgressActive}
            percentage={assetProgress.percentage}
            elapsedSeconds={assetProgress.elapsedSeconds}
            etaSeconds={assetProgress.etaSeconds}
            stage={assetProgress.stage}
            detail={assetProgress.detail}
          />
        )}

        {isLoading ? (
          <Card className="glass-card">
            <CardContent className="p-8 text-center text-sm text-muted-foreground">正在加载素材链路...</CardContent>
          </Card>
        ) : !data?.script && !isCloneAssetPackage ? (
          <Card className="glass-card">
            <CardContent className="p-8 text-center">
              <p className="text-sm font-medium">还没有可用脚本</p>
              <p className="mt-1 text-xs text-muted-foreground">请先返回脚本页生成并选择脚本。</p>
            </CardContent>
          </Card>
        ) : assets.length === 0 ? (
          <Card className="glass-card">
            <CardContent className="p-8 text-center text-sm text-muted-foreground">当前脚本没有分镜素材。</CardContent>
          </Card>
        ) : isCloneAssetPackage ? (
          <div className="space-y-6">
            <Card className="glass-card border-primary/25">
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">爆款复刻资产包</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      这里不是普通项目的 6 个分镜图，而是根据完整视频导演稿按时间段反推出的参考资产包。请先逐段验收提示词，确认后可点击每段资产包单独生成。每段资产包仍生成 7 张资产图；进入视频页后会额外追加 1 张商品正面结构锁图做试验输入。
                    </p>
                  </div>
                  <Badge variant="secondary">{cloneAssetSegments.length} 段</Badge>
                </div>
                <div className="grid gap-3 pt-2 md:grid-cols-3">
                  <details className="rounded-xl border border-border/40 bg-muted/20 p-3">
                    <summary className="cursor-pointer text-xs font-medium">商品视觉分析</summary>
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(parsedAnalysis?.productVisualAnalysis || clonePlan.productVisualAnalysis || {}, null, 2)}
                    </pre>
                  </details>
                  <details className="rounded-xl border border-border/40 bg-muted/20 p-3">
                    <summary className="cursor-pointer text-xs font-medium">商品结构锁</summary>
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(parsedAnalysis?.productStructureLock || clonePlan.productStructureLock || {}, null, 2)}
                    </pre>
                  </details>
                  <details className="rounded-xl border border-border/40 bg-muted/20 p-3">
                    <summary className="cursor-pointer text-xs font-medium">质量验收检查</summary>
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(clonePlan.qualityChecklist || [], null, 2)}
                    </pre>
                  </details>
                </div>
              </CardContent>
            </Card>

            {cloneAssetSegments.map((segment) => {
              const segmentDoneCount = segment.assets.filter((asset) => asset.status === "done").length;
              const segmentPendingCount = segment.assets.filter((asset) => asset.status === "pending" || asset.status === "failed").length;
              const segmentAllDone = segmentDoneCount === segment.assets.length;
              const isActiveSegment = activeSegmentIndex === segment.segmentIndex;
              return (
                <section key={segment.segmentIndex} className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-border/40 bg-muted/15 px-4 py-3">
                    <div>
                      <h3 className="text-sm font-semibold">视频任务 {segment.segmentIndex} 参考资产</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                        本段 {segmentDoneCount}/{segment.assets.length} 张已完成。提示词来自完整导演稿对应时间段；生成时会按 A1-A7 逐张提交 image-2，成功一张保存一张，每张之间冷却 25 秒。
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={segmentDoneCount === segment.assets.length ? "secondary" : "outline"}>
                        {segment.assets.length} 张
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={segment.assets.length === 0}
                        onClick={() => openSegmentPromptPreview(segment.segmentIndex, segment.assets)}
                      >
                        预览本段批量提示词
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isBatchGenerating || !canUseImage2}
                        onClick={() => generateSegmentAssets(segment.assets, segmentAllDone)}
                      >
                        {isBatchGenerating
                          ? isActiveSegment
                            ? "本段队列运行中"
                            : "等待当前段完成"
                          : segmentAllDone
                            ? "重新生成本段资产包"
                            : `生成本段资产包 (${segmentPendingCount})`}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-4">
                    {segment.assets.map((asset) => renderAssetCard(asset, `clone-segment-${segment.segmentIndex}`))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="space-y-4">
            {assets.map((asset) => renderAssetCard(asset))}
          </div>
        )}

        <div className="mt-8 flex justify-end">
          <Link href={allDone ? `/project/${id}/video${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}` : "#"}>
            <Button className="brand-gradient text-sm text-white" disabled={!allDone}>
              {isCloneAssetPackage ? "下一步：生成完整视频" : "下一步：合成视频"}<LuArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
