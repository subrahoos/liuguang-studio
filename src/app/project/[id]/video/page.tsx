"use client";

/* eslint-disable @next/next/no-img-element -- Generated local video frames and data URLs require native image loading. */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LuArrowLeft, LuPlay, LuChevronDown, LuArrowRight, LuImage, LuCopy, LuFileText, LuVideo, LuHouse } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { GenerationProgress } from "@/components/generation-progress";
import { ProjectLocalArchive } from "@/components/project-local-archive";
import { ProjectVersionBar } from "@/components/project-version-bar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatOmniDurationPlan, isGrokVideoModel, isSegmentedVideoModel, splitSegmentedVideoDurations, sumOmniDurations } from "@/lib/omni-video";
import { uniqueStrings } from "@/lib/prompt-dedup";
import { getActiveVideoChannel, getReadyVideoChannels, hasProviderCredential, useSettingsStore } from "@/lib/stores/settings-store";
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
    productAnalysis?: string | null;
    productImages?: string[];
    sourceType?: "manual" | "clone" | null;
    videoAspectRatio?: "9:16" | "16:9" | "1:1" | null;
    videoResolution?: "720p" | "1080p" | null;
    imageChannelId?: string | null;
    videoChannelId?: string | null;
    characterId?: string | null;
    currentVersion?: { configSnapshot?: Record<string, unknown> | null } | null;
  };
  script: {
    id: string;
    title: string | null;
  } | null;
  assets: AssetItem[];
}

interface ComposeConfig {
  ttsEnabled: boolean;
  ttsVoice: string;
  bgm: string;
  subtitlePosition: "bottom" | "center" | "top";
  aspectRatio: "9:16" | "16:9" | "1:1";
  resolution: "720p" | "1080p";
}

const transitionLabels: Record<Shot["transition"], string> = {
  ai_start_end: "AI 智能过渡",
  ai_reference: "AI 参考过渡",
  direct_concat: "直接拼接",
  ffmpeg_fade: "渐变过渡",
};

const shotTypeLabels: Record<Shot["type"], { label: string; color: string }> = {
  hook: { label: "钩子", color: "bg-red-500/20 text-red-400" },
  pain_point: { label: "痛点", color: "bg-orange-500/20 text-orange-400" },
  product_reveal: { label: "产品", color: "bg-blue-500/20 text-blue-400" },
  demo: { label: "演示", color: "bg-green-500/20 text-green-400" },
  social_proof: { label: "背书", color: "bg-purple-500/20 text-purple-400" },
  cta: { label: "转化", color: "bg-amber-500/20 text-amber-400" },
};

type VideoJobStatus = "idle" | "queued" | "running" | "done" | "failed";

interface VideoJob {
  status: VideoJobStatus;
  error?: string;
  videoUrls?: string[];
}

interface SavedVideoClip {
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

interface PromptJob {
  status: "idle" | "running" | "done" | "failed";
  method?: string;
  error?: string;
}

interface VideoRequestDraft {
  prompt: string;
  imageUrl: string | null;
  width: number;
  height: number;
}

interface CloneReferenceImage {
  url: string;
  role: string;
  note: string;
  source: "asset" | "product" | "anchor";
}

interface VideoProgressState {
  active: boolean;
  percentage: number;
  elapsedSeconds: number;
  etaSeconds: number;
  stage: string;
  detail: string;
  startedAt: number;
  expectedSeconds: number;
}

type UnknownRecord = Record<string, unknown>;

type CloneFullVideoJob = {
  status: "idle" | "running" | "done" | "failed";
  error?: string;
  videoUrl?: string;
};

type PendingCloneVideoTask = {
  shotId: number;
  segmentIndex?: number;
  startedAt: number;
  duration?: number;
  model?: string;
  channelName?: string;
};

const CLONE_FULL_VIDEO_SHOT_ID = 9999;
const CLONE_SEGMENT_SHOT_BASE = 9000;
const CLONE_VIDEO_ASSET_REFERENCE_LIMIT = 7;
const CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT = 1;
const CLONE_VIDEO_TOTAL_REFERENCE_LIMIT = CLONE_VIDEO_ASSET_REFERENCE_LIMIT + CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT;

type IdentityReference = {
  id: string;
  url: string;
  status: "draft" | "approved" | "archived";
};

function readIdentitySelection(configSnapshot?: Record<string, unknown> | null) {
  const value = configSnapshot?.identitySelection;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { packId: "", referenceIds: [] as string[] };
  }
  const selection = value as { packId?: unknown; referenceIds?: unknown };
  return {
    packId: typeof selection.packId === "string" ? selection.packId : "",
    referenceIds: Array.isArray(selection.referenceIds) ? selection.referenceIds.map(String).filter(Boolean) : [],
  };
}

const shotPurposeByType: Record<Shot["type"], string> = {
  hook: "Opening hook: create an immediately readable product moment with a visible action in the first second.",
  pain_point: "Pain-point demonstration: show the user's problem and the product benefit through one concrete physical action.",
  product_reveal: "Product reveal: show tactile product detail through a clear handling, reveal, or texture-verification action.",
  demo: "Practical demonstration: show how the product behaves, fits, moves, or solves the specific usage scenario.",
  social_proof: "Lifestyle proof: make the scene feel credible through one natural social or reaction-based action.",
  cta: "Conversion closing shot: show a clear final shopping or decision action while keeping the product readable.",
};

const cinematicMotionByShotType: Record<Shot["type"], string> = {
  hook: "Use real-time motion, not slow motion: the model performs a clear garment-serving action such as lifting the hem, brushing the collar trim, turning the shoulder slightly, or revealing fabric texture. Camera may push in briefly, but the subject action must be the main event.",
  pain_point: "Use real-time motion: the model adjusts the hem, smooths the waist area, turns from front to slight side, or checks the mirror to show the loose fit and coverage benefit. Avoid a frozen pose.",
  product_reveal: "Use real-time handling: fingers lift the visible collar/edge/detail area, trace the product's actual trim or seam if present, pinch the fabric texture, or rotate the garment slightly so fabric and construction visibly change across frames.",
  demo: "Use real-time wearable action: one or two natural steps, a bag lift, a torso turn, or a side-to-back reveal that makes drape, silhouette, and fabric movement visible.",
  social_proof: "Use real-time social performance: the model turns toward the camera or friend, gives a small reaction, speaks one short phrase, and lets the garment settle naturally.",
  cta: "Use real-time purchase action: the model reaches for the phone, taps once, then returns attention to the garment or settles into a product-forward pose.",
};

const cameraMotionByShotType: Record<Shot["type"], string> = {
  hook: "Use a short motivated camera move: quick detail push to fabric or trim, then a controlled pull-back or reframing to the upper-body outfit.",
  pain_point: "Use a small side tracking move or mirror reframing that reveals front-to-side fit. Camera motion supports the body/action, not just a slow zoom.",
  product_reveal: "Use macro-to-close product camera language: short push, tiny tilt, or small lateral slide across collar, sleeve, hem, or knit texture.",
  demo: "Use a stable tracking or slight orbit move that follows the model's real movement and reveals front, side, or back silhouette.",
  social_proof: "Use a short push-in or slight parallax as the subject turns or reacts. The camera move should not replace facial/body performance.",
  cta: "Use a clean reframing from outfit to phone/product area and back to a stable hero composition.",
};

function stripToEnglish(text: string): string {
  return text
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasIdentityLock(text: string): boolean {
  return /MANUALLY SELECTED PROJECT IDENTITY LOCK|IDENTITY LOCK|same face shape|same identity/i.test(text);
}

function getVideoSize(aspectRatio: ComposeConfig["aspectRatio"], resolution: ComposeConfig["resolution"]) {
  const longSide = resolution === "1080p" ? 1920 : 1280;
  const shortSide = resolution === "1080p" ? 1080 : 720;
  if (aspectRatio === "16:9") return { width: longSide, height: shortSide };
  if (aspectRatio === "1:1") return { width: shortSide, height: shortSide };
  return { width: shortSide, height: longSide };
}

function effectiveResolutionForModel(model: string | undefined, resolution: ComposeConfig["resolution"]): ComposeConfig["resolution"] {
  return /720/i.test(model ?? "") ? "720p" : resolution;
}

function parseObjectJson(value?: string | null): UnknownRecord | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value as UnknownRecord)
      .map(([key, item]) => `${key}: ${asText(item)}`)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function inferClonePlanDuration(plan: UnknownRecord | null, fallback = 30): number {
  if (!plan) return fallback;
  const direct = numberValue(plan.totalDuration)
    ?? numberValue(plan.totalDurationSeconds)
    ?? numberValue(plan.targetDuration)
    ?? numberValue(plan.duration);
  if (direct && direct > 0) return Math.round(direct);

  const segmentPlan = Array.isArray(plan.videoSegmentPlan)
    ? plan.videoSegmentPlan as UnknownRecord[]
    : [];
  const segmentTotal = segmentPlan.reduce((sum, item) => sum + (numberValue(item.durationSeconds) ?? 0), 0);
  if (segmentTotal > 0) return Math.round(segmentTotal);

  return fallback;
}

function findIndexedRecord(list: unknown, segmentIndex?: number) {
  const target = Number(segmentIndex || 0);
  if (!target) return null;
  return asArray(list)
    .map(asRecord)
    .find((item) => Number(item?.segmentIndex) === target) ?? null;
}

function buildCloneSegmentPrompt(plan: UnknownRecord, basePrompt: string, segment?: { segmentIndex: number; start: number; end: number }) {
  if (!segment) return basePrompt;
  const segmentPlan = findIndexedRecord(plan.videoSegmentPlan, segment.segmentIndex);
  const assetPlan = findIndexedRecord(plan.segmentAssetPlans, segment.segmentIndex);
  const videoDraft = findIndexedRecord(plan.segmentVideoPromptDrafts, segment.segmentIndex);
  const productStructureLock = asRecord(plan.productStructureLock);

  return [
    "HIGH-SIMILARITY CLONE SEGMENT EXECUTION PROMPT:",
    `This request generates only segment ${segment.segmentIndex}, time range ${segment.start}-${segment.end}s. The complete fullVideoPrompt defines global continuity; the current segment plan defines this time slice; approved image-2 assets define visual structure; product references and productStructureLock define product structure.`,
    "",
    "GLOBAL FULL-VIDEO DIRECTOR PROMPT:",
    basePrompt,
    "",
    "PRODUCT STRUCTURE LOCK:",
    asText(productStructureLock?.englishLock || productStructureLock?.chineseLock || productStructureLock),
    "",
    "CURRENT SEGMENT PLAN:",
    asText(segmentPlan),
    "",
    "CURRENT SEGMENT ASSET PLAN:",
    asText(assetPlan),
    "",
    "CURRENT SEGMENT VIDEO PROMPT DRAFT:",
    asText(videoDraft?.promptEnglishDraft || videoDraft),
    "",
    "FINAL SEGMENT EXECUTION RULES:",
    "- Follow the current segment first. Do not generate the whole video in this one request.",
    "- Use the approved reference images as this segment's visual anchors, not as a slideshow order.",
    "- Keep productStructureLock above all style/method wording. Do not average product details from multiple images into a new design.",
    "- The subject's body, hands, expression, and product interaction must drive motion. Camera movement is secondary.",
    "- Generate normal short-video motion, not slow-motion animated stills, cinemagraphs, or only a camera push-in.",
    "- Use an explicit time arc inside this segment: first 10-15% establishes the pose, middle 70-80% performs concrete body/hand/product actions, final 10-15% settles into a cuttable pose.",
    "- Name the exact camera movement for this segment: locked mirror frame, handheld micro-jitter, short push-in, pull-out reveal, lateral pan/truck, tilt, small arc orbit, fixed close-up, parallax move, or rack focus. Do not write generic cinematic movement.",
    "- Describe physical motion through foot contact, hip weight shift, shoulder follow-through, elbow/wrist path, hand-to-fabric contact, hem/cuff sway, and fabric rebound. Do not use abstract words alone.",
  ].filter(Boolean).join("\n\n");
}

function pickCloneWorkflow(analysis?: string | null): UnknownRecord | null {
  const parsed = parseObjectJson(analysis);
  return asRecord(parsed?.cloneWorkflow);
}

