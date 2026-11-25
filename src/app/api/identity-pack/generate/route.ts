import { NextRequest, NextResponse } from "next/server";
import { createProvider, ProviderError } from "@/lib/providers";
import { imageDimensionsForPreset } from "@/lib/image-output-size";
import {
  finalizeIdentityPendingResult,
  getIdentityPack,
  saveIdentityPendingResult,
  summarizeIdentityPendingResult,
  updateIdentityPendingResult,
  type IdentityGenerationTiming,
  type IdentityReference,
  type IdentityReferenceGroup,
} from "@/lib/identity-pack";
import { readIdentityImageBytes } from "@/lib/identity-pack-result";
import { prepareImageEditReferenceUrl } from "@/lib/image-edit-reference";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { storagePaths } from "@/lib/storage-root";
import { resolveImageChannel } from "@/lib/server-model-settings";

export const runtime = "nodejs";
export const maxDuration = 900;

type IdentityGenerateKind =
  | "face_front"
  | "full_body_front"
  | "full_body_left_45"
  | "full_body_right_45"
  | "full_body_side"
  | "full_body_back"
  | "camera_eye_level"
  | "camera_high_angle"
  | "camera_low_angle"
  | "expression_neutral"
  | "expression_smile"
  | "expression_bright_smile"
  | "expression_turn_back"
  | "expression_gesture"
  | "expression_walk";

type KindConfig = {
  title: string;
  role: string;
  group: IdentityReferenceGroup;
  aspectRatio: "3:4" | "9:16";
  prompt: string;
};

const kindConfig: Record<IdentityGenerateKind, KindConfig> = {
  face_front: { title: "人脸正面定型图", role: "白底正面脸部身份基准", group: "base", aspectRatio: "3:4", prompt: "front-facing facial identity calibration portrait, neutral closed-mouth expression, direct lens-aligned gaze, alert relaxed attention, no vacant or glassy eyes" },
  full_body_front: { title: "全身正面比例图", role: "白底全身正面体态与比例基准", group: "base", aspectRatio: "9:16", prompt: "strict front-facing full-body identity reference image" },
  full_body_left_45: { title: "全身左侧45度图", role: "白底左前45度体态基准（以模特自身左肩靠近镜头为准）", group: "base", aspectRatio: "9:16", prompt: "full-body true left-front three-quarter view at exactly 45 degrees. Use the subject's own left/right orientation: her own LEFT shoulder, left cheek, left waist and left thigh must be visibly closer to the camera, while her own right shoulder clearly recedes behind. Turn her head, torso and feet together in the same direction. Upright neutral stance, entire body visible from head to bare feet. This must not be a front view, right-side view, near-front pose, or mirrored duplicate." },
  full_body_right_45: { title: "全身右侧45度图", role: "白底右前45度体态基准（以模特自身右肩靠近镜头为准）", group: "base", aspectRatio: "9:16", prompt: "full-body true right-front three-quarter view at exactly 45 degrees. Use the subject's own left/right orientation: her own RIGHT shoulder, right cheek, right waist and right thigh must be visibly closer to the camera, while her own left shoulder clearly recedes behind. Turn her head, torso and feet together in the same direction. Upright neutral stance, entire body visible from head to bare feet. This must not be a front view, left-side view, near-front pose, or mirrored duplicate." },
  full_body_side: { title: "全身侧面比例图", role: "白底侧面体态与比例基准", group: "base", aspectRatio: "9:16", prompt: "strict side-profile full-body identity reference image" },
  full_body_back: { title: "全身背面比例图", role: "白底背面体态与发长基准", group: "base", aspectRatio: "9:16", prompt: "strict straight-back full-body identity reference image" },
  camera_eye_level: { title: "平视半身镜头图", role: "平视半身镜头适配校准", group: "camera", aspectRatio: "3:4", prompt: "eye-level half-body camera calibration portrait, relaxed standing pose, direct natural gaze" },
  camera_high_angle: { title: "轻俯视半身镜头图", role: "轻俯视半身镜头适配校准", group: "camera", aspectRatio: "3:4", prompt: "mild high-angle half-body camera calibration portrait, natural upward gaze, no exaggerated perspective" },
  camera_low_angle: { title: "轻仰视全身镜头图", role: "轻仰视全身镜头适配校准", group: "camera", aspectRatio: "9:16", prompt: "mild low-angle full-body camera calibration image, natural stance, no exaggerated perspective, entire body visible" },
  // Keep legacy keys so existing records remain valid; only their new generation semantics change.
  expression_neutral: { title: "亲和开场表情图", role: "亲和开场表情基准", group: "expression", aspectRatio: "3:4", prompt: "clear friendly welcome expression with a gentle closed-mouth smile" },
  expression_smile: { title: "热情分享表情图", role: "热情分享表情基准", group: "expression", aspectRatio: "3:4", prompt: "open warm sharing expression with a genuine visible-teeth smile" },
  expression_bright_smile: { title: "专注讲解表情图", role: "专注讲解表情基准", group: "expression", aspectRatio: "3:4", prompt: "serious focused explanation expression with steady gaze and lightly engaged brows" },
  expression_turn_back: { title: "卖点强调表情图", role: "卖点强调表情基准", group: "expression", aspectRatio: "3:4", prompt: "clear emphasis expression with lifted brows and a naturally open speaking mouth" },
  expression_gesture: { title: "互动疑问表情图", role: "互动疑问表情基准", group: "expression", aspectRatio: "3:4", prompt: "engaged questioning expression with one brow subtly higher and a slightly parted mouth" },
  expression_walk: { title: "惊喜反应表情图", role: "惊喜反应表情基准", group: "expression", aspectRatio: "3:4", prompt: "clear restrained surprise expression with raised brows, wider eyes, and a small rounded mouth" },
};

function imageEditPathFromChannel(endpointPath?: string) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/edits";
  return /\/images\/generations$/i.test(value) ? value.replace(/\/images\/generations$/i, "/images/edits") : value;
}

function imageGenerationPathFromChannel(endpointPath?: string) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/generations";
  return /\/images\/edits$/i.test(value) ? value.replace(/\/images\/edits$/i, "/images/generations") : value;
}

function fixedIdentityImageSizePreset(kind: IdentityGenerateKind) {
  void kind;
  return "4k";
}

function readImageTransportTiming(value: unknown): Pick<IdentityGenerationTiming, "upstreamProcessingMs" | "resultTransferMs" | "responseBodyBytes"> {
  if (!value || typeof value !== "object") return {};
  const timing = value as Record<string, unknown>;
  const number = (key: string) => typeof timing[key] === "number" && Number.isFinite(timing[key]) && timing[key] >= 0
    ? Math.round(timing[key] as number)
    : undefined;
  return {
    upstreamProcessingMs: number("upstreamProcessingMs"),
    resultTransferMs: number("resultTransferMs"),
    responseBodyBytes: number("responseBodyBytes"),
  };
}

function referencePriority(reference: IdentityReference) {
  if (reference.group === "source") return 0;
  if (reference.sourceKind === "face_front") return 1;
  if (reference.sourceKind === "full_body_front") return 2;
  if (reference.sourceKind === "full_body_left_45") return 3;
  if (reference.sourceKind === "full_body_right_45") return 4;
  if (reference.sourceKind === "full_body_side") return 5;
  if (reference.sourceKind === "full_body_back") return 6;
  return 10;
}

function describeReferenceRole(reference: IdentityReference, index: number) {
  const imageNumber = index + 1;
  if (reference.sourceKind === "face_front") {
    return `Reference image ${imageNumber} is my face identity reference. Use it to preserve my face shape, eye spacing, eyelids, nose, lips, jawline, hairline, hairstyle, skin tone, and natural age impression.`;
  }
  if (reference.group === "source") {
    return `Reference image ${imageNumber} is my only original face source image that I uploaded. Use it as my same-person identity anchor and strictly preserve my face shape, eye spacing, eyelids, nose, lips, jawline, hairline, hairstyle, natural skin tone, and natural age impression. Do not change me into a different person or invent beauty-filtered facial features.`;
  }
  if (reference.sourceKind === "full_body_front") {
    return `Reference image ${imageNumber} is my full-body proportion reference. Use it to preserve my height impression, head-to-body ratio, shoulder width, torso length, waist-to-hip ratio, leg length, arm length, and natural standing balance.`;
  }
  if (reference.sourceKind === "full_body_left_45" || reference.sourceKind === "full_body_right_45" || reference.sourceKind === "full_body_side") {
    return `Reference image ${imageNumber} is my side-angle and body-proportion reference. Use it to preserve my same-person facial profile, body thickness, shoulder line, waist-to-hip ratio, limb length, and natural posture from this angle.`;
  }
  if (reference.sourceKind === "full_body_back") {
    return `Reference image ${imageNumber} is my back-view and hair-length reference. Use it to preserve my same-person back silhouette, shoulder line, hair length, body proportion, and posture from behind.`;
  }
  return `Reference image ${imageNumber} is another identity calibration image of me. Use it only to maintain my same face, body proportion, skin tone, hairstyle, visible angle, and natural posture.`;
}