function pickCloneAssetAnchor(workflow: UnknownRecord | null): string | null {
  const assets = Array.isArray(workflow?.generatedAssetPackage)
    ? workflow.generatedAssetPackage as UnknownRecord[]
    : [];
  const scored = assets
    .flatMap((asset) => {
      const urls = Array.isArray(asset.imageUrls) ? asset.imageUrls.filter((url): url is string => typeof url === "string") : [];
      const text = `${asset.assetName || ""} ${asset.purpose || ""} ${asset.referencePriority || ""} ${asset.promptEnglish || ""}`.toLowerCase();
      const score =
        /first.?frame|anchor|opening|hero/.test(text) ? 50 :
        /scene|background|environment/.test(text) ? 35 :
        /identity|model|person|body|pose/.test(text) ? 25 :
        /product|structure|detail|front/.test(text) ? 15 :
        1;
      return urls.map((url) => ({ url, score }));
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.url || null;
}

function pickFirstFrameAnchor(clips: AssetItem[], cloneAssetAnchor?: string | null): string | null {
  if (cloneAssetAnchor) return cloneAssetAnchor;
  const done = clips
    .filter((clip) => clip.status === "done" && (clip.filePath || clip.thumbnailPath))
    .sort((a, b) => a.shotId - b.shotId);
  return done[0]?.filePath || done[0]?.thumbnailPath || null;
}

function cloneAssetVideoPriority(clip: AssetItem): number {
  const role = `${clip.assetRole || ""} ${clip.description || ""} ${clip.prompt || ""}`.toLowerCase();
  if (/a1|first.?frame|composition|opening|anchor/.test(role)) return 100;
  if (/a4|front.*structure|structure.*lock|product_front/.test(role)) return 96;
  if (/a5|detail|interaction|collar|sleeve|fabric|texture|trim/.test(role)) return 92;
  if (/a3|on.?body|try.?on|product.*body/.test(role)) return 88;
  if (/a6|motion|transition|pose|side|turn/.test(role)) return 82;
  if (/a7|ending|continuity/.test(role)) return 72;
  if (/a2|identity|expression|face/.test(role)) return 50;
  return 60;
}

function cloneAssetRoleLabel(clip: AssetItem): { role: string; note: string; source: CloneReferenceImage["source"] } {
  const role = `${clip.assetRole || ""} ${clip.description || ""} ${clip.prompt || ""}`.toLowerCase();
  if (/a1|first.?frame|composition|opening|anchor/.test(role)) {
    return { role: "首帧锚图", note: "决定本段开场构图、主体位置和账号画面感", source: "anchor" };
  }
  if (/a4|front.*structure|structure.*lock|product_front/.test(role)) {
    return { role: "商品结构资产", note: "辅助锁定上衣正面结构、版型和轮廓", source: "asset" };
  }
  if (/a5|detail|interaction|collar|sleeve|fabric|texture|trim/.test(role)) {
    return { role: "细节纹理资产", note: "辅助锁定领口、袖口、面料纹理和边缘细节", source: "asset" };
  }
  if (/a3|on.?body|try.?on|product.*body/.test(role)) {
    return { role: "上身试穿资产", note: "提供商品穿在人物身上的整体比例和身体方向", source: "asset" };
  }
  if (/a6|motion|transition|pose|side|turn/.test(role)) {
    return { role: "动作过渡资产", note: "提供转身、手部触碰、衣摆受力等动作参考", source: "asset" };
  }
  if (/a7|ending|continuity/.test(role)) {
    return { role: "结尾连续资产", note: "提供本段结尾姿态和下一段衔接状态", source: "asset" };
  }
  if (/a2|identity|expression|face/.test(role)) {
    return { role: "身份表情资产", note: "辅助人物脸型、发型、表情和账号气质连续", source: "asset" };
  }
  return { role: "辅助参考资产", note: "补充姿势、场景、光线或账号模板感", source: "asset" };
}

function prioritizeCloneAssetItemsForVideo(clips: AssetItem[]): CloneReferenceImage[] {
  return clips
    .filter((clip) => clip.status === "done" && (clip.filePath || clip.thumbnailPath))
    .map((clip) => {
      const label = cloneAssetRoleLabel(clip);
      return {
        url: clip.filePath || clip.thumbnailPath || "",
        shotId: clip.shotId,
        priority: cloneAssetVideoPriority(clip),
        ...label,
      };
    })
    .filter((item) => Boolean(item.url))
    .sort((a, b) => b.priority - a.priority || a.shotId - b.shotId)
    .map(({ url, role, note, source }) => ({ url, role, note, source }));
}

function buildCloneVideoReferencePackItems(
  assetImages: CloneReferenceImage[],
  productImages: string[] = [],
  cloneAssetAnchor?: string | null
): CloneReferenceImage[] {
  const productRefs = productImages
    .filter((url): url is string => Boolean(url?.trim()))
    .slice(0, CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT)
    .map((url) => ({
      url,
      role: "商品正面结构锁图",
      note: "只锁定商品真实结构、面料、镂空/花纹、领口、袖口和下摆；不继承白底或商品图姿势",
      source: "product" as const,
    }));
  const assetBudget = Math.max(1, CLONE_VIDEO_TOTAL_REFERENCE_LIMIT - productRefs.length);
  const dedupedAssets = Array.from(new Map([
    ...(cloneAssetAnchor ? [[cloneAssetAnchor, {
      url: cloneAssetAnchor,
      role: "首帧锚图",
      note: "优先作为本段第一帧构图和场景锚点",
      source: "anchor" as const,
    }]] as const : []),
    ...assetImages.map((item) => [item.url, item] as const),
  ]).values()).slice(0, assetBudget);
  return [...dedupedAssets, ...productRefs].slice(0, CLONE_VIDEO_TOTAL_REFERENCE_LIMIT);
}

function pickCloneReferenceImageItems(clips: AssetItem[], productImages: string[] = [], cloneAssetAnchor?: string | null): CloneReferenceImage[] {
  return buildCloneVideoReferencePackItems(prioritizeCloneAssetItemsForVideo(clips), productImages, cloneAssetAnchor);
}

function pickCloneSegmentReferenceImageItems(
  clips: AssetItem[],
  segmentIndex: number,
  productImages: string[] = [],
  cloneAssetAnchor?: string | null
): CloneReferenceImage[] {
  const segmentAssets = clips.filter((clip) => {
    const clipSegmentIndex = Number.isFinite(clip.segmentIndex)
      ? Math.max(1, Math.round(clip.segmentIndex || 1))
      : Math.floor((clip.shotId - 1) / 7) + 1;
    return clipSegmentIndex === segmentIndex && clip.status === "done";
  });
  return buildCloneVideoReferencePackItems(prioritizeCloneAssetItemsForVideo(segmentAssets), productImages, cloneAssetAnchor);
}

function countProductReferenceImages(referenceImageUrls: string[], productImages: string[] = []): number {
  const productSet = new Set(productImages.filter(Boolean));
  return referenceImageUrls.filter((url) => productSet.has(url)).length;
}

function buildCloneVideoRequestPreview(args: {
  segmentIndex?: number;
  duration: number;
  start?: number;
  end?: number;
  model?: string;
  channelName?: string;
  aspectRatio: ComposeConfig["aspectRatio"];
  resolution: ComposeConfig["resolution"];
  prompt: string;
  negativePrompt: string;
  references: CloneReferenceImage[];
}) {
  const referenceLines = args.references.map((item, index) =>
    `${index + 1}. ${item.role} | ${item.source} | ${item.note} | ${item.url}`
  );
  return [
    "FINAL VIDEO MODEL REQUEST PREVIEW",
    `Task: ${args.segmentIndex ? `clone segment ${args.segmentIndex} (${args.start}-${args.end}s)` : "clone full video"}`,
    `Channel: ${args.channelName || "-"}`,
    `Model: ${args.model || "-"}`,
    `Duration/seconds: ${args.duration}`,
    `Aspect ratio: ${args.aspectRatio}`,
    `Resolution: ${args.resolution}`,
    `Reference image count: ${args.references.length} (${CLONE_VIDEO_ASSET_REFERENCE_LIMIT} asset slots + ${CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT} product structure-lock slot trial)`,
    "",
    "Reference image roles:",
    referenceLines.length ? referenceLines.join("\n") : "No reference images.",
    "",
    "Prompt sent to /api/clone/generate-full-video:",
    args.prompt,
    "",
    "Negative prompt:",
    args.negativePrompt || "-",
  ].join("\n");
}

function buildVideoRequest(clip: AssetItem, index: number, total: number, config: ComposeConfig, model?: string): VideoRequestDraft {
  const imagePrompt = stripToEnglish(clip.finalPrompt || clip.prompt || "");
  const anchorSummary = imagePrompt
    ? imagePrompt.slice(0, 520)
    : "Use the attached first-frame image as the only visual source of truth.";
  const effectiveResolution = effectiveResolutionForModel(model, config.resolution);
  const { width, height } = getVideoSize(config.aspectRatio, effectiveResolution);

  const prompt = [
    "IMAGE-TO-VIDEO CINEMATIC DIRECTOR PROMPT",
    "",
    "IMPORTANT:",
    "This is a video-motion prompt, not a new keyframe image prompt. Do not recreate, redesign, or reinterpret the scene. Use the attached first-frame image as the visual authority and only extend it into natural motion.",
    "",
    "LOCKED VISUAL ANCHOR:",
    "Begin exactly from the attached first-frame composition. Preserve all visible product, person, clothing, lighting, and scene details from the keyframe. The keyframe is the source of truth; this prompt only defines time, motion, camera behavior, and continuity.",
    `Brief keyframe anchor summary, do not expand or override it: ${anchorSummary}`,
    "STRICT FIRST-FRAME CONTINUATION RULE: preserve the first-frame person's facial features, hairstyle, skin tone, body proportions, outfit, product details, scene layout, background structure, floor/wall material, lighting direction, and camera framing. The video may animate posture, hands, fabric, face, and camera only; it must not redesign the image.",
    hasIdentityLock(imagePrompt)
      ? [
          "MANUALLY SELECTED PROJECT IDENTITY CONTINUITY: this shot uses only the identity references manually selected for this project. Keep the same face, facial proportions, hairline, full-body proportions, body silhouette, height impression, shoulder width, waist-to-hip ratio, limb proportions, posture temperament, natural skin tone, and age impression from the first frame throughout the whole video.",
          "The selected full-body identity reference is the identity baseline. Other selected identity references only support their visible angle, expression, mouth-shape, and identity continuity; do not inherit their skin color shifts, local lighting problems, compression artifacts, pixel blocks, oily highlights, uneven shadows, or outfit details.",
          "Skin and lighting continuity must stay clean and calibrated: one coherent skin tone across face, neck, shoulders, arms, hands, waist, and visible legs; very soft, flat, diffuse ID-calibration lighting; reduced facial specular highlights; no oily shine, no glossy beauty-light effect, no patchy skin, no local color blocks, no uneven tint, no over-warm or over-cool body parts.",
          "Do not morph into a different person, do not beautify into a new face, and do not change body type. The product clothing on the model must remain the current product, not the outfit from the identity reference.",
        ].join(" ")
      : "",
    "",
    "SHOT PURPOSE:",
    `Shot ${String(index + 1).padStart(2, "0")} of ${total}. ${shotPurposeByType[clip.shotType]} Duration: ${clip.duration} seconds. Format: ${config.aspectRatio}. Target resolution: ${effectiveResolution}. Style target: cinematic soft realism and premium ecommerce fashion commercial, while keeping the first-frame visual design unchanged.`,
    `Script description to animate, do not ignore it: ${clip.description || "No script description provided."}`,
    `Voiceover intention for expression and mouth/body rhythm: ${clip.voiceover || "No voiceover."}`,
    "",
    "CINEMATIC MOTION:",
    cinematicMotionByShotType[clip.shotType],
    "The clip must contain visible subject/product action. Do not generate a static shot, near-freeze, or pure slow camera push. Use normal-speed human motion, natural fabric response, and a clear before-during-after action arc.",
    "The garment is the hero object. Every motion and camera choice must serve product readability, fabric texture, silhouette clarity, and purchase confidence.",
    "",
    "CAMERA DIRECTION:",
    cameraMotionByShotType[clip.shotType],
    "Camera motion should be moderate and purposeful, never the only movement. No handheld shake, no whip pan, no scene jump, no jump cut. Use shallow depth of field only if it does not blur product details.",
    "",
    "LIGHTING AND TEXTURE:",
    hasIdentityLock(imagePrompt)
      ? "Use soft, flat, diffuse commercial ID-calibration lighting on the person: low contrast, even skin exposure, reduced facial highlights, no oily shine, no patchy tint, no local bright spots, no overexposed white background, no grainy reflection, no compression artifacts. Preserve true product fabric texture without making skin glossy or beauty-lit."
      : "Soft directional key light, gentle fill, natural falloff, premium highlights on product texture, controlled exposure, no harsh shadows, no plastic AI skin, no over-sharpened synthetic texture.",
    "",
    "TEMPORAL ARC:",
    `0.0s-${Math.min(0.4, Math.max(0.2, clip.duration * 0.15)).toFixed(1)}s: start from the first-frame composition and immediately initiate the planned action; no long still hold.`,
    `${Math.min(0.4, Math.max(0.2, clip.duration * 0.15)).toFixed(1)}s-${Math.max(1.5, clip.duration - 0.6).toFixed(1)}s: complete the main product-serving action at normal speed while preserving exact product structure, identity, and scene.`,
    `${Math.max(1.5, clip.duration - 0.6).toFixed(1)}s-${clip.duration.toFixed(1)}s: settle briefly into a clean product-forward hero frame, ready to cut into the next shot.`,
    "",
    "PRODUCT CONSISTENCY LOCK:",
    "The product must remain identical to the first frame in every frame. Do not add new product details, new props, new accessories, new background items, or new styling elements. Do not change the visible product structure, color, scale, or placement.",
    "",
    "CONTINUITY:",
    "Keep the same person identity if a person appears, the same outfit, the same product, the same lighting direction, and the same environment. Body movement must be physically natural; fabric motion must follow gravity and the subject's movement.",
    "For try-on or outfit-showing shots, use a Flower-style continuity pattern: one medium-range lifestyle action such as a slight side turn, one hand in pocket, adjusting a belt/tie/hem/collar, touching the waistband or pocket edge, or showing drape and proportion. Keep action natural and continuous; do not let clothing mutate while the body moves.",
    hasIdentityLock(imagePrompt)
      ? "FACIAL PERFORMANCE: preserve the same facial identity, calibrated skin tone, and flat diffuse skin lighting while following the shot-specific facial expression and mouth-shape from the keyframe/script prompt. If speaking, animate believable mouth shapes derived from the voiceover intention, with subtle eye, eyebrow, and cheek movement that fits this shot only. Do not reuse a generic smile or fixed expression across clips; avoid over-open mouth, lip distortion, face drift, expression changes that alter identity, oily highlights, patchy skin, or uneven facial tint."
      : "",
    "",
    "TRANSITION INTENT:",
    `${transitionLabels[clip.transition] ?? "Direct continuity"} after this shot. End frame must be stable and easy to cut.`,
    "",
    "AUDIO AND TEXT:",
    config.ttsEnabled
      ? "Voiceover is provided separately. Do not render burned-in subtitles, logos, watermarks, UI panels, posters, split screens, or text overlays unless explicitly required."
      : "No voiceover instruction is required. Do not render burned-in subtitles, logos, watermarks, UI panels, posters, split screens, or text overlays.",
    "",
    "NEGATIVE PROMPT:",
    "static shot, frozen subject, no body movement, no product movement, only camera push-in, slow motion, ultra-slow dolly, product redesign, wrong garment, changed color, changed neckline, changed sleeve length, changed hem, distorted fabric, melted texture, deformed hands, extra fingers, unstable face, duplicated body, body warping, changed body proportions, changed waist-to-hip ratio, changed shoulder width, inconsistent skin tone, patchy skin, local color blocks, oily facial shine, glossy beauty lighting, uneven tint, over-warm body parts, over-cool body parts, mottled white background, local bright spots, grainy reflection, compression artifacts, visible pixel blocks, plastic skin, exaggerated gesture, dancing, spinning, flicker, frame tearing, jitter, sudden camera jump, low resolution, oversharpened AI texture, text overlay, subtitles, watermark, logo hallucination, poster layout, collage, split screen.",
  ].join("\n");

  return {
    prompt,
    imageUrl: clip.filePath || clip.thumbnailPath,
    width,
    height,
  };
}

export default function VideoPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const versionId = searchParams.get("versionId");
  const { providers, llm } = useSettingsStore();
  const videoProvider = providers["openai-seedance"];
  const shotVideoChannels = useMemo(() => getReadyVideoChannels(videoProvider, "shot_clip"), [videoProvider]);
  const fullVideoChannels = useMemo(() => getReadyVideoChannels(videoProvider, "full_video"), [videoProvider]);
  const videoReady = Boolean(videoProvider?.enabled && hasProviderCredential(videoProvider) && shotVideoChannels.length > 0);
  const llmReady = Boolean(llm?.baseUrl?.trim() && llm?.apiKey?.trim() && llm?.model?.trim());

  const [data, setData] = useState<AssetsResponse | null>(null);
  const [identityReferences, setIdentityReferences] = useState<IdentityReference[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ComposeConfig>({
    ttsEnabled: true,
    ttsVoice: "female-gentle",
    bgm: "none",
    subtitlePosition: "bottom",
    aspectRatio: "9:16",
    resolution: "720p",
  });
  const [jobs, setJobs] = useState<Record<number, VideoJob>>({});
  const [promptJobs, setPromptJobs] = useState<Record<number, PromptJob>>({});
  const [customVideoPrompts, setCustomVideoPrompts] = useState<Record<number, string>>({});
  const [promptVersions, setPromptVersions] = useState<Record<number, number>>({});
  const [isGeneratingVideos, setIsGeneratingVideos] = useState(false);
  const [isRegeneratingAllPrompts, setIsRegeneratingAllPrompts] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<{ clip: AssetItem; draft: VideoRequestDraft } | null>(null);
  const [videoProgress, setVideoProgress] = useState<VideoProgressState | null>(null);
  const [savedVideoClips, setSavedVideoClips] = useState<Record<number, SavedVideoClip>>({});
  const [videoReloadTokens, setVideoReloadTokens] = useState<Record<string, number>>({});
  const [cloneFullVideoJob, setCloneFullVideoJob] = useState<CloneFullVideoJob>({ status: "idle" });
  const [runningCloneSegmentIndex, setRunningCloneSegmentIndex] = useState<number | null>(null);
  const [pendingCloneVideoTasks, setPendingCloneVideoTasks] = useState<Record<number, PendingCloneVideoTask>>({});
  const [selectedVideoChannelId, setSelectedVideoChannelId] = useState("");
  const [selectedCloneVideoChannelId, setSelectedCloneVideoChannelId] = useState("");
  const [cloneVideoChannelTouched, setCloneVideoChannelTouched] = useState(false);
  const [acceptedCloneSegments, setAcceptedCloneSegments] = useState<Record<number, boolean>>({});
  const [customCloneSegmentPrompts, setCustomCloneSegmentPrompts] = useState<Record<number, string>>({});
  const identitySelection = useMemo(
    () => readIdentitySelection(data?.project.currentVersion?.configSnapshot),
    [data?.project.currentVersion?.configSnapshot]
  );
  const selectedIdentityPackId = identitySelection.packId || data?.project.characterId || "";
  const selectedIdentityImageUrls = useMemo(
    () => identityReferences
      .filter((reference) => identitySelection.referenceIds.includes(reference.id))
      .map((reference) => reference.url),
    [identityReferences, identitySelection.referenceIds]
  );
  const selectedVideoChannel = useMemo(
    () => getActiveVideoChannel(videoProvider, selectedVideoChannelId, "shot_clip"),
    [selectedVideoChannelId, videoProvider]
  );
  const selectedVideoModel = selectedVideoChannel?.model || "";
  const modelForces720p = /720/i.test(selectedVideoModel || "");
  const pendingCloneVideoTaskStorageKey = useMemo(
    () => `daihuo.cloneVideoTasks.${id}.${versionId || "default"}`,
    [id, versionId]
  );

  function upsertPendingCloneVideoTask(task: PendingCloneVideoTask) {
    setPendingCloneVideoTasks((current) => {
      const next = { ...current, [task.shotId]: task };
      try {
        localStorage.setItem(pendingCloneVideoTaskStorageKey, JSON.stringify(next));
      } catch {
        // Ignore storage failures; the visible in-memory state still helps during this session.
      }
      return next;
    });
  }

  function removePendingCloneVideoTask(shotId: number) {
    setPendingCloneVideoTasks((current) => {
      if (!current[shotId]) return current;
      const next = { ...current };
      delete next[shotId];
      try {
        if (Object.keys(next).length === 0) {
          localStorage.removeItem(pendingCloneVideoTaskStorageKey);
        } else {
          localStorage.setItem(pendingCloneVideoTaskStorageKey, JSON.stringify(next));
        }
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
  }

  useEffect(() => {
    let alive = true;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/project/${id}/assets${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`);
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "读取视频链路失败");
        if (alive) setData(json);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "读取视频链路失败");
      } finally {
        if (alive) setIsLoading(false);
      }
    }
    if (id) load();
    return () => {
      alive = false;
    };
  }, [id, versionId]);

  useEffect(() => {
    if (!selectedIdentityPackId || identitySelection.referenceIds.length === 0) {
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
  }, [selectedIdentityPackId, identitySelection.referenceIds]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(pendingCloneVideoTaskStorageKey);
      if (!raw) {
        setPendingCloneVideoTasks({});
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, PendingCloneVideoTask>;
      const now = Date.now();
      const fresh = Object.fromEntries(
        Object.entries(parsed)
          .filter(([, task]) => task?.shotId && task?.startedAt && now - task.startedAt < 2 * 60 * 60 * 1000)
          .map(([key, task]) => [Number(key), task])
      ) as Record<number, PendingCloneVideoTask>;
      setPendingCloneVideoTasks(fresh);
      if (Object.keys(fresh).length === 0) {
        localStorage.removeItem(pendingCloneVideoTaskStorageKey);
      } else {
        localStorage.setItem(pendingCloneVideoTaskStorageKey, JSON.stringify(fresh));
      }
    } catch {
      setPendingCloneVideoTasks({});
      localStorage.removeItem(pendingCloneVideoTaskStorageKey);
    }
  }, [pendingCloneVideoTaskStorageKey]);

  useEffect(() => {
    if (id) void loadVideoClips(true);
    // loadVideoClips intentionally reads the latest render state; rerun only when the project/version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, versionId]);

  useEffect(() => {
    const project = data?.project;
    if (!project) return;
    setConfig((current) => ({
      ...current,
      aspectRatio: project.videoAspectRatio ?? current.aspectRatio,
      resolution: effectiveResolutionForModel(selectedVideoModel, project.videoResolution ?? current.resolution),
    }));
  }, [data?.project, selectedVideoModel]);

  useEffect(() => {
    if (!videoProgress?.active) return;
    const timer = window.setInterval(() => {
      setVideoProgress((current) => {
        if (!current?.active) return current;
        const elapsedSeconds = Math.max(0, Math.round((Date.now() - current.startedAt) / 1000));
        const ratio = 1 - Math.exp(-elapsedSeconds / Math.max(1, current.expectedSeconds * 0.55));
        const estimatedPercentage = Math.min(94, Math.max(current.percentage, Math.round(12 + ratio * 78)));
        const etaSeconds = Math.max(8, current.expectedSeconds - elapsedSeconds);
        return {
          ...current,
          percentage: estimatedPercentage,
          elapsedSeconds,
          etaSeconds,
        };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [videoProgress?.active]);

  const clips = useMemo(() => data?.assets ?? [], [data?.assets]);
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const readyCount = clips.filter((clip) => clip.status === "done").length;
  const allAssetsReady = clips.length > 0 && readyCount === clips.length;
  const cloneVideoChannels = useMemo(() => fullVideoChannels, [fullVideoChannels]);
  const activeCloneVideoChannel = useMemo(() => {
    if (!videoProvider) return null;
    return cloneVideoChannels.find((channel) => channel.id === selectedCloneVideoChannelId)
      ?? getActiveVideoChannel(videoProvider, selectedCloneVideoChannelId, "full_video");
  }, [cloneVideoChannels, selectedCloneVideoChannelId, videoProvider]);
  const videoDrafts = useMemo(
    () =>
      clips.map((clip, index) => {
        const baseDraft = buildVideoRequest(clip, index, clips.length, config, selectedVideoModel);
        return {
          clip,
          draft: {
            ...baseDraft,
            prompt: customVideoPrompts[clip.shotId] || baseDraft.prompt,
          },
          baseDraft,
        };
      }),
    [clips, config, customVideoPrompts, selectedVideoModel]
  );
  const finishedVideoCount = Object.values(jobs).filter((job) => job.status === "done").length;
  const failedVideoCount = Object.values(jobs).filter((job) => job.status === "failed").length;
  const cloneWorkflow = useMemo(() => pickCloneWorkflow(data?.project.productAnalysis), [data?.project.productAnalysis]);
  const clonePlan = useMemo(() => asRecord(cloneWorkflow?.plan), [cloneWorkflow]);
  const isCloneFullVideoProject = data?.project.sourceType === "clone" && Boolean(clonePlan);
  const cloneFullVideoPrompt = asText(clonePlan?.fullVideoPrompt).trim();
  const cloneAssetAnchor = pickCloneAssetAnchor(cloneWorkflow);
  const cloneReferenceImageUrl = pickFirstFrameAnchor(clips, cloneAssetAnchor);
  const cloneReferenceImages = pickCloneReferenceImageItems(clips, data?.project.productImages ?? [], cloneAssetAnchor);
  const cloneReferenceImageUrls = cloneReferenceImages.map((item) => item.url);
  const cloneSavedVideo = savedVideoClips[CLONE_FULL_VIDEO_SHOT_ID];
  const savedCloneVideoChannel = useMemo(() => {
    const savedModel = cloneSavedVideo?.model?.trim();
    const savedProvider = cloneSavedVideo?.provider?.trim();
    if (!savedModel && !savedProvider) return null;
    return fullVideoChannels.find((channel) =>
      (savedModel && channel.model === savedModel) ||
      (savedProvider && channel.name === savedProvider)
    ) ?? null;
  }, [cloneSavedVideo?.model, cloneSavedVideo?.provider, fullVideoChannels]);
  const cloneVideoUrl = cloneFullVideoJob.videoUrl || cloneSavedVideo?.filePath || null;
  const cloneVideoPreviewUrl = videoSrcWithReloadToken(cloneVideoUrl);
  const cloneVideoProviderReady = Boolean(
    videoProvider?.enabled &&
      activeCloneVideoChannel?.enabled !== false &&
      activeCloneVideoChannel?.apiKey?.trim() &&
      activeCloneVideoChannel?.baseUrl?.trim() &&
      activeCloneVideoChannel?.model?.trim()
  );
  const clonePlanDuration = inferClonePlanDuration(clonePlan, 30);
  const cloneFullVideoTargetDuration = Math.max(
    4,
    Math.round(totalDuration || clonePlanDuration || 30)
  );
  const isGrokCloneVideoModel = isGrokVideoModel(activeCloneVideoChannel?.model);
  const isSegmentedCloneVideoModel = isSegmentedVideoModel(activeCloneVideoChannel?.model);
  const segmentedCloneModelLabel = isGrokCloneVideoModel ? "Grok" : "Omni";
  const segmentedCloneModelDurationTip = isGrokCloneVideoModel ? "Grok 每段只能是 6 或 10 秒" : "Omni 每段最多 10 秒，支持 4/6/8/10 秒";
  const omniCloneDurationSegments = useMemo(
    () => splitSegmentedVideoDurations(activeCloneVideoChannel?.model, cloneFullVideoTargetDuration),
    [activeCloneVideoChannel?.model, cloneFullVideoTargetDuration]
  );
  const omniCloneDurationPlan = formatOmniDurationPlan(omniCloneDurationSegments);
  const omniCloneGeneratedDuration = sumOmniDurations(omniCloneDurationSegments);
  const cloneVideoSegments = useMemo(() => {
    let cursor = 0;
    return omniCloneDurationSegments.map((duration, index) => {
      const start = cursor;
      const end = cursor + duration;
      cursor = end;
      const segmentIndex = index + 1;
      const shotId = CLONE_SEGMENT_SHOT_BASE + segmentIndex;
      const referenceImages = pickCloneSegmentReferenceImageItems(clips, segmentIndex, data?.project.productImages ?? [], cloneAssetAnchor);
      const saved = savedVideoClips[shotId];
      return {
        segmentIndex,
        shotId,
        duration,
        start,
        end,
        referenceImages,
        referenceImageUrls: referenceImages.map((item) => item.url),
        saved,
      };
    });
  }, [clips, cloneAssetAnchor, data?.project.productImages, omniCloneDurationSegments, savedVideoClips]);
  const cloneSegmentDoneCount = cloneVideoSegments.filter((segment) => segment.saved?.status === "done" && segment.saved.filePath).length;
  const activePendingCloneVideoTasks = useMemo(
    () => Object.fromEntries(
      Object.entries(pendingCloneVideoTasks).filter(([shotIdText, task]) => {
        const shotId = Number(shotIdText);
        const saved = savedVideoClips[shotId];
        return !(saved?.status === "done" && saved.filePath) && Date.now() - task.startedAt < 2 * 60 * 60 * 1000;
      })
    ) as Record<number, PendingCloneVideoTask>,
    [pendingCloneVideoTasks, savedVideoClips]
  );
  const hasActivePendingCloneVideoTask = Object.keys(activePendingCloneVideoTasks).length > 0;

  useEffect(() => {
    if (cloneVideoChannelTouched) return;
    if (savedCloneVideoChannel?.id && selectedCloneVideoChannelId !== savedCloneVideoChannel.id) {
      setSelectedCloneVideoChannelId(savedCloneVideoChannel.id);
      return;
    }
    const projectVideoChannelId = data?.project.videoChannelId;
    const projectChannelSupportsFullVideo = fullVideoChannels.some((channel) => channel.id === projectVideoChannelId);
    if (projectVideoChannelId && projectChannelSupportsFullVideo && selectedCloneVideoChannelId !== projectVideoChannelId) {
      setSelectedCloneVideoChannelId(projectVideoChannelId);
      return;
    }
    if (activeCloneVideoChannel?.id && !selectedCloneVideoChannelId) {
      setSelectedCloneVideoChannelId(activeCloneVideoChannel.id);
    }
  }, [
    activeCloneVideoChannel?.id,
    cloneVideoChannelTouched,
    data?.project.videoChannelId,
    fullVideoChannels,
    savedCloneVideoChannel?.id,
    selectedCloneVideoChannelId,
  ]);

  useEffect(() => {
    const projectVideoChannelId = data?.project.videoChannelId;
    if (projectVideoChannelId && projectVideoChannelId !== selectedVideoChannelId) {
      setSelectedVideoChannelId(projectVideoChannelId);
      return;
    }
    if (selectedVideoChannel?.id && !selectedVideoChannelId) {
      setSelectedVideoChannelId(selectedVideoChannel.id);
    }
  }, [data?.project.videoChannelId, selectedVideoChannel?.id, selectedVideoChannelId]);

  const statusMessage = useMemo(() => {
    if (!allAssetsReady) return `素材未全部完成：${readyCount}/${clips.length}`;
    if (!videoReady) return "视频接口还没有配置完成，当前先停在真实素材时间线。";
    return `已准备调用视频模型：${selectedVideoModel || "seedance-v1-5-pro"}${modelForces720p ? "（720p）" : ""}`;
  }, [allAssetsReady, clips.length, modelForces720p, readyCount, selectedVideoModel, videoReady]);

  function updateVideoProgress(patch: Partial<VideoProgressState> & {
    percentage?: number;
    stage?: string;
    detail?: string;
  }) {
    setVideoProgress((current) => {
      const startedAt = patch.startedAt ?? current?.startedAt ?? Date.now();
      const expectedSeconds = patch.expectedSeconds ?? current?.expectedSeconds ?? 180;
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const etaSeconds = patch.etaSeconds ?? (patch.percentage && patch.percentage >= 100
        ? 0
        : Math.max(8, expectedSeconds - elapsedSeconds));

      return {
        active: patch.active ?? current?.active ?? true,
        percentage: Math.max(0, Math.min(100, patch.percentage ?? current?.percentage ?? 0)),
        elapsedSeconds,
        etaSeconds,
        stage: patch.stage ?? current?.stage ?? "Preparing video generation",
        detail: patch.detail ?? current?.detail ?? "Waiting for the provider request to start.",
        startedAt,
        expectedSeconds,
      };
    });
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
  }

  async function loadVideoClips(silent = false) {
    if (!id) return;
    if (!silent) setError(null);
    try {
      const response = await fetch(`/api/project/${id}/video-clips${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`, {
        cache: "no-store",
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to load saved video clips.");
      const clipsByShot = Object.fromEntries(
        (json.clips ?? [])
          .filter((clip: SavedVideoClip) => clip.shotId && clip.filePath)
          .map((clip: SavedVideoClip) => [clip.shotId, clip])
      ) as Record<number, SavedVideoClip>;
      const cloneFullVideo = clipsByShot[CLONE_FULL_VIDEO_SHOT_ID];
      setSavedVideoClips(clipsByShot);
      setPendingCloneVideoTasks((current) => {
        const next = { ...current };
        let changed = false;
        for (const [shotIdText, task] of Object.entries(current)) {
          const shotId = Number(shotIdText);
          const saved = clipsByShot[shotId];
          if (saved?.status === "done" && saved.filePath) {
            delete next[task.shotId];
            changed = true;
          }
        }
        if (changed) {
          try {
            if (Object.keys(next).length === 0) {
              localStorage.removeItem(pendingCloneVideoTaskStorageKey);
            } else {
              localStorage.setItem(pendingCloneVideoTaskStorageKey, JSON.stringify(next));
            }
          } catch {
            // Ignore storage failures.
          }
        }
        return changed ? next : current;
      });
      if (cloneFullVideo?.status === "done" && cloneFullVideo.filePath) {
        setCloneFullVideoJob({ status: "done", videoUrl: cloneFullVideo.filePath });
      }
      setJobs((current) => {
        const next = { ...current };
        for (const clip of Object.values(clipsByShot)) {
          if (clip.shotId === CLONE_FULL_VIDEO_SHOT_ID) continue;
          if (clip.status === "done" && clip.filePath && !["running", "queued"].includes(next[clip.shotId]?.status ?? "")) {
            next[clip.shotId] = { status: "done", videoUrls: [clip.filePath] };
          }
        }
        return next;
      });
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Failed to load saved video clips.");
    }
  }

  useEffect(() => {
    if (!id) return;
    const timer = window.setInterval(() => {
      void loadVideoClips(true);
    }, 5000);
    return () => window.clearInterval(timer);
    // The polling callback must use current channel/job state without recreating the interval on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, versionId]);

  function videoSrcWithReloadToken(src?: string | null) {
    if (!src) return null;
    const token = videoReloadTokens[src];
    if (!token) return src;
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}videoReload=${token}`;
  }

  function retryVideoPreview(src?: string | null) {
    if (!src) return;
    window.setTimeout(() => {
      setVideoReloadTokens((current) => ({
        ...current,
        [src]: Date.now(),
      }));
    }, 1200);
  }

  async function regenerateVideoPrompt(clip: AssetItem, baseDraft: VideoRequestDraft) {
    if (!llmReady) {
      setError("请先在设置页配置 LLM：Base URL、API Key 和模型名。");
      return;
    }

    setError(null);
    setPromptJobs((current) => ({
      ...current,
      [clip.shotId]: { status: "running" },
    }));

    try {
      const nextVersion = (promptVersions[clip.shotId] || 0) + 1;
      const response = await fetch("/api/llm/video-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: id,
          llmConfig: llm,
          clip: {
            shotId: clip.shotId,
            shotType: clip.shotType,
              duration: clip.duration,
              description: clip.description,
              camera: clip.camera,
              voiceover: clip.voiceover,
            transition: clip.transition,
            imagePrompt: clip.finalPrompt || clip.prompt,
            baseVideoPrompt: baseDraft.prompt,
            imageUrl: clip.filePath || clip.thumbnailPath,
            imageUrls: uniqueStrings([
              ...(data?.project.productImages ?? []),
              ...(hasIdentityLock(clip.finalPrompt || clip.prompt) ? selectedIdentityImageUrls : []),
            ]),
            productAnalysis: data?.project.productAnalysis || "",
            variationSeed: Date.now() + clip.shotId + nextVersion,
            useVisionFrame: true,
            visionReferenceNote:
              "The first attached image is the current generated keyframe and is the highest-priority visual source of truth for this exact shot. Product reference images are only for checking garment/product consistency. Any following identity reference images are the manually selected project references and may only preserve face/body continuity. Do not replace the current keyframe scene, outfit, or composition with any secondary reference.",
          },
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        const details = [
          result.error,
          result.chatError ? `chat/completions: ${result.chatError}` : "",
          result.responsesError ? `responses: ${result.responsesError}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        throw new Error(details || "Failed to regenerate video prompt.");
      }

      setCustomVideoPrompts((current) => ({
        ...current,
        [clip.shotId]: String(result.prompt || "").trim(),
      }));
      setPromptVersions((current) => ({
        ...current,
        [clip.shotId]: nextVersion,
      }));
      setPromptJobs((current) => ({
        ...current,
        [clip.shotId]: { status: "done", method: result.method },
      }));
    } catch (err) {
      setPromptJobs((current) => ({
        ...current,
        [clip.shotId]: {
          status: "failed",
          error: err instanceof Error ? err.message : "Failed to regenerate video prompt.",
        },
      }));
    }
  }

  async function regenerateAllVideoPrompts() {
    if (isRegeneratingAllPrompts || !allAssetsReady) return;
    setIsRegeneratingAllPrompts(true);
    try {
      for (const { clip, baseDraft } of videoDrafts) {
        await regenerateVideoPrompt(clip, baseDraft);
      }
    } finally {
      setIsRegeneratingAllPrompts(false);
    }
  }

  async function generateOneClipVideo(
    clip: AssetItem,
    draft: VideoRequestDraft,
    progressContext?: { batchIndex: number; batchTotal: number; startedAt: number }
  ) {
    if (!videoProvider || !videoReady || !selectedVideoChannel) {
      setError("视频接口还没有配置完成。");
      return;
    }

    if (clip.status !== "done") {
      setJobs((current) => ({
        ...current,
        [clip.shotId]: { status: "failed", error: "This shot keyframe is not ready yet." },
      }));
      return;
    }

    if (!draft.imageUrl) {
      setJobs((current) => ({
        ...current,
        [clip.shotId]: { status: "failed", error: "Missing first-frame image URL." },
      }));
      return;
    }

    setError(null);
    setJobs((current) => ({
      ...current,
      [clip.shotId]: { status: "running" },
    }));
    const startedAt = progressContext?.startedAt ?? Date.now();
    const batchTotal = progressContext?.batchTotal ?? 1;
    const batchIndex = progressContext?.batchIndex ?? 0;
    const basePercentage = Math.round((batchIndex / batchTotal) * 100);
    const expectedSeconds = Math.max(120, batchTotal * 180);
    updateVideoProgress({
      active: true,
      startedAt,
      expectedSeconds,
      percentage: Math.max(6, basePercentage),
      stage: `Shot ${clip.shotId}: sending request to Seedance`,
      detail: progressContext
        ? `Generating clip ${batchIndex + 1}/${batchTotal}. First-frame image and video director prompt are being submitted.`
        : "Generating this single clip. First-frame image and video director prompt are being submitted.",
    });

    try {
      updateVideoProgress({
        active: true,
        startedAt,
        expectedSeconds,
        percentage: Math.max(basePercentage + 8, progressContext ? basePercentage + Math.round(25 / batchTotal) : 24),
        stage: `Shot ${clip.shotId}: waiting for Seedance result`,
        detail: "The provider request is running. Provider internal progress is not exposed, so this bar estimates while waiting for the real response.",
      });

      const response = await fetch("/api/ai/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: id,
          provider: "openai-seedance",
          // The server resolves the saved channel by ID. The model/base URL
          // shown in the browser are display metadata and must not select a
          // different channel when two channels share the same endpoint.
          videoChannelId: selectedVideoChannel.id,
          model: selectedVideoChannel.model,
          prompt: draft.prompt,
          imageUrl: draft.imageUrl,
          imageUrls: uniqueStrings([
            ...(data?.project.productImages ?? []),
            ...(hasIdentityLock(clip.finalPrompt || clip.prompt) ? selectedIdentityImageUrls : []),
          ]),
          mode: "image-to-video",
          apiKey: selectedVideoChannel.apiKey,
          baseUrl: selectedVideoChannel.baseUrl,
          videoApiKey: selectedVideoChannel.apiKey,
          videoBaseUrl: selectedVideoChannel.baseUrl,
          videoSubmitPath: selectedVideoChannel.submitPath,
          videoStatusPath: selectedVideoChannel.statusPath,
          videoContentPath: selectedVideoChannel.contentPath,
          taskType: "shot_clip",
          options: {
            duration: clip.duration,
            width: draft.width,
            height: draft.height,
            fps: 24,
            voiceover: config.ttsEnabled ? clip.voiceover : undefined,
          },
        }),
      });
      updateVideoProgress({
        active: true,
        startedAt,
        expectedSeconds,
        percentage: Math.max(basePercentage + 10, progressContext ? basePercentage + Math.round(55 / batchTotal) : 72),
        stage: `Shot ${clip.shotId}: Seedance returned`,
        detail: "The provider returned a response. Validating the video URL before saving locally.",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Video generation failed");
      const videoUrl = result.videoUrls?.[0];
      if (!videoUrl) throw new Error("Video generation completed but returned no video URL.");

      updateVideoProgress({
        active: true,
        startedAt,
        expectedSeconds,
        percentage: Math.max(basePercentage + 18, progressContext ? basePercentage + Math.round(75 / batchTotal) : 86),
        stage: `Shot ${clip.shotId}: saving video locally`,
        detail: "Seedance returned a video. Downloading it into the local project video folder now.",
      });

      const saveResponse = await fetch(`/api/project/${id}/video-clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: versionId || undefined,
          shotId: clip.shotId,
          assetId: clip.id,
          videoUrl,
          duration: clip.duration,
          provider: "openai-seedance",
          model: selectedVideoChannel.model,
          transitionType: clip.transition,
        }),
      });
      const savedClip = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(savedClip.error || "Video generated but failed to save local clip.");

      setSavedVideoClips((current) => ({
        ...current,
        [clip.shotId]: savedClip,
      }));
      if (savedClip.filePath) {
        setVideoReloadTokens((current) => ({
          ...current,
          [savedClip.filePath]: Date.now(),
        }));
      }
      setJobs((current) => ({
        ...current,
        [clip.shotId]: { status: "done", videoUrls: [savedClip.filePath || videoUrl] },
      }));
      await loadVideoClips(true);
      updateVideoProgress({
        active: progressContext ? batchIndex + 1 < batchTotal : false,
        startedAt,
        expectedSeconds,
        percentage: progressContext ? Math.round(((batchIndex + 1) / batchTotal) * 100) : 100,
        etaSeconds: progressContext && batchIndex + 1 < batchTotal ? undefined : 0,
        stage: `Shot ${clip.shotId}: done`,
        detail: progressContext
          ? `Finished clip ${batchIndex + 1}/${batchTotal}. ${batchIndex + 1 < batchTotal ? "Moving to the next clip." : "All requested clips are complete."}`
          : "This clip is complete and saved locally.",
      });
    } catch (err) {
      setJobs((current) => ({
        ...current,
        [clip.shotId]: {
          status: "failed",
          error: err instanceof Error ? err.message : "Video generation failed",
        },
      }));
      updateVideoProgress({
        active: false,
        startedAt,
        expectedSeconds,
        percentage: 100,
        etaSeconds: 0,
        stage: `Shot ${clip.shotId}: failed`,
        detail: err instanceof Error ? err.message : "Video generation failed",
      });
    }
  }

  async function generateClipVideos() {
    if (!videoProvider || !videoReady || !allAssetsReady || isGeneratingVideos) return;

    setIsGeneratingVideos(true);
    setError(null);
    setJobs(
      Object.fromEntries(videoDrafts.map(({ clip }) => [clip.shotId, { status: "queued" as VideoJobStatus }]))
    );

    const startedAt = Date.now();
    updateVideoProgress({
      active: true,
      startedAt,
      expectedSeconds: Math.max(120, videoDrafts.length * 180),
      percentage: 3,
      stage: "Preparing batch video generation",
      detail: `Queued ${videoDrafts.length} clips. They will be generated one by one and saved locally after each provider result.`,
    });

    for (const [index, { clip, draft }] of videoDrafts.entries()) {
      await generateOneClipVideo(clip, draft, {
        batchIndex: index,
        batchTotal: videoDrafts.length,
        startedAt,
      });
    }

    setIsGeneratingVideos(false);
    updateVideoProgress({
      active: false,
      startedAt,
      expectedSeconds: Math.max(120, videoDrafts.length * 180),
      percentage: 100,
      etaSeconds: 0,
      stage: "Video generation finished",
      detail: `Finished ${videoDrafts.length} clips. Check each clip card or the export page for previews and downloads.`,
    });
  }

  async function generateCloneFullVideo(
    plan: UnknownRecord,
    referenceImageUrl: string | null,
    referenceImageUrls: string[],
    segment?: { segmentIndex: number; shotId: number; duration: number; start: number; end: number },
    promptOverride?: string
  ) {
    const channel = activeCloneVideoChannel;
    if (!videoProvider || !channel) {
      setCloneFullVideoJob({ status: "failed", error: "视频平台配置不存在。" });
      return;
    }

    const basePrompt = asText(plan.fullVideoPrompt).trim();
    if (!basePrompt) {
      setCloneFullVideoJob({ status: "failed", error: "爆款复刻规划里缺少完整视频英文导演稿。" });
      return;
    }
    const prompt = promptOverride?.trim() || buildCloneSegmentPrompt(plan, basePrompt, segment);

    const apiKey = channel.apiKey?.trim();
    const baseUrl = channel.baseUrl?.trim();
    const model = channel.model?.trim();
    const isSegmentedModel = isSegmentedVideoModel(model);
    if (!apiKey || !baseUrl || !model) {
      setCloneFullVideoJob({
        status: "failed",
        error: "请先在设置页配置当前视频模型：API Key、Base URL、模型名。",
      });
      return;
    }

    const startedAt = Date.now();
    const pendingShotId = segment?.shotId ?? CLONE_FULL_VIDEO_SHOT_ID;
    setError(null);
    setRunningCloneSegmentIndex(segment?.segmentIndex ?? null);
    setCloneFullVideoJob({ status: "running" });
    upsertPendingCloneVideoTask({
      shotId: pendingShotId,
      segmentIndex: segment?.segmentIndex,
      startedAt,
      duration: segment?.duration ?? cloneFullVideoTargetDuration,
      model,
      channelName: channel.name || model,
    });
    updateVideoProgress({
      active: true,
      startedAt,
      expectedSeconds: segment ? 180 : 240,
      percentage: 5,
      stage: segment ? `完整视频：提交任务 ${segment.segmentIndex}` : isSegmentedModel ? "完整视频：分段提交" : "完整视频：提交任务",
      detail: segment
        ? `正在用完整导演稿生成第 ${segment.segmentIndex} 段（${segment.start}-${segment.end}s），本段 ${referenceImageUrls.length} 张参考图。通道：${channel.name || model}`
        : isSegmentedModel
        ? `${/grok/i.test(model) ? "Grok" : "Omni"} 会先使用完整导演稿，再按 ${omniCloneDurationPlan} 顺序分段生成；每段试验使用 ${CLONE_VIDEO_ASSET_REFERENCE_LIMIT}+${CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT} 张参考图。`
        : `正在发送完整英文导演稿、负面提示词、首帧锚图和项目画幅参数。通道：${channel.name || model}`,
    });

    try {
      const productReferenceCount = countProductReferenceImages(referenceImageUrls, data?.project.productImages ?? []);
      const response = await fetch("/api/clone/generate-full-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: id,
          versionId: versionId || undefined,
          prompt,
          negativePrompt: asText(plan.negativePrompt),
          videoChannelId: channel.id,
          model,
          apiKey,
          baseUrl,
          videoSubmitPath: channel.submitPath || videoProvider.videoSubmitPath,
          videoStatusPath: channel.statusPath || videoProvider.videoStatusPath,
          videoContentPath: channel.contentPath || videoProvider.videoContentPath,
          taskType: "full_video",
          duration: cloneFullVideoTargetDuration,
          aspectRatio: config.aspectRatio,
          resolution: effectiveResolutionForModel(model, config.resolution),
          referenceImageUrl: referenceImageUrl || undefined,
          referenceImageUrls,
          options: {
            source: "high_similarity_clone",
            channelName: channel.name,
            taskType: "full_video",
            segmentIndex: segment?.segmentIndex,
            segmentCount: segment ? cloneVideoSegments.length : undefined,
            segmentStart: segment?.start,
            segmentEnd: segment?.end,
            productReferenceCount,
            voiceoverRewrite: asText(plan.voiceoverRewrite),
            grokGenerationNotes: plan.grokGenerationNotes,
          },
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "完整视频生成失败。");

      updateVideoProgress({
        active: true,
        startedAt,
        expectedSeconds: 240,
        percentage: 78,
        stage: "完整视频：保存记录",
        detail: "模型已返回视频，正在写入项目视频记录，保证刷新后仍可预览和下载。",
      });

      const localVideoUrl = result.localVideos?.[0]?.publicUrl || result.videoUrls?.[0];
      if (!localVideoUrl) throw new Error("模型返回成功但没有可用视频地址。");

      const saveResponse = await fetch(`/api/project/${id}/video-clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: versionId || undefined,
          shotId: segment?.shotId ?? CLONE_FULL_VIDEO_SHOT_ID,
          assetId: null,
          videoUrl: localVideoUrl,
          duration: segment?.duration ?? totalDuration ?? null,
          provider: channel.name || "clone-full-video",
          model,
          transitionType: "direct_concat",
        }),
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saved.error || "完整视频已生成，但写入本地记录失败。");

      setSavedVideoClips((current) => ({
        ...current,
        [segment?.shotId ?? CLONE_FULL_VIDEO_SHOT_ID]: saved,
      }));
      removePendingCloneVideoTask(pendingShotId);
      const savedUrl = saved.filePath || localVideoUrl;
      setCloneFullVideoJob({ status: "done", videoUrl: segment ? undefined : savedUrl });
      setRunningCloneSegmentIndex(null);
      if (savedUrl) {
        setVideoReloadTokens((current) => ({
          ...current,
          [savedUrl]: Date.now(),
        }));
      }
      await loadVideoClips(true);
      updateVideoProgress({
        active: false,
        startedAt,
        expectedSeconds: 240,
        percentage: 100,
        etaSeconds: 0,
        stage: segment ? `任务 ${segment.segmentIndex}：完成` : "完整视频：完成",
        detail: segment
          ? `第 ${segment.segmentIndex} 段已保存到本地。验收通过后继续生成下一段，全部完成后去导出页合成完整视频。`
          : "完整视频已保存到本地项目记录，可在当前页和导出页预览/下载。",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "完整视频生成失败。";
      removePendingCloneVideoTask(pendingShotId);
      setCloneFullVideoJob({ status: "failed", error: message });
      setRunningCloneSegmentIndex(null);
      updateVideoProgress({
        active: false,
        startedAt,
        expectedSeconds: 240,
        percentage: 100,
        etaSeconds: 0,
        stage: "完整视频：失败",
        detail: message,
      });
    }
  }

  async function regenerateCurrentVideoStage() {
    if (isCloneFullVideoProject && clonePlan) {
      if (isSegmentedCloneVideoModel) {
        const runnableSegments = cloneVideoSegments.filter((segment) => segment.referenceImageUrls.length > 0);
        if (runnableSegments.length === 0) {
          setError("当前没有可用于视频生成的分段参考资产，请先回素材页生成并确认资产图。");
          return;
        }
        for (const segment of runnableSegments) {
          await generateCloneFullVideo(
            clonePlan,
            segment.referenceImageUrls[0] || cloneReferenceImageUrl,
            segment.referenceImageUrls,
            {
              segmentIndex: segment.segmentIndex,
              shotId: segment.shotId,
              duration: segment.duration,
              start: segment.start,
              end: segment.end,
            }
          );
        }
        return;
      }

      await generateCloneFullVideo(clonePlan, cloneReferenceImageUrl, cloneReferenceImageUrls);
      return;
    }

    await generateClipVideos();
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
            <span className="text-sm text-muted-foreground">{data?.project.name ?? "视频合成"}</span>
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
                <div className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${i === 2 ? "bg-primary text-primary-foreground" : i < 2 ? "text-primary" : "text-muted-foreground"}`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i === 2 ? "bg-white/20" : i < 2 ? "bg-primary/20" : "bg-muted"}`}>
                    {i < 2 ? "✓" : i + 1}
                  </span>
                  {step}
                </div>
                {i < 3 && <div className="mx-1 h-px w-4 bg-border" />}
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <ProjectVersionBar
          projectId={id}
          compact
          onRegenerateVideo={() => void regenerateCurrentVideoStage()}
          regenerateVideoDisabled={
            isCloneFullVideoProject
              ? !clonePlan
                || !cloneVideoProviderReady
                || cloneFullVideoJob.status === "running"
                || (isSegmentedCloneVideoModel && cloneVideoSegments.every((segment) => segment.referenceImageUrls.length === 0))
              : !allAssetsReady || !videoReady || isGeneratingVideos
          }
        />
        <ProjectLocalArchive projectId={id} versionId={versionId} compact />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">{isCloneFullVideoProject ? "爆款完整视频资产包" : "视频时间线"}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {isLoading
                    ? "正在读取真实素材..."
                    : isCloneFullVideoProject
                      ? `${readyCount}/${clips.length} 张辅助资产已就绪 · 生成完整视频时会作为参考图输入`
                      : `${clips.length} 个片段 · 总时长 ${totalDuration}s · ${statusMessage}`}
                </p>
              </div>
              <Link href={`/project/${id}/assets${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`}>
                <Button variant="outline" size="sm" className="text-xs">
                  <LuArrowLeft className="mr-1 h-3.5 w-3.5" />
                  返回素材
                </Button>
              </Link>
            </div>

            <div className="space-y-1">
              {isCloneFullVideoProject ? (
                <div className="space-y-4">
                  <Card className="glass-card border-primary/30">
                    <CardContent className="space-y-4 p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <Badge variant="secondary">完整视频资产包</Badge>
                          <h3 className="mt-3 text-xl font-bold">确认 image-2 资产图后，再生成完整视频</h3>
                          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                            爆款复刻不会按普通项目逐镜头生成视频。这里的图片是完整视频模型的参考资产：人物多视图、产品结构图、首帧锚图、场景锚图和细节图。
                          </p>
                        </div>
                        <Badge variant={allAssetsReady ? "secondary" : "outline"}>
                          {allAssetsReady ? "资产已就绪" : "还有资产未生成"}
                        </Badge>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        {clips.map((clip) => {
                          const preview = clip.thumbnailPath || clip.filePath;
                          return (
                            <div key={clip.shotId} className="rounded-xl border border-border/50 bg-muted/20 p-3">
                              <div className="mb-3 flex items-center justify-between gap-2">
                                <p className="line-clamp-1 text-sm font-medium">{clip.description || `资产 ${clip.shotId}`}</p>
                                <Badge variant={clip.status === "done" ? "secondary" : "outline"} className="text-[10px]">
                                  {clip.status === "done" ? "可用于视频" : "未完成"}
                                </Badge>
                              </div>
                              <div className="flex gap-3">
                                <div className="flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-background/40">
                                  {preview ? (
                                    <img src={preview} alt={`clone-asset-${clip.shotId}`} className="h-full w-full object-cover" />
                                  ) : (
                                    <LuImage className="h-5 w-5 text-muted-foreground/40" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{clip.prompt}</p>
                                  <p className="mt-2 line-clamp-1 text-[11px] text-muted-foreground">{clip.camera}</p>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {!allAssetsReady && (
                        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-600">
                          请先回到素材页把 image-2 资产图全部生成并确认预览。资产完成后，本页会把这些图作为完整视频生成参考。
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              ) : (
              videoDrafts.map(({ clip, draft, baseDraft }, index) => {
                const typeInfo = shotTypeLabels[clip.shotType];
                const preview = clip.thumbnailPath || clip.filePath;
                const savedClip = savedVideoClips[clip.shotId];
                const savedVideoUrl = savedClip?.status === "done" ? savedClip.filePath : null;
                const job = jobs[clip.shotId] ?? (savedVideoUrl ? { status: "done" as VideoJobStatus, videoUrls: [savedVideoUrl] } : { status: "idle" as VideoJobStatus });
                const clipVideoUrl = job.videoUrls?.[0] || savedVideoUrl;
                const clipVideoPreviewUrl = videoSrcWithReloadToken(clipVideoUrl);
                const promptJob = promptJobs[clip.shotId] ?? { status: "idle" as const };
                const isCustomPrompt = Boolean(customVideoPrompts[clip.shotId]);
                return (
                  <div key={clip.shotId}>
                    <Card className="glass-card">
                      <CardContent className="p-4">
                        <div className="flex items-start gap-4">
                          <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/30 bg-muted/30">
                            {preview ? (
                              <img src={preview} alt={`shot-${clip.shotId}`} className="h-full w-full object-cover" />
                            ) : (
                              <LuImage className="h-4 w-4 text-muted-foreground/40" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="mb-1 flex items-center gap-2">
                              <Badge className={`${typeInfo.color} border-0 text-[10px]`}>{typeInfo.label}</Badge>
                              <span className="text-xs text-muted-foreground">{clip.duration}s</span>
                              <Badge variant={clip.status === "done" ? "secondary" : "outline"} className="text-[10px]">
                                {clip.status === "done" ? "素材就绪" : "待素材"}
                              </Badge>
                              <Badge variant={job.status === "done" ? "secondary" : job.status === "failed" ? "destructive" : "outline"} className="text-[10px]">
                                {job.status === "idle" ? "视频待生成" : job.status === "queued" ? "排队" : job.status === "running" ? "生成中" : job.status === "done" ? "视频完成" : "视频失败"}
                              </Badge>
                              <Badge variant={isCustomPrompt ? "secondary" : "outline"} className="text-[10px]">
                                {promptJob.status === "running" ? "LLM 生成中" : isCustomPrompt ? `LLM 视频导演稿 v${promptVersions[clip.shotId] || 1}` : "规则视频导演稿"}
                              </Badge>
                            </div>
                            <div className="space-y-1 rounded-md border border-border/30 bg-muted/15 p-2">
                              <p className="line-clamp-2 text-xs text-foreground">中文画面：{clip.description || "未填写"}</p>
                              <p className="line-clamp-1 text-xs text-muted-foreground">中文运镜：{clip.camera || "未填写"}</p>
                              <p className="line-clamp-1 text-xs text-muted-foreground">配音：{clip.voiceover || "未填写"}</p>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              Seedance 视频导演稿：{draft.prompt}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setSelectedDraft({ clip, draft })}>
                                <LuFileText className="mr-1 h-3 w-3" />
                                预览视频提示词
                              </Button>
                              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void copyText(draft.prompt)}>
                                <LuCopy className="mr-1 h-3 w-3" />
                                复制
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px]"
                                disabled={!llmReady || promptJob.status === "running"}
                                onClick={() => void regenerateVideoPrompt(clip, baseDraft)}
                              >
                                {promptJob.status === "running" ? "LLM 生成中" : isCustomPrompt ? "再生成一版视频导演稿" : "LLM 生成视频导演稿"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px]"
                                disabled={!videoReady || clip.status !== "done" || job.status === "running"}
                                onClick={() => void generateOneClipVideo(clip, draft)}
                              >
                                {job.status === "running" ? "本镜头生成中" : job.status === "done" ? "重新生成本镜头" : "生成本镜头视频"}
                              </Button>
                            </div>
                            {job.error && <p className="mt-2 text-xs text-destructive">{job.error}</p>}
                            {promptJob.error && <p className="mt-2 text-xs text-destructive">视频提示词生成失败：{promptJob.error}</p>}
                            {clipVideoUrl && (
                              <div className="mt-3 max-w-[220px] space-y-2">
                                <video
                                  key={clipVideoPreviewUrl ?? clipVideoUrl}
                                  controls
                                  playsInline
                                  preload="metadata"
                                  className="aspect-[9/16] max-h-72 w-full rounded-lg border border-border/40 bg-black object-contain"
                                  src={clipVideoPreviewUrl ?? clipVideoUrl}
                                  onError={() => retryVideoPreview(clipVideoUrl)}
                                />
                                <a href={clipVideoUrl} target="_blank" rel="noreferrer" className="inline-flex text-xs text-primary hover:underline">
                                  查看生成视频
                                </a>
                              </div>
                            )}
                          </div>

                          <span className="shrink-0 text-sm font-bold text-muted-foreground/30">{String(clip.shotId).padStart(2, "0")}</span>
                        </div>
                      </CardContent>
                    </Card>

                    {index < clips.length - 1 && (
                      <div className="flex items-center justify-center py-1.5">
                        <div className="flex items-center gap-2 rounded-full border border-border/30 bg-muted/20 px-3 py-1">
                          <LuChevronDown className="h-3 w-3 text-muted-foreground" />
                          <span className="text-[11px] text-muted-foreground">{transitionLabels[clip.transition] ?? "默认转场"}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }))}
            </div>

            {!isLoading && clips.length === 0 && (
              <Card className="glass-card">
                <CardContent className="p-8 text-center text-sm text-muted-foreground">
                  当前项目还没有素材，请先回到素材页生成。
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-4 lg:col-span-1">
            <h2 className="text-base font-semibold">合成设置</h2>

            {!isCloneFullVideoProject && (
            <Card className="glass-card">
              <CardContent className="space-y-4 p-4">
                <Label className="text-sm font-medium">当前状态</Label>
                <p className="text-xs leading-relaxed text-muted-foreground">{statusMessage}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  视频阶段会重新编译给 Seedance 的英文导演稿：关键帧图作为首帧锚点，图片 prompt 只提供静态视觉约束，视频 prompt 会额外加入动作、运镜、时长、转场和负面约束。
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  LLM 会为每个分镜写完整视频导演稿：首帧锁定、动作、运镜、时序、表情口型、产品一致性和负面约束都会写清楚。
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  同一张关键帧可以多次生成不同动作/运镜版本；当前选中的那版会随关键帧图一起发送给视频模型。
                </p>
                {!llmReady && (
                  <p className="text-xs leading-relaxed text-amber-600">
                    LLM 还没有配置完整，当前只能使用规则导演稿。
                  </p>
                )}
                {!videoReady && (
                  <p className="text-xs leading-relaxed text-amber-600">
                    视频接口还没配置完整，当前不会模拟生成；配置好后会走真实调用。
                  </p>
                )}
                <div className="space-y-2 rounded-lg border border-border/40 bg-muted/15 p-3">
                  <Label className="text-xs font-medium">本次普通项目视频模型</Label>
                  <Select
                    value={selectedVideoChannel?.id || selectedVideoChannelId}
                    onValueChange={(value) => setSelectedVideoChannelId(value || selectedVideoChannelId)}
                  >
                    <SelectTrigger className="border-border/50 bg-background/70 text-xs">
                      <SelectValue placeholder="从设置页已开启的视频模型中选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {shotVideoChannels.map((channel) => (
                        <SelectItem key={channel.id} value={channel.id}>
                          {channel.name || channel.model || channel.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                    <p>通道：{selectedVideoChannel?.name || "未选择"}</p>
                    <p>模型：{selectedVideoChannel?.model || "未填写"}</p>
                    <p>地址：{selectedVideoChannel?.baseUrl || "未填写"}</p>
                    <p>任务类型：普通项目单镜头分镜；720p 模型会自动限制输出分辨率。</p>
                  </div>
                </div>
                {isGeneratingVideos && (
                  <p className="text-xs leading-relaxed text-primary">
                    正在真实调用视频接口：已完成 {finishedVideoCount}/{clips.length}，失败 {failedVideoCount}。
                  </p>
                )}
                {videoProgress && (
                  <GenerationProgress
                    title={videoProgress.active ? "Video generation running" : "Video generation status"}
                    active={videoProgress.active}
                    percentage={videoProgress.percentage}
                    elapsedSeconds={videoProgress.elapsedSeconds}
                    etaSeconds={videoProgress.etaSeconds}
                    stage={videoProgress.stage}
                    detail={videoProgress.detail}
                  />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  disabled={!llmReady || !allAssetsReady || isRegeneratingAllPrompts}
                  onClick={() => void regenerateAllVideoPrompts()}
                >
                  {isRegeneratingAllPrompts ? "LLM 正在生成全部视频导演稿" : "LLM 为全部镜头生成视频导演稿"}
                </Button>
              </CardContent>
            </Card>
            )}

            {clonePlan && (
              <Card className="glass-card border-primary/30">
                <CardContent className="space-y-4 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label className="text-sm font-medium">爆款复刻完整视频</Label>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        读取参考视频细拆、方法判断、资产反推、生图资产包和 LLM 生成的完整导演稿，独立调用当前选择的视频模型。
                      </p>
                    </div>
                    <Badge variant={cloneFullVideoJob.status === "done" ? "secondary" : cloneFullVideoJob.status === "failed" ? "destructive" : "outline"} className="shrink-0 text-[10px]">
                      {cloneFullVideoJob.status === "running"
                        ? "生成中"
                        : cloneFullVideoJob.status === "done"
                          ? "已生成"
                          : cloneFullVideoJob.status === "failed"
                            ? "失败"
                            : "待生成"}
                    </Badge>
                  </div>

                  <div className="space-y-2 rounded-lg border border-border/40 bg-muted/15 p-3 text-xs">
                    <p><span className="text-muted-foreground">方法类型：</span>{asText(clonePlan.methodType) || "未写入"}</p>
                    <p><span className="text-muted-foreground">判断理由：</span>{asText(clonePlan.selectedMethodReason) || "未写入"}</p>
                    <p><span className="text-muted-foreground">首帧锚图：</span>{cloneAssetAnchor ? "来自爆款复刻 image-2 辅助资产包" : cloneReferenceImageUrl ? "来自已生成关键帧" : "暂无锚图，将按纯文本导演稿生成"}</p>
                    <p><span className="text-muted-foreground">视频模型：</span>{activeCloneVideoChannel?.name || "未选择"}</p>
                    <p><span className="text-muted-foreground">当前模型：</span>{activeCloneVideoChannel?.model || "未填写"}</p>
                    <p><span className="text-muted-foreground">目标时长：</span>{cloneFullVideoTargetDuration} 秒</p>
                    <p><span className="text-muted-foreground">参考图输入：</span>{cloneReferenceImageUrls.length} 张，试验模式为 {CLONE_VIDEO_ASSET_REFERENCE_LIMIT} 张资产图 + {CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT} 张商品正面结构锁图</p>
                    {isSegmentedCloneVideoModel && (
                      <p><span className="text-muted-foreground">{segmentedCloneModelLabel} 拆段：</span>{omniCloneDurationPlan}</p>
                    )}
                  </div>

                  {isSegmentedCloneVideoModel && (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
                      <p className="font-medium text-foreground">{segmentedCloneModelLabel} 分段执行确认：完整导演稿优先，随后按 {omniCloneDurationPlan} 顺序生成</p>
                      <p className="mt-1">
                        本页不会重新把完整视频当成普通单镜头处理。系统会把当前 fullVideoPrompt 作为完整源稿，再拆成 {omniCloneDurationSegments.length} 个 {segmentedCloneModelLabel} 任务；每段优先使用 {CLONE_VIDEO_ASSET_REFERENCE_LIMIT} 张资产图，并额外追加 {CLONE_VIDEO_PRODUCT_REFERENCE_LIMIT} 张商品正面结构锁图，由你手动逐段生成、逐段验收，全部通过后去导出页用 FFmpeg 合成。
                      </p>
                      <p className="mt-1">{segmentedCloneModelDurationTip}。</p>
                      {omniCloneGeneratedDuration > cloneFullVideoTargetDuration && (
                        <p className="mt-1 text-amber-600">
                          {segmentedCloneModelLabel} 实际分段合计 {omniCloneGeneratedDuration} 秒，最终导出时按目标 {cloneFullVideoTargetDuration} 秒处理。
                        </p>
                      )}
                    </div>
                  )}

                  <details className="rounded-lg border border-border/40 bg-muted/15 p-3">
                    <summary className="cursor-pointer text-xs font-medium">查看完整导演稿和资产计划</summary>
                    <div className="mt-3 space-y-3">
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">英文 Grok 完整视频 Prompt</p>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 text-[11px] leading-relaxed">
                          {cloneFullVideoPrompt || "未生成 fullVideoPrompt"}
                        </pre>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">负面约束</p>
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 text-[11px] leading-relaxed">
                          {asText(clonePlan.negativePrompt) || "未生成 negativePrompt"}
                        </pre>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">资产反推计划</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 text-[11px] leading-relaxed">
                          {asText(clonePlan.assetPlan) || "未生成 assetPlan"}
                        </pre>
                      </div>
                    </div>
                  </details>

                  {cloneFullVideoJob.error && (
                    <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                      {cloneFullVideoJob.error}
                    </p>
                  )}

                  {isSegmentedCloneVideoModel && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium">分段视频任务</Label>
                        <Badge variant={cloneSegmentDoneCount === cloneVideoSegments.length ? "secondary" : "outline"} className="text-[10px]">
                          {cloneSegmentDoneCount}/{cloneVideoSegments.length} 段完成
                        </Badge>
                      </div>
                      {hasActivePendingCloneVideoTask && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700">
                          有视频任务已经提交到模型后台，本页正在每 5 秒轮询本地保存记录。你切到导出页或刷新页面后，任务提示也会保留；模型回传并写入本地后会自动显示预览。
                        </div>
                      )}
                      {cloneVideoSegments.map((segment) => {
                        const segmentUrl = segment.saved?.filePath || null;
                        const segmentPreviewUrl = videoSrcWithReloadToken(segmentUrl);
                        const pendingTask = activePendingCloneVideoTasks[segment.shotId];
                        const pendingMinutes = pendingTask ? Math.max(0, Math.floor((Date.now() - pendingTask.startedAt) / 60000)) : 0;
                        const anySegmentRunning = cloneFullVideoJob.status === "running" || hasActivePendingCloneVideoTask;
                        const running = (cloneFullVideoJob.status === "running" && runningCloneSegmentIndex === segment.segmentIndex) || Boolean(pendingTask && !segmentUrl);
                        const autoSegmentPrompt = buildCloneSegmentPrompt(clonePlan, cloneFullVideoPrompt, {
                          segmentIndex: segment.segmentIndex,
                          start: segment.start,
                          end: segment.end,
                        });
                        const segmentPrompt = customCloneSegmentPrompts[segment.segmentIndex] || autoSegmentPrompt;
                        const segmentRequestPreview = buildCloneVideoRequestPreview({
                          segmentIndex: segment.segmentIndex,
                          duration: segment.duration,
                          start: segment.start,
                          end: segment.end,
                          model: activeCloneVideoChannel?.model,
                          channelName: activeCloneVideoChannel?.name,
                          aspectRatio: config.aspectRatio,
                          resolution: effectiveResolutionForModel(activeCloneVideoChannel?.model, config.resolution),
                          prompt: segmentPrompt,
                          negativePrompt: asText(clonePlan.negativePrompt),
                          references: segment.referenceImages,
                        });
                        return (
                          <div key={segment.segmentIndex} className="rounded-lg border border-border/40 bg-muted/15 p-3">
                            <div className="mb-2 flex items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-medium">任务 {segment.segmentIndex}：{segment.start}-{segment.end}s</p>
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  时长 {segment.duration}s · 参考图 {segment.referenceImageUrls.length}/{CLONE_VIDEO_TOTAL_REFERENCE_LIMIT} 张 · shotId {segment.shotId}
                                </p>
                              </div>
                              <Badge variant={acceptedCloneSegments[segment.segmentIndex] ? "secondary" : segment.saved?.status === "done" ? "outline" : "outline"} className="text-[10px]">
                                {acceptedCloneSegments[segment.segmentIndex] ? "已验收" : segment.saved?.status === "done" ? "待验收" : "待生成"}
                              </Badge>
                            </div>
                            {segment.referenceImages.length > 0 && (
                              <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                                {segment.referenceImages.map((item, index) => (
                                  <button
                                    key={`${segment.segmentIndex}-${item.url}-${index}`}
                                    type="button"
                                    className="w-[74px] shrink-0 overflow-hidden rounded border border-border/40 bg-background text-left"
                                    onClick={() => window.open(item.url, "_blank")}
                                    title={`${item.role}: ${item.note}`}
                                  >
                                    <span className="block h-14 w-full overflow-hidden bg-muted">
                                      <img src={item.url} alt={`segment-${segment.segmentIndex}-ref-${index + 1}`} className="h-full w-full object-cover" />
                                    </span>
                                    <span className="block truncate px-1 py-1 text-[9px] leading-none text-muted-foreground">
                                      {index + 1}. {item.role}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                            <details className="mb-2 rounded-md border border-border/40 bg-background/60 p-2">
                              <summary className="cursor-pointer text-[11px] font-medium text-primary">查看本段最终请求预览 / 参考图角色 / prompt</summary>
                              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-[10px] leading-relaxed">
                                {segmentRequestPreview}
                              </pre>
                            </details>
                            <details className="mb-2 rounded-md border border-border/40 bg-background/60 p-2">
                              <summary className="cursor-pointer text-[11px] font-medium text-primary">编辑本段最终视频提示词（只影响本段下一次生成）</summary>
                              <textarea
                                className="mt-2 min-h-48 w-full rounded-md border border-border/50 bg-background p-2 font-mono text-[10px] leading-relaxed outline-none focus:border-primary"
                                value={segmentPrompt}
                                onChange={(event) => setCustomCloneSegmentPrompts((current) => ({
                                  ...current,
                                  [segment.segmentIndex]: event.target.value,
                                }))}
                              />
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px]"
                                  onClick={() => setCustomCloneSegmentPrompts((current) => {
                                    const next = { ...current };
                                    delete next[segment.segmentIndex];
                                    return next;
                                  })}
                                >
                                  恢复自动提示词
                                </Button>
                                <span className="self-center text-[10px] text-muted-foreground">
                                  当前长度 {segmentPrompt.length} 字符
                                </span>
                              </div>
                            </details>
                            {pendingTask && !segmentUrl && (
                              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-700">
                                <p className="font-medium">任务 {segment.segmentIndex} 已提交到模型后台，正在等待本地回传保存。</p>
                                <p className="mt-1">
                                  已等待约 {pendingMinutes} 分钟；模型：{pendingTask.model || activeCloneVideoChannel?.model || "未记录"}；通道：{pendingTask.channelName || activeCloneVideoChannel?.name || "未记录"}。你可以切到其他页面，本提示会保留，视频写入数据库后这里会自动变成预览窗口。
                                </p>
                              </div>
                            )}
                            {segmentUrl && (
                              <div className="mb-2 space-y-2">
                                <video
                                  key={segmentPreviewUrl ?? segmentUrl}
                                  controls
                                  playsInline
                                  preload="metadata"
                                  className="aspect-[9/16] max-h-72 w-full rounded-lg border border-border/40 bg-black object-contain"
                                  src={segmentPreviewUrl ?? segmentUrl}
                                  onError={() => retryVideoPreview(segmentUrl)}
                                />
                                <div className="rounded-md border border-border/40 bg-background/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
                                  <p>本地预览路径：{segmentUrl}</p>
                                  <p>生成模型：{segment.saved?.model || activeCloneVideoChannel?.model || "未记录"}</p>
                                  <p>提供方：{segment.saved?.provider || activeCloneVideoChannel?.name || "未记录"}</p>
                                  <p>记录状态：{segment.saved?.status || "未记录"}</p>
                                </div>
                              </div>
                            )}
                            <Button
                              className="w-full text-xs"
                              variant={segmentUrl ? "outline" : "default"}
                              disabled={!cloneFullVideoPrompt || !cloneVideoProviderReady || anySegmentRunning || segment.referenceImageUrls.length === 0}
                              onClick={() => void generateCloneFullVideo(
                                clonePlan,
                                segment.referenceImageUrls[0] || cloneReferenceImageUrl,
                                segment.referenceImageUrls,
                                {
                                  segmentIndex: segment.segmentIndex,
                                  shotId: segment.shotId,
                                  duration: segment.duration,
                                  start: segment.start,
                                  end: segment.end,
                                },
                                segmentPrompt
                              )}
                            >
                              {running
                                ? "生成中..."
                                : anySegmentRunning
                                  ? "等待当前任务完成"
                                  : segmentUrl
                                    ? `重新生成任务 ${segment.segmentIndex}`
                                    : `生成任务 ${segment.segmentIndex}`}
                            </Button>
                            {segmentUrl && (
                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={acceptedCloneSegments[segment.segmentIndex] ? "secondary" : "outline"}
                                  className="h-8 text-[11px]"
                                  onClick={() => setAcceptedCloneSegments((current) => ({ ...current, [segment.segmentIndex]: true }))}
                                >
                                  通过验收
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-8 text-[11px]"
                                  disabled={anySegmentRunning}
                                  onClick={() => void generateCloneFullVideo(
                                    clonePlan,
                                    segment.referenceImageUrls[0] || cloneReferenceImageUrl,
                                    segment.referenceImageUrls,
                                    {
                                      segmentIndex: segment.segmentIndex,
                                      shotId: segment.shotId,
                                  duration: segment.duration,
                                  start: segment.start,
                                  end: segment.end,
                                    },
                                    segmentPrompt
                                  )}
                                >
                                  不通过重生
                                </Button>
                                <Link href={`/project/${id}/assets${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`} className="inline-flex">
                                  <Button type="button" size="sm" variant="outline" className="h-8 w-full text-[11px]">
                                    回素材页换图
                                  </Button>
                                </Link>
                              </div>
                            )}
                            {segment.referenceImageUrls.length === 0 && (
                              <p className="mt-2 text-[11px] text-amber-600">
                                本段还没有验收通过的参考资产图，请先回素材页生成并确认第 {segment.segmentIndex} 段资产包。
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {cloneVideoUrl && (
                    <div className="space-y-2">
                      <video
                        key={cloneVideoPreviewUrl ?? cloneVideoUrl}
                        controls
                        playsInline
                        preload="metadata"
                        className="aspect-[9/16] max-h-80 w-full rounded-lg border border-border/40 bg-black object-contain"
                        src={cloneVideoPreviewUrl ?? cloneVideoUrl}
                        onError={() => retryVideoPreview(cloneVideoUrl)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <a href={cloneVideoUrl} target="_blank" rel="noreferrer" className="inline-flex text-xs text-primary hover:underline">
                          新窗口预览
                        </a>
                        <a href={`${cloneVideoUrl}?download=1`} className="inline-flex text-xs text-primary hover:underline">
                          下载完整视频
                        </a>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 rounded-lg border border-border/40 bg-muted/15 p-3">
                    <Label className="text-xs font-medium">本次爆款复刻视频模型</Label>
                    <Select
                      value={activeCloneVideoChannel?.id || selectedCloneVideoChannelId}
                      onValueChange={(value) => {
                        setCloneVideoChannelTouched(true);
                        setSelectedCloneVideoChannelId(value || selectedCloneVideoChannelId);
                      }}
                    >
                      <SelectTrigger className="border-border/50 bg-background/70 text-xs">
                        <SelectValue placeholder="选择视频模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {(cloneVideoChannels.length ? cloneVideoChannels : activeCloneVideoChannel ? [activeCloneVideoChannel] : []).map((channel) => (
                          <SelectItem key={channel.id} value={channel.id}>
                            {channel.name || channel.model || channel.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                      <p>通道：{activeCloneVideoChannel?.name || "未选择"}</p>
                      <p>状态：{activeCloneVideoChannel?.enabled === false ? "已暂停" : "开启"}</p>
                      <p>模型：{activeCloneVideoChannel?.model || "未填写"}</p>
                      <p>地址：{activeCloneVideoChannel?.baseUrl || "未填写"}</p>
                    </div>
                  </div>

                  <Button
                    className="w-full brand-gradient text-white"
                    disabled={!cloneFullVideoPrompt || !cloneVideoProviderReady || cloneFullVideoJob.status === "running" || isSegmentedCloneVideoModel}
                    onClick={() => void generateCloneFullVideo(clonePlan, cloneReferenceImageUrl, cloneReferenceImageUrls)}
                  >
                    {isSegmentedCloneVideoModel
                      ? "请在上方逐段生成任务"
                      : cloneFullVideoJob.status === "running"
                        ? "正在生成完整视频"
                        : cloneVideoUrl
                          ? "重新生成完整视频"
                          : "生成完整视频"}
                  </Button>
                  {!cloneVideoProviderReady && (
                    <p className="text-xs leading-relaxed text-amber-600">
                      当前视频模型未开启或配置不完整，请到设置页开启该模型，并填写 API Key、Base URL 和模型名。
                    </p>
                  )}
                  {!cloneFullVideoPrompt && (
                    <p className="text-xs leading-relaxed text-amber-600">
                      当前项目还没有保存 fullVideoPrompt，请回到爆款复刻页重新执行“开始复刻”。
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="glass-card">
              <CardContent className="space-y-4 p-4">
                <Label className="text-sm font-medium">配音 (TTS)</Label>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">启用自动配音</span>
                  <button
                    onClick={() => setConfig((current) => ({ ...current, ttsEnabled: !current.ttsEnabled }))}
                    className={`relative h-5 w-10 rounded-full transition-colors ${config.ttsEnabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.ttsEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
                {config.ttsEnabled && (
                  <Select value={config.ttsVoice} onValueChange={(value) => setConfig((current) => ({ ...current, ttsVoice: value || current.ttsVoice }))}>
                    <SelectTrigger className="border-border/50 bg-muted/30 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="female-gentle">女声 - 温柔</SelectItem>
                      <SelectItem value="female-energetic">女声 - 活力</SelectItem>
                      <SelectItem value="male-warm">男声 - 温暖</SelectItem>
                      <SelectItem value="male-pro">男声 - 专业</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </CardContent>
            </Card>

            <Card className="glass-card">
              <CardContent className="space-y-4 p-4">
                <Label className="text-sm font-medium">画面设置</Label>
                <div className="grid grid-cols-3 gap-2">
                  {(["9:16", "16:9", "1:1"] as const).map((ratio) => (
                    <button
                      key={ratio}
                      onClick={() => setConfig((current) => ({ ...current, aspectRatio: ratio }))}
                      className={`h-9 rounded-md border text-xs transition-all ${config.aspectRatio === ratio ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"}`}
                    >
                      {ratio === "9:16" ? "竖屏" : ratio === "16:9" ? "横屏" : "方形"}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(["720p", "1080p"] as const).map((resolution) => {
                    const disabled = modelForces720p && resolution === "1080p";
                    return (
                      <button
                        key={resolution}
                        disabled={disabled}
                        onClick={() => setConfig((current) => ({ ...current, resolution }))}
                        className={`h-9 rounded-md border text-xs transition-all ${
                          config.resolution === resolution
                            ? "border-primary bg-primary/10 text-primary"
                            : disabled
                              ? "cursor-not-allowed border-border/30 bg-muted/10 text-muted-foreground/40"
                              : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {resolution}{resolution === "720p" && modelForces720p ? " 推荐" : ""}
                      </button>
                    );
                  })}
                </div>
                {modelForces720p && (
                  <p className="text-xs leading-relaxed text-amber-600">
                    当前视频模型名包含 720p，视频生成请求会固定使用 720p，避免 1080p 参数导致无预览或任务失败。
                  </p>
                )}
              </CardContent>
            </Card>

            {!isCloneFullVideoProject && (
              <Button
                disabled={!allAssetsReady || !videoReady || isGeneratingVideos}
                className="w-full brand-gradient text-white"
                onClick={() => void generateClipVideos()}
              >
                {isGeneratingVideos ? <LuVideo className="mr-1 h-4 w-4 animate-pulse" /> : <LuPlay className="mr-1 h-4 w-4" />}
                {!allAssetsReady ? "等待素材完成" : !videoReady ? "视频接口未配置" : isGeneratingVideos ? "正在生成镜头视频" : "开始生成镜头视频"}
              </Button>
            )}
            <Link href={`/project/${id}/export${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`}>
              <Button variant="outline" className="w-full" disabled={!allAssetsReady}>
                查看导出页
                <LuArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>

        {selectedDraft && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setSelectedDraft(null)}>
            <div className="max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div>
                  <h3 className="font-semibold">Shot {String(selectedDraft.clip.shotId).padStart(2, "0")} 视频提示词预览</h3>
                  <p className="text-xs text-muted-foreground">左侧是关键帧、中文分镜提示词和参数；右侧是本次提交给视频模型的完整英文视频导演稿。</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelectedDraft(null)}>关闭</Button>
              </div>
              <div className="grid max-h-[72vh] grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-[280px_1fr]">
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
                    {selectedDraft.draft.imageUrl ? (
                      <img src={selectedDraft.draft.imageUrl} alt={`shot-${selectedDraft.clip.shotId}`} className="w-full object-cover" />
                    ) : (
                      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">缺少关键帧图</div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                    <p>模式：image-to-video</p>
                    <p>模型：{selectedVideoModel || "seedance-v1-5-pro"}</p>
                    <p>时长：{selectedDraft.clip.duration}s</p>
                    <p>尺寸：{selectedDraft.draft.width} x {selectedDraft.draft.height}</p>
                    <p>中文画面：{selectedDraft.clip.description || "未填写"}</p>
                    <p>中文运镜：{selectedDraft.clip.camera || "未填写"}</p>
                    <p>配音：{config.ttsEnabled ? selectedDraft.clip.voiceover || "未填写" : "未启用"}</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <Button variant="outline" size="sm" onClick={() => void copyText(selectedDraft.draft.prompt)}>
                    <LuCopy className="mr-1 h-3.5 w-3.5" />
                    复制视频提示词
                  </Button>
                  <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-4 text-xs leading-relaxed text-foreground">
                    {selectedDraft.draft.prompt}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