type FullBodyCalibrationKind = Extract<IdentityGenerateKind, "full_body_front" | "full_body_left_45" | "full_body_right_45" | "full_body_side" | "full_body_back">;
type CameraCalibrationKind = Extract<IdentityGenerateKind, "camera_eye_level" | "camera_high_angle" | "camera_low_angle">;

const fullBodyViewInstructions: Record<FullBodyCalibrationKind, string> = {
  full_body_front: "Keep my head, chest, waist, hips, legs, and feet facing the camera at zero degrees. Do not turn me into a three-quarter view, side view, back view, or mirrored image.",
  full_body_left_45: "Generate a strict left-front 45-degree full-body image of me. Put the camera 45 degrees in front of my own LEFT side, never the viewer's left/right interpretation. My own LEFT shoulder, left cheek, left waist, left hip, and left thigh must be clearly nearest to the camera and visibly larger, while my own RIGHT shoulder and right side recede behind in visible perspective. In the final camera-facing frame, my near LEFT shoulder is the shoulder on the viewer's RIGHT side. Turn my head, torso, hips, legs, and feet together toward my own LEFT-front direction. This must show an obvious depth difference between both shoulders, not a barely off-center front pose. Do not generate a front view, right-front 45-degree view, near-front view, side view, back view, reflection, or mirrored duplicate.",
  full_body_right_45: "Generate a strict right-front 45-degree full-body image of me. Put the camera 45 degrees in front of my own RIGHT side, never the viewer's left/right interpretation. My own RIGHT shoulder, right cheek, right waist, right hip, and right thigh must be clearly nearest to the camera and visibly larger, while my own LEFT shoulder and left side recede behind in visible perspective. In the final camera-facing frame, my near RIGHT shoulder is the shoulder on the viewer's LEFT side. Turn my head, torso, hips, legs, and feet together toward my own RIGHT-front direction. This must show an obvious depth difference between both shoulders, not a barely off-center front pose. Do not generate a front view, left-front 45-degree view, near-front view, side view, back view, reflection, or mirrored duplicate.",
  full_body_side: "Generate a strict 90-degree side-profile full-body image of me. Keep my head, shoulder line, waist line, hips, legs, and feet facing the same side direction so my side silhouette is clear. Do not generate a front view, back view, left-front 45-degree view, right-front 45-degree view, or mirrored image.",
  full_body_back: "Generate a strict straight-back full-body image of me. Keep the back of my head, back, shoulder line, waist line, hips, legs, and feet facing the camera. Show my complete back silhouette and hair length. Do not turn my head, reveal my face, or generate a front view, side view, left-front 45-degree view, right-front 45-degree view, or mirrored image.",
};

function buildFullBodyPrompt(kind: FullBodyCalibrationKind, extraPrompt: string) {
  return [
    kind === "full_body_front"
      ? "Using Reference image 1, generate one photorealistic, strict front-facing full-body image of me."
      : "Using Reference image 1, generate one photorealistic full-body image of me.",
    "Reference image 1 is the only original face source image I uploaded. Strictly preserve my facial width and length, eye size and spacing, eyelids, nose bridge and nostrils, lip thickness and shape, jawline, hairline, hairstyle, natural skin tone, and natural age impression. Do not narrow, lengthen, sharpen, beautify, or standardize my face. Do not make my eyes smaller, nose thinner, lips thinner, or turn me into another person.",
    fullBodyViewInstructions[kind],
    "Use a fixed 9:16 vertical frame at 2160x3840. Center my body horizontally and keep a fixed camera distance. Show me from the complete top of my hair to the soles of both feet without cropping my hair, arms, legs, or feet. Leave about 8% clean white space above my hair and 7% clean white floor space below my feet; my full figure should occupy about 85% of the frame height.",
    "Keep my natural adult-female proportions: height impression about 172 cm, head-to-body ratio about 1:7.5, bust-waist-hip ratio about 84/60/88 cm, and shoulder width about 38 cm. Keep an elegant naturally long-legged proportion: from the floor to my crotch is about 54% of my full figure height, so my legs are visibly longer than my head and torso together. Keep my torso at a normal length and do not lower my hip line, shorten my legs, shrink my head, stretch my limbs, exaggerate my waist or hips, or alter my body structure.",
    "Keep me standing naturally with both arms hanging close to my sides. Keep my elbows, forearms, wrists, and fingers at realistic human proportions; my fingertips must end at the upper thigh and stay far above the knees. Keep both hands relaxed, legs naturally separated, and feet flat on the floor. Do not lengthen or stretch my arms, create unnaturally thin model arms, pose, walk, raise my hands, cross my legs, bend my body, or add exaggerated movement.",
    "When my face and eyes are visible, keep a calm alert attention that follows the head direction. Do not create vacant eyes, glassy staring, a posed smile, speaking mouth, exaggerated brow motion, or a forced catchlight. In a back view or when the face is not visible, do not turn my head to add expression information.",
    "Dress me only in a logo-free matte warm taupe (#8F8178) short sports tank and matching high-waisted fitted yoga shorts. Keep the color and matte fabric consistent. Add no jewelry, shoes, props, products, or other clothing.",
    "Use a seamless matte pure-white background with soft, even front-facing diffused white light and balanced brightness on both sides. Keep my full-body skin tone natural and consistent. Do not add a gradient, gray-blue background, warm or cool color cast, wall corner, horizon line, distinct cast shadow, rim light, strong side light, or blown highlights.",
    "Do not create a collage, contact sheet, grid, split screen, mirrored duplicate, multiple people, text, watermark, border, or decorative set.",
    extraPrompt.trim() ? `Apply my additional direction: ${extraPrompt.trim()}` : "",
  ].filter(Boolean).join("\n");
}

const cameraViewInstructions: Record<CameraCalibrationKind, string> = {
  camera_eye_level: "Place the camera at my eye level, square to me, with a natural 50 mm portrait perspective. Keep my head, shoulders, torso, hips, and legs facing the camera. Do not tilt the camera or distort my face or body.",
  camera_high_angle: "Place the camera only 10 to 15 degrees above my eye level, aimed gently downward with a natural 50 mm portrait perspective. Keep my head, shoulders, torso, hips, and legs naturally aligned. Do not make my head oversized, shorten my body, or create a dramatic top-down view.",
  camera_low_angle: "Place the camera only 10 degrees below my eye level, aimed gently upward with a natural 50 mm perspective. Keep my body upright with natural vertical lines. Do not create a dramatic low-angle view, oversized feet, stretched legs, stretched arms, or a distorted head.",
};

function buildCameraPrompt(kind: CameraCalibrationKind, extraPrompt: string) {
  const isFullBody = kind === "camera_low_angle";
  return [
    `Using the attached references, generate one photorealistic ${isFullBody ? "full-body" : "half-body"} image of me.`,
    "Use Reference image 1 as my only original face source. Use the remaining reference images only to preserve my same face, hair, body proportion, and natural posture. Do not change me into another person or beautify, narrow, lengthen, or standardize my facial features.",
    cameraViewInstructions[kind],
    isFullBody
      ? "Use a fixed 9:16 frame at 2160x3840. Center me horizontally and show the complete top of my hair through the soles of both feet. Leave about 8% clean white space above my hair and 7% below my feet. My full figure should occupy about 85% of the frame height."
      : "Use a fixed 3:4 frame at 2160x2880. Center me horizontally and show the complete top of my hair through the middle of my thighs, with both shoulders, arms, waist, hips, and upper legs fully visible. Leave balanced clean white margins; do not crop me into a head-and-shoulders portrait.",
    isFullBody
      ? "Keep my natural adult-female proportions: height impression about 172 cm, head-to-body ratio about 1:7.5, bust-waist-hip ratio about 84/60/88 cm, and shoulder width about 38 cm. Keep an elegant naturally long-legged proportion: from the floor to my crotch is about 54% of my full figure height, so my legs are visibly longer than my head and torso together. Keep my torso at a normal length and do not lower my hip line, shorten my legs, shrink my head, stretch my limbs, exaggerate my waist or hips, or alter my body structure."
      : "Keep my face, shoulder width, torso length, waist-to-hip ratio, and arm length natural and consistent with my reference images. Keep both arms relaxed at my sides and do not distort my shoulders, torso, hands, or hips.",
    "Keep a calm alert attention consistent with the camera angle. Do not freeze a vacant or glassy stare, pose an advertising smile, add speech mouth shapes, or force eye catchlights where the light direction does not support them.",
    "Wear only a logo-free matte warm taupe (#8F8178) short sports tank and matching high-waisted fitted yoga shorts. Add no jewelry, shoes, props, products, text, watermark, or decorative set.",
    "Use a seamless matte pure-white background with soft, even front-facing diffused white light and balanced brightness on both sides. Keep my skin tone natural and consistent. Do not add a gradient, color cast, wall corner, horizon line, distinct cast shadow, rim light, strong side light, or blown highlights.",
    "Do not create a collage, contact sheet, grid, split screen, mirrored duplicate, multiple people, border, or decorative set.",
    extraPrompt.trim() ? `Follow this additional direction: ${extraPrompt.trim()}` : "",
  ].filter(Boolean).join("\n");
}

type ExpressionCalibrationKind = Extract<IdentityGenerateKind,
  "expression_neutral" | "expression_smile" | "expression_bright_smile" | "expression_turn_back" | "expression_gesture" | "expression_walk"
>;

const expressionInstruction: Record<ExpressionCalibrationKind, string> = {
  expression_neutral: "Give me a clearly friendly opening expression: keep my lips fully closed in a gentle visible smile, with both mouth corners and cheeks softly lifted. Keep my eyes relaxed and welcoming. Do not show teeth, part my lips, raise my brows, or make this look like a speaking or surprised expression.",
  expression_smile: "Give me a distinctly enthusiastic sharing expression: show a broad genuine smile with a modest amount of upper teeth visible, noticeably lifted cheeks, and bright engaged eyes. Keep my lips open only enough to reveal the upper teeth. Do not use a closed-mouth smile, a neutral face, or an exaggerated advertising grin.",
  expression_bright_smile: "Give me a clearly focused explanation expression: do not smile. Keep a steady direct gaze, draw my brows gently toward the center without frowning, and part my lips naturally as if I am actively explaining one point. Keep the mouth opening small and realistic; do not show a surprised O mouth or visible teeth.",
  expression_turn_back: "Give me a clear key-point emphasis expression: keep my gaze direct, lift both brows with alert eyes, and open my mouth in a natural medium speaking shape as if stressing an important point. Make the mouth opening visibly larger than the focused explanation expression, while keeping my jaw, lips, teeth, and cheeks anatomically natural. Do not create a shout, smile, or theatrical surprise.",
  expression_gesture: "Give me a clear interactive questioning expression: raise my left eyebrow slightly higher than my right eyebrow, keep both eyes attentive, tilt my head only 3 to 5 degrees to my right, and part my lips into a small questioning shape. Keep the asymmetry visible but natural. Do not smile, open my mouth widely, turn my face away, or make a cartoonish look.",
  expression_walk: "Give me a clear restrained surprise reaction: raise both brows, visibly widen my eyes, and form a small rounded O with my lips. Keep my head upright and centered. Make this the only expression with a rounded O mouth; do not smile, show teeth, shout, or distort my nose, cheeks, chin, jawline, or lip shape.",
};

function buildExpressionPrompt(kind: ExpressionCalibrationKind, extraPrompt: string) {
  return [
    "Using Reference image 1, generate one photorealistic 3:4 face-and-shoulders portrait of me.",
    "Use Reference image 1 as my approved frontal face identity calibration. Preserve my facial width and length, eye size and spacing, eyelids, nose bridge and nostrils, lip thickness and shape, jawline, hairline, hairstyle, natural skin tone, and natural age impression. Change only the requested expression. Do not beautify, narrow, lengthen, sharpen, standardize, or turn me into another person.",
    "Use a fixed 3:4 portrait frame at 2160x2880. Place the camera at my eye level, perpendicular to my face. Keep my head upright and centered, both eyes level, both shoulders level, and my gaze directed at the lens. Frame me from the complete top of my hair to just below my collarbones. Show both shoulders completely with balanced white space on the left and right. Do not show my lower chest, waist, hands, or full arms.",
    expressionInstruction[kind],
    "Use a seamless matte pure-white background with soft even front-facing diffused light and balanced brightness on both sides. Keep my face, neck, and shoulders even in brightness and natural skin tone. Wear only the visible upper part of a logo-free matte warm taupe (#8F8178) sports tank. Add no jewelry, accessories, props, text, watermark, border, or decorative set.",
    "Keep my skin clean, naturally even, and realistic at normal portrait distance. Preserve only subtle natural skin texture and gentle tonal variation. Do not invent visible pores, blotchy patches, acne-like marks, harsh skin grain, over-sharpening, waxy smoothing, or artificial retouching. Keep natural hair strands, focused catchlights, and small natural facial asymmetry. Do not use beauty filters, heavy makeup, doll-like eyes, over-smoothed lips, warped teeth, extra teeth, visible tongue, distorted jaw, collage, contact sheet, split screen, mirrored duplicate, or multiple people.",
    extraPrompt.trim() ? `Also follow this additional direction: ${extraPrompt.trim()}` : "",
  ].filter(Boolean).join("\n");
}

function buildIdentityPrompt(kind: IdentityGenerateKind, extraPrompt: string, references: IdentityReference[]) {
  if (
    kind === "full_body_front"
    || kind === "full_body_left_45"
    || kind === "full_body_right_45"
    || kind === "full_body_side"
    || kind === "full_body_back"
  ) return buildFullBodyPrompt(kind, extraPrompt);
  if (kind === "camera_eye_level" || kind === "camera_high_angle" || kind === "camera_low_angle") {
    return buildCameraPrompt(kind, extraPrompt);
  }
  if (kind.startsWith("expression_")) {
    return buildExpressionPrompt(kind as ExpressionCalibrationKind, extraPrompt);
  }
  const config = kindConfig[kind];
  const framingInstruction = config.aspectRatio === "9:16"
    ? "Use one fixed 9:16 full-body calibration frame. Keep the person horizontally centered and at the same camera distance across every full-body calibration image. Leave a consistent 8% clean white margin above the top of her hair and a consistent 7% clean white floor margin below the soles of her bare feet. Her complete head-to-toe figure must occupy about 85% of the frame height. Keep both feet fully visible, never crop the feet, and do not change this framing for different left/right angles, camera angles, expressions, gestures, or walking poses."
    : "Use one fixed 3:4 portrait calibration frame. Keep the head horizontally centered, leave a consistent 10% clean white margin above the hair, and use the same head-and-shoulders crop across portrait calibration images.";
  const faceFrontCalibrationInstruction = kind === "face_front"
    ? "For this strict front-face calibration, set the camera exactly at eye level and perpendicular to the face. Keep head, nose bridge and chin on the vertical center line; head yaw, pitch and roll must be zero; keep both eyes level and both shoulders horizontal. Show both sides of the hairline, cheeks, jawline and facial outline clearly. Keep natural hair, but tuck it naturally behind the shoulders enough that no strand covers either eye, eyebrow, nose, lips, cheek, jawline or facial edge. Include the complete top of the hair with a consistent 10% white margin. Use a compact passport-style bust crop from the full top of the hair to just below the collarbones, around two finger widths into the upper chest. Keep both shoulders fully visible and no wider than 76% of the frame, with at least 12% clean white margin on both left and right sides. Only a small upper-arm edge may be visible. Do not crop sideways through the shoulders, and do not show lower chest, sports-bra underband, waist, abdomen, hands or full arms. This must not be a three-quarter view, tilted-head pose, fashion-beauty portrait, editorial pose, soft-focus portrait, or asymmetric shoulder pose."
    : "";
  const proportionInstruction = kind === "face_front"
    ? ""
    : "For this identity-pack calibration generation only, keep a fixed adult female model proportion: height impression 172 cm; bust, waist and hip 84/60/88 cm; shoulder width 38 cm; hip height about 86 cm; inseam about 81 cm; arm span about 172 cm; shoulder-to-fingertip about 67 cm. Keep natural long-leg visual proportion around half of total height, without distortion.";
  const visualStyleInstruction = kind === "face_front"
    ? "Neutral identity-calibration photography with real, even natural skin texture and controlled natural hair. Avoid plastic skin, porcelain skin, beauty filters, makeup enhancement, fashion-editorial styling, soft-focus portrait effects, changed face, changed body, high-key blown highlights, gray-blue white background, warm or cool color cast, patchy yellow or red skin, strong side light, rim light, hard shadows, oily highlights, and any collage, contact sheet, split-screen, multi-panel layout, or multiple-person composition."
    : "Casting-reference photography with real human skin texture and natural hair strands. Avoid plastic skin, porcelain skin, beauty filters, changed face, changed body, extreme thinness, extreme curves, cartoon style, high-key blown highlights, gray-blue white background, warm or cool color cast, patchy yellow or red skin, strong side light, rim light, hard shadows, oily highlights, and any collage or multi-panel layout.";
  const referenceUsageInstruction = kind === "face_front"
    ? "Do not copy the source image's clothing, local lighting, background, compression artifacts, or color casts into the new image."
    : "Use the attached references as identity anchors only. Do not copy their clothing, local lighting, background, compression artifacts, or color casts into the new image.";
  return [
    `Generate one clean reusable digital-person identity reference image: ${config.prompt}.`,
    "The attached reference images are my own identity references. Their roles and order are fixed below:",
    ...references.map(describeReferenceRole),
    referenceUsageInstruction,
    "Use a clean, neutral, non-emissive, seamless matte white background. Keep the background evenly white with no gradient, color cast, wall corners, visible horizon line, clutter, or distinct ground shadow.",
    "Light the person with soft, even, front-facing diffused white light and balanced fill from both sides. Keep the face, neck, arms, torso, and legs consistent in brightness and natural skin tone.",
    "The person wears only a fixed uniform matte warm taupe (#8F8178) short sports tank and matching high-waisted yoga fitted shorts. Keep this exact same neutral warm taupe color, matte fabric finish, and logo-free minimal styling across every identity calibration image. Include no jewelry, accessories, shoes, product, prop, text, watermark, or decorative set.",
    proportionInstruction,
    framingInstruction,
    faceFrontCalibrationInstruction,
    visualStyleInstruction,
    extraPrompt.trim() ? `Additional direction from me: ${extraPrompt.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const requestStartedAt = Date.now();
    const user = await requireUser(req);
    const body = await req.json();
    const packId = String(body.packId || "");
    const pack = await getIdentityPack(user.id, packId);
    if (!pack) return NextResponse.json({ error: "请先选择一个人物包。" }, { status: 400 });

    const incomingChannel = body.channel as {
      id?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      endpointPath?: string;
      requestTimeoutMs?: number;
    } | undefined;
    const channel = await resolveImageChannel(req, incomingChannel, incomingChannel?.id);
    if (!channel?.apiKey || !channel.baseUrl || !channel.model) {
      return NextResponse.json({ error: "缺少生图模型配置。" }, { status: 400 });
    }

    const requestedKind = String(body.kind || "face_front") as IdentityGenerateKind;
    const kind = kindConfig[requestedKind] ? requestedKind : "face_front";
    const config = kindConfig[kind];
    const approved = pack.references.filter((reference) => reference.status === "approved");
    const source = approved.find((reference) => reference.id === pack.sourceReferenceId) || approved.find((reference) => reference.group === "source");
    const approvedBase = approved.filter((reference) => reference.group === "base");
    const approvedFaceFront = approvedBase.find((reference) => reference.sourceKind === "face_front");
    const requestedReferenceIds = Array.isArray(body.referenceIds) ? body.referenceIds.map(String) : [];
    const requestedReferences = config.group === "expression"
      ? (approvedFaceFront ? [approvedFaceFront] : [])
      : requestedReferenceIds.length
        ? approved.filter((reference) => requestedReferenceIds.includes(reference.id))
        : config.group === "base"
          ? (source ? [source] : [])
          : approvedBase;
    const selected = (config.group === "expression" || config.group === "base"
      ? requestedReferences
      : [source, ...requestedReferences].filter((reference): reference is IdentityReference => Boolean(reference)))
      .filter((reference, index, all) => all.findIndex((item) => item.id === reference.id) === index)
      .sort((left, right) => referencePriority(left) - referencePriority(right));

    if (config.group === "expression" && !approvedFaceFront) {
      return NextResponse.json({ error: "请先通过一张人脸正面定型图；表情组只会使用这张图作为参考图 1。" }, { status: 400 });
    }
    if (config.group !== "base" && approvedBase.length === 0) {
      return NextResponse.json({ error: "请先生成并验收至少一张白底定型组图片，再生成镜头或表情口型校准图。" }, { status: 400 });
    }
    if (!selected.length) return NextResponse.json({ error: "没有可用的已通过身份来源图。" }, { status: 400 });

    const referenceImageUrls = await Promise.all(selected.map((reference) => prepareImageEditReferenceUrl(reference.url, { ownerId: user.id })));
    const fixedImageSizePreset = fixedIdentityImageSizePreset(kind);
    const dimensions = imageDimensionsForPreset(config.aspectRatio, fixedImageSizePreset);
    const requestedWidth = dimensions?.width;
    const requestedHeight = dimensions?.height;

    const provider = createProvider({
      name: "openai-seedance",
      apiKey: channel.apiKey,
      baseUrl: channel.baseUrl,
      timeout: channel.requestTimeoutMs,
      extra: {
        imageApiKey: channel.apiKey,
        imageBaseUrl: channel.baseUrl,
        imageEditPath: imageEditPathFromChannel(channel.endpointPath),
        imagePath: imageGenerationPathFromChannel(channel.endpointPath),
        debugLogPath: storagePaths.diagnostics("identity-pack", user.id, "image-debug.log"),
      },
      audit: {
        userId: user.id,
        callType: "image",
        providerKey: "openai-seedance",
        channelName: "identity-pack-image",
        model: channel.model,
        source: "identity-pack.generate",
      },
    });
    const result = await provider.generateImage({
      modelId: channel.model,
      mode: "image-to-image",
      prompt: buildIdentityPrompt(kind, String(body.extraPrompt || ""), selected),
      referenceImageUrls,
      width: requestedWidth,
      height: requestedHeight,
      count: 1,
      extra: {
        quality: "high",
      },
    });
    const imageUrl = result.imageUrls[0];
    if (!imageUrl) return NextResponse.json({ error: "生图接口未返回图片。" }, { status: 502 });
    const providerTiming = readImageTransportTiming(result.extra?.timing);
    const localSaveStartedAt = Date.now();
    const generationTiming: IdentityGenerationTiming = {
      ...providerTiming,
      totalMs: Math.max(0, localSaveStartedAt - requestStartedAt),
    };

    console.info("[identity-pack-generate] upstream image completed", {
      packId: pack.id,
      kind,
      resultCount: result.imageUrls.length,
      resultTransport: imageUrl.startsWith("data:") ? "b64_json" : "url",
    });
    const pending = await saveIdentityPendingResult({
      ownerId: user.id,
      packId: pack.id,
      kind,
      title: config.title,
      role: config.role,
      sourceKind: kind,
      group: config.group,
      aspectRatio: config.aspectRatio,
      requiredFor: ["人工验收通过后可手动选入项目、爆款复刻或画板工作流"],
      taskId: result.taskId,
      modelId: result.modelId,
      transport: imageUrl.startsWith("data:") ? "b64_json" : "url",
      payload: imageUrl,
      generationTiming,
    });
    let image: Awaited<ReturnType<typeof readIdentityImageBytes>>;
    try {
      image = await readIdentityImageBytes(pending.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown download error";
      await updateIdentityPendingResult(user.id, pending.id, { lastError: message });
      console.error("[identity-pack-generate] result download failed", {
        packId: pack.id,
        kind,
        pendingId: pending.id,
        message,
      });
      return NextResponse.json({
        pending: true,
        pendingId: pending.id,
        pendingResult: { ...summarizeIdentityPendingResult(pending), lastError: message },
        error: `模型已返回图片结果，但 3100 暂时无法下载。结果已保存在待处理区，可稍后继续下载。${message}`,
      }, { status: 202 });
    }

    try {
      const finalizedTiming: IdentityGenerationTiming = {
        ...generationTiming,
        localSaveMs: Math.max(0, Date.now() - localSaveStartedAt),
        totalMs: Math.max(0, Date.now() - requestStartedAt),
      };
      const finalized = await finalizeIdentityPendingResult({
        ownerId: user.id,
        ownerName: user.username,
        pendingId: pending.id,
        image,
        generationTiming: finalizedTiming,
        localSaveStartedAt,
        requestStartedAt,
      });
      console.info("[identity-pack-generate] local image saved", {
        packId: pack.id,
        kind,
        pendingId: pending.id,
        fileName: finalized.fileName,
        bytes: image.bytes.byteLength,
      });
      return NextResponse.json({
        pack: finalized.pack,
        reference: finalized.reference,
        imageUrl: finalized.reference.url,
        result: {
          taskId: result.taskId,
          modelId: result.modelId,
          imageCount: result.imageUrls.length,
        },
        fixedImageSizePreset,
        requestedWidth,
        requestedHeight,
        timing: finalized.reference.generationTiming,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown local save error";
      await updateIdentityPendingResult(user.id, pending.id, { lastError: message });
      console.error("[identity-pack-generate] local image write failed", {
        packId: pack.id,
        kind,
        pendingId: pending.id,
        message,
      });
      return NextResponse.json({
        pending: true,
        pendingId: pending.id,
        pendingResult: { ...summarizeIdentityPendingResult(pending), lastError: message },
        error: `图片已生成并保全，但写入人物包还未完成。可稍后继续下载。${message}`,
      }, { status: 202 });
    }
  } catch (error) {
    console.error("[identity-pack-generate] request failed", {
      message: error instanceof Error ? error.message : "unknown error",
      name: error instanceof Error ? error.name : "UnknownError",
    });
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message, code: error.code, provider: error.provider, statusCode: error.statusCode }, { status: error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502 });
    }
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "人物包生图失败" }, { status: 500 });
  }
}
