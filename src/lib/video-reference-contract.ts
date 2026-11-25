import type { BoardWorkflowNode } from "@/lib/board-workflows";
import {
  getBoardVideoProfile,
  type DirectVideoReplacementReferenceContract,
  type BoardVideoChannelCapabilities,
  type DirectVideoReplacementPromptVersion,
} from "@/lib/board-video-protocol";

export type VideoReferenceRole = "visual_base" | "product" | "face" | "model" | "scene";
export type DirectVideoReplacementReferenceRole = "reference_video" | "product" | "face" | "model" | "scene";

export type GrokReferencePackage = {
  visualBase: BoardWorkflowNode;
  product: BoardWorkflowNode;
  face: BoardWorkflowNode;
  model: BoardWorkflowNode;
  scene: BoardWorkflowNode;
  ordered: BoardWorkflowNode[];
};

export type GrokReferencePackageResult = {
  package?: GrokReferencePackage;
  missing: string[];
  invalid: string[];
  error?: string;
};

export const GROK_WORKFLOW_REFERENCE_IMAGE_COUNT = 5;
export const DIRECT_VIDEO_REPLACEMENT_IMAGE_COUNT = 4;

export type DirectVideoReplacementPackage = {
  referenceVideo: BoardWorkflowNode;
  product: BoardWorkflowNode;
  /** Required unless this exact product-front channel enables reference-video identity retention. */
  face?: BoardWorkflowNode;
  /** Present only for the legacy product-board + face + person contract. */
  model?: BoardWorkflowNode;
  scene?: BoardWorkflowNode;
  ordered: BoardWorkflowNode[];
};

export type DirectVideoReplacementPackageResult = {
  package?: DirectVideoReplacementPackage;
  missing: string[];
  invalid: string[];
  error?: string;
};

/** True when the selected upstream profile requires the board's five-role image package. */
export function usesVideoReferenceRolePackage(
  channelOrModel?: BoardVideoChannelCapabilities | string | null,
) {
  return (getBoardVideoProfile(channelOrModel)?.referenceImageCount ?? 0) > 1;
}

/** A channel gets this simplified workflow only when its saved contract supports 1 video + 4 images. */
export function usesDirectVideoReplacement(
  channelOrModel?: BoardVideoChannelCapabilities | string | null,
) {
  return Boolean(getBoardVideoProfile(channelOrModel)?.directVideoReplacement);
}

/** Selects the highest-priority references supported by the chosen video protocol. */
export function boardVideoReferenceNodes(
  referenceNodes: BoardWorkflowNode[],
  channelOrModel?: BoardVideoChannelCapabilities | string | null,
) {
  const profile = getBoardVideoProfile(channelOrModel);
  if (!profile) return [];
  if (profile.protocol === "grok" && profile.referenceField === "image_url") {
    return referenceNodes.filter(isVideoVisualBase).slice(0, profile.referenceImageCount);
  }
  if (usesVideoReferenceRolePackage(channelOrModel)) {
    return grokReferencePackageFromNodes(referenceNodes).package?.ordered ?? [];
  }
  return referenceNodes.slice(0, profile.referenceImageCount);
}

function roleOf(node?: BoardWorkflowNode) {
  return String(node?.meta?.assetRole || "");
}

export function isVideoVisualBase(node?: BoardWorkflowNode) {
  return Boolean(node && ["composite_image", "repaired_image"].includes(roleOf(node)) && (node.filePath || node.publicUrl));
}

export function isVideoProductReference(node?: BoardWorkflowNode) {
  return Boolean(node && ["product_image", "product_evidence_board"].includes(roleOf(node)) && (node.filePath || node.publicUrl));
}

export function isVideoFaceReference(node?: BoardWorkflowNode) {
  if (!node || !(node.filePath || node.publicUrl)) return false;
  return roleOf(node) === "face_front" || String(node.meta?.identityReferenceSourceKind || "") === "face_front";
}

export function isVideoModelReference(node?: BoardWorkflowNode) {
  return Boolean(node && ["outfit_front", "outfit_side", "outfit_back"].includes(roleOf(node)) && (node.filePath || node.publicUrl));
}

export function isVideoSceneReference(node?: BoardWorkflowNode) {
  return Boolean(node && roleOf(node) === "clean_scene" && (node.filePath || node.publicUrl));
}

export function isDirectVideoReplacementVideoReference(node?: BoardWorkflowNode) {
  if (!node || !(node.filePath || node.publicUrl)) return false;
  if (!["source_video", "video_clip"].includes(node.kind)) return false;
  return !["generated_video", "composed_video", "video_output_mismatch"].includes(roleOf(node));
}

export function isDirectVideoReplacementAudioReference(node?: BoardWorkflowNode) {
  return Boolean(node && node.kind === "audio" && (node.filePath || node.publicUrl));
}

export function isDirectVideoReplacementFaceReference(node?: BoardWorkflowNode) {
  if (!node) return false;
  if (isVideoFaceReference(node)) return true;
  const sourceKind = String(node.meta?.identityReferenceSourceKind || "");
  return roleOf(node) === "identity_image" && !sourceKind.startsWith("full_body_");
}

export function isDirectVideoReplacementModelReference(node?: BoardWorkflowNode) {
  if (isVideoModelReference(node)) return true;
  const sourceKind = String(node?.meta?.identityReferenceSourceKind || "");
  return Boolean(node && sourceKind.startsWith("full_body_"));
}

export function directVideoReplacementReferenceRole(
  node?: BoardWorkflowNode,
  referenceContract: DirectVideoReplacementReferenceContract = "product_board_face_model",
): DirectVideoReplacementReferenceRole | null {
  if (isDirectVideoReplacementVideoReference(node)) return "reference_video";
  if (isVideoProductReference(node)) {
    return referenceContract === "product_front_face" && roleOf(node) !== "product_image"
      ? null
      : "product";
  }
  if (isDirectVideoReplacementModelReference(node)) {
    return referenceContract === "product_front_face" ? null : "model";
  }
  if (isDirectVideoReplacementFaceReference(node)) return "face";
  if (isVideoSceneReference(node)) return "scene";
  return null;
}

/**
 * Resolves the five direct-replacement selections exactly as the node UI does.
 * A stored non-empty selection is authoritative; without one, use the newest
 * directly connected candidate for each responsibility, preferring a product
 * evidence board over a raw product image for the product responsibility.
 */
export function resolveDirectVideoReplacementReferenceIds(
  candidates: BoardWorkflowNode[],
  storedSelection?: unknown,
  options: { referenceContract?: DirectVideoReplacementReferenceContract } = {},
) {
  const referenceContract = options.referenceContract || "product_board_face_model";
  const supportedCandidates = candidates.filter((node) => (
    directVideoReplacementReferenceRole(node, referenceContract) !== null
  ));
  const candidateIds = new Set(supportedCandidates.map((node) => node.id));
  const storedIds = Array.isArray(storedSelection)
    ? storedSelection.filter((item): item is string => typeof item === "string" && candidateIds.has(item))
    : [];
  if (storedIds.length > 0) return Array.from(new Set(storedIds));

  const roleOrder: DirectVideoReplacementReferenceRole[] = referenceContract === "product_front_face"
    ? ["reference_video", "product", "face", "scene"]
    : ["reference_video", "product", "face", "model", "scene"];
  return roleOrder.map((role) => {
    const roleCandidates = supportedCandidates.filter((node) => (
      directVideoReplacementReferenceRole(node, referenceContract) === role
    ));
    // 默认优先最新商品多视图故事板；已保存的手动选择仍然具有最高优先级。
    const preferred = referenceContract === "product_board_face_model" && role === "product"
      ? roleCandidates.filter((node) => roleOf(node) === "product_evidence_board")
      : [];
    return (preferred.length > 0 ? preferred : roleCandidates).at(-1)?.id || "";
  }).filter(Boolean);
}

/** Validates the required direct-replacement assets and an optional scene reference. */
export function directVideoReplacementPackageFromNodes(
  nodes: BoardWorkflowNode[],
  options: {
    sceneOptional?: boolean;
    faceOptional?: boolean;
    referenceContract?: DirectVideoReplacementReferenceContract;
  } = {},
): DirectVideoReplacementPackageResult {
  const referenceContract = options.referenceContract || "product_board_face_model";
  const productFrontFaceContract = referenceContract === "product_front_face";
  const uniqueNodes = Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  const videos = uniqueNodes.filter(isDirectVideoReplacementVideoReference);
  const products = uniqueNodes.filter((node) => (
    productFrontFaceContract ? roleOf(node) === "product_image" && Boolean(node.filePath || node.publicUrl) : isVideoProductReference(node)
  ));
  const faces = uniqueNodes.filter(isDirectVideoReplacementFaceReference);
  const models = productFrontFaceContract ? [] : uniqueNodes.filter(isDirectVideoReplacementModelReference);
  const scenes = uniqueNodes.filter(isVideoSceneReference);
  const supportedIds = new Set([...videos, ...products, ...faces, ...models, ...scenes].map((node) => node.id));
  const unsupported = uniqueNodes.filter((node) => !supportedIds.has(node.id));
  const missing: string[] = [];
  const invalid: string[] = [];
  const collectRoleIssue = (items: BoardWorkflowNode[], label: string, required = true) => {
    if (required && items.length === 0) missing.push(`${label} 1 个`);
    if (items.length > 1) invalid.push(`${label}只能保留 1 个（当前 ${items.length} 个）`);
  };

  collectRoleIssue(videos, "参考视频");
  collectRoleIssue(products, productFrontFaceContract ? "商品正面图" : "商品图");
  collectRoleIssue(faces, "人脸图", !(productFrontFaceContract && options.faceOptional));
  if (!productFrontFaceContract) collectRoleIssue(models, "人物图");
  if (!options.sceneOptional) collectRoleIssue(scenes, "场景图");
  if (unsupported.length > 0) {
    invalid.push(`不支持的直连素材：${unsupported.map((node) => node.title || node.id).join("、")}`);
  }
  if (missing.length || invalid.length) {
    return { missing, invalid, error: [...missing.map((item) => `缺少 ${item}`), ...invalid.map((item) => `冲突 ${item}`)].join("；") };
  }
  return {
    missing,
    invalid,
    package: {
      referenceVideo: videos[0],
      product: products[0],
      face: faces[0],
      model: models[0],
      scene: scenes[0],
      ordered: [videos[0], products[0], ...(faces[0] ? [faces[0]] : []), ...(models[0] ? [models[0]] : []), ...(scenes[0] ? [scenes[0]] : [])],
    },
  };
}

export type DirectVideoReplacementPromptLanguage = "en" | "zh-CN";

const DIRECT_VIDEO_REPLACEMENT_PROMPT_EN = [
  "REFERENCE VIDEO is the sole authority for shot order, shot boundaries, first and last states, timing, camera movement, framing, screen placement, action, pacing, edit rhythm, dynamic lighting, color grade, depth of field, and lens texture.",
  "Recreate the video using the supplied replacements. Do not copy the reference video's person, product, background, visible text, or logo.",
  "Image 1 PRODUCT MULTI-VIEW EVIDENCE BOARD: this image is the sole authority for visible product design, material, color, details, labels, and branding. Read every in-image view header (FRONT, BACK, LEFT SIDE, RIGHT SIDE, SIDE, DETAIL) as mandatory. Each panel proves only its labelled visible view; never flip, mirror, or infer unseen construction. Match the evidenced product exactly; never alter, substitute, or infer unsupported product details.",
  "Image 2 FACE: face identity, hair, skin tone, and age.",
  "Image 3 PERSON: body, outfit fit, silhouette, and non-product styling.",
  "Conflict priority is PRODUCT, then FACE, then PERSON, then SCENE. The reference video controls time and camera only; it never overrides these four visual domains.",
  "Keep the reference video's camera, framing, screen placement, choreography, beat timing, shot boundaries, and overall composition. Preserve all visible hand-to-product contact, occlusion order, relative scale, and physical interaction. Make anatomy, fingers, contact, shadows, and perspective physically coherent.",
  "The supplied image crops never change the reference camera, framing, subject position, or action. Keep every replacement consistent across all shots; no identity drift, product drift, background drift, extra limbs, floating objects, or clipping.",
  "No extra shots, cuts, subjects, products, background redesign, inferred product details, or source-video visual leakage.",
];

const DIRECT_VIDEO_REPLACEMENT_PROMPT_ZH = [
  "【总原则】本任务是基于参考视频重新生成，不是复制源视频画面，也不是只在原视频上局部修补。参考视频只负责镜头顺序、切点、时序、运镜、构图、主体位置、动作、姿态、节奏、景别、动态光线变化、色彩处理、景深和镜头质感。参考视频绝不提供人物身份、商品、穿搭或背景的视觉事实，也不能覆盖下列替换图；未连接场景图时，参考视频背景只作为背景事实来源。",
  "【图 1：商品多视图故事板】图 1 始终是当前商品可见事实的唯一来源。所有可见商品必须完整替换为图 1 中的商品，严格保持已展示部分的结构、材质、颜色、纹理、细节、标签和品牌信息。必须逐格读取图内视角标题：正面 / FRONT、背面 / BACK、左侧 / LEFT SIDE、右侧 / RIGHT SIDE、侧面 / SIDE、细节 / DETAIL；标题是该格视角的唯一权威，每格只证明该视角已展示的商品结构。不得保留、混合、近似、借用或推断参考视频原商品的任何外观、结构或隐藏细节；禁止镜像或翻转画格来补足未展示结构。",
  "【图 2：脸部】图 2 是人物身份唯一且不可覆盖的来源。凡画面中出现人物面部或头部，必须将参考视频原人物的脸完整替换为图 2 中的人物。成片人物必须清晰可识别为图 2 的同一人，保持其脸型与五官比例、眼睛、眉毛、鼻子、嘴唇、下颌线、发际线、发型、肤色、表观年龄及可辨识特征。禁止保留、混合、近似或借用参考视频及其他参考图中的任何人脸、发型、肤色、年龄或身份特征。参考视频仅可提供表情、视线、口型节奏、头部运动、姿势和镜头；不得决定人物是谁。最终成片中不得出现参考视频原人物的人脸。",
  "【图 3：人物与非商品穿搭】图 3 是人物身体、体型比例、轮廓、非商品服装和非商品造型的唯一来源。必须以图 3 替换参考视频原人物的身体与非商品穿搭，同时保持参考视频中的动作、姿态和主体位置。图 3 不得覆盖图 2 的脸部身份，也不得覆盖图 1 的商品外观。",
  "【冲突优先级】商品优先于脸部；脸部优先于人物与非商品穿搭；已提供场景图时，场景图优先于参考视频背景。每张替换图只负责自己的视觉领域，任何一张都不得越权覆盖其他领域。参考视频只控制时间、镜头与动作；未连接场景图时，参考视频背景只负责背景事实，不得覆盖其他替换图的视觉领域。",
  "【镜头与动作锁定】逐镜保留参考视频的镜头顺序、切点、镜头运动、构图、主体位置、动作编排、手部接触、遮挡顺序、相对尺度和物理互动。首尾状态保留的是动作、姿态、构图和空间关系，不是源视频原人物、原商品或原背景。不得新增镜头、切点、人物、商品、背景设计、动作轮次或未出现的互动。",
  "【全片一致性与禁止项】各项替换结果必须贯穿全片保持一致：不得身份漂移、商品漂移、人物穿搭漂移或背景漂移。保持手部、手指、接触、遮挡、阴影、透视、比例和解剖结构真实一致。不得出现源视频原人物脸部、原商品、原背景、原文字、原字幕、原标志或其他视觉残留；不得出现额外肢体、融合人脸、浮动物体、错误遮挡、裁切穿帮或马赛克式替换。",
];

const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_EN = [
  "【GENERAL PRINCIPLE】This task regenerates the video from the reference video; it does not copy source frames or merely patch the original video. The reference video controls only shot order, cuts, timing, camera movement, framing, subject placement, action, pose, pacing, shot scale, dynamic lighting, color treatment, depth of field, lens feel, body pose, and non-product styling. It never supplies product or face-identity visual facts; when no scene image is connected, its background is only the source of background facts.",
  "【IMAGE 1: PRODUCT FRONT ORIGINAL】Image 1 is the sole authority for all visible current-product facts. Every visible product must be completely replaced by the product in Image 1, retaining its visibly evidenced construction, material, color, texture, details, labels, and brand information. Do not retain, mix, approximate, borrow, or infer any appearance, construction, or detail from the source product in the reference video. A back, side, interior, or hidden area not shown in Image 1 may only be a restrained, continuous derivation of Image 1's visible facts; never borrow its construction or appearance from the source product.",
  "【IMAGE 2: FACE】Image 2 is the sole, non-overridable authority for identity. Whenever a face or head appears, fully replace the source person's face with the person in Image 2. The finished person must be clearly recognizable as that same person, preserving face shape and feature proportions, eyes, brows, nose, lips, jawline, hairline, hairstyle, skin tone, apparent age, and recognizable traits. Do not retain, mix, approximate, or borrow any face, hairstyle, skin tone, age, or identity trait from the reference video or any other reference. The reference video may provide expression, gaze, lip-timing rhythm, head motion, pose, and camera only; it never decides who the person is. The finished video must not contain the reference video's original face.",
  "【CONFLICT PRIORITY】PRODUCT overrides FACE; when a scene image is connected, SCENE overrides the reference-video background. The reference video controls only time, camera, action, body pose, non-product styling, and—when no scene image is connected—the background. It never overrides product or face visual facts.",
  "【REFERENCE-VIDEO PLATFORM OVERLAY REMOVAL】The Douyin logo at the top left of the reference video, the Douyin account ID or account text, and any text or icon inside the search box are platform overlays. They are not scene, product, person, or background facts. Remove all three completely from the finished video. Do not copy, leave remnants, approximately redraw, or blur-cover them. Naturally reconstruct each original position from the adjacent real background so the image remains clean, with no text or icon.",
  "【CAMERA AND ACTION LOCK】Preserve the reference video's shot order, cuts, camera movement, framing, subject placement, action choreography, hand contact, occlusion order, relative scale, and physical interaction shot by shot. The first and last states preserve action, pose, framing, and spatial relationships—not the source face or source product. Do not add shots, cuts, people, products, background design, action cycles, or unseen interactions.",
  "【WHOLE-VIDEO CONSISTENCY AND PROHIBITIONS】The product from Image 1 and the identity from Image 2 must remain consistent throughout: no identity drift, product drift, source-product residue, or background drift. Keep hands, fingers, contact, occlusion, shadows, perspective, proportions, and anatomy physically coherent. Do not show the source face, source product, source text, source subtitles, source logos, or any other visual residue; do not create extra limbs, fused faces, floating objects, wrong occlusion, clipping artifacts, or mosaic-like replacement.",
];

/**
 * MKOSOR receives the product as its primary image and the face as a secondary
 * reference image alongside a person-containing reference video. Its identity
 * contract must therefore explicitly exclude hair/head appearance from the
 * video's motion authority. Do not reuse this wording for other protocols:
 * their reference-image priority and upstream semantics are independent.
 */
const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_EN_MIKOTO_SORA = [
  "【GENERAL PRINCIPLE】This task regenerates the video from the reference video; it does not copy source frames or merely patch the original video. The reference video is motion-only: it controls shot order, cuts, timing, camera movement, framing, subject placement, action choreography, pose, pacing, shot scale, dynamic lighting, color treatment, depth of field, lens feel, body pose, and non-product clothing. It never supplies product or head-identity visual facts, including face, head shape, hair, hairline, hair color, skin tone, apparent age, makeup, or identity. When no scene image is connected, its background is only the source of background facts.",
  "【IMAGE 1: PRODUCT FRONT ORIGINAL】Image 1 is the sole authority for all visible current-product facts. Every visible product must be completely replaced by the product in Image 1, retaining its visibly evidenced construction, material, color, texture, details, labels, and brand information. Do not retain, mix, approximate, borrow, or infer any appearance, construction, or detail from the source product in the reference video. A back, side, interior, or hidden area not shown in Image 1 may only be a restrained, continuous derivation of Image 1's visible facts; never borrow its construction or appearance from the source product.",
  "【IMAGE 2: FACE — HARD IDENTITY CONDITION】Image 2 is the sole, non-overridable identity condition, not a style suggestion. Whenever any face, head, hair, or hairline is visible, fully replace the source person's appearance with the person in Image 2. The finished person must be clearly recognizable as that same person, preserving face shape and feature proportions, eyes, brows, nose, lips, jawline, hairline, hairstyle, hair color, skin tone, apparent age, and recognizable traits. When a phone, hand, or other object occludes the face, preserve the physical occlusion only; every visible face/head/hair area must still follow Image 2. For an angle Image 2 does not directly show, derive conservatively from Image 2's identity geometry only, never from the source performer. Do not retain, mix, approximate, or borrow any face, head shape, hairstyle, hair color, skin tone, age, makeup, or identity trait from the reference video or any other reference. The reference video may provide expression, gaze, lip-timing rhythm, head motion, pose, and camera only; it never decides who the person is. The finished video must not contain the reference video's original face or hair identity.",
  "【ROLE BOUNDARIES】Image 1 and Image 2 govern separate domains: Image 1 governs only the current product; Image 2 governs the entire head and identity. Neither weakens the authority of the other. When a scene image is connected, SCENE overrides the reference-video background. The reference video controls only time, camera, action, body pose, non-product clothing, and—when no scene image is connected—the background. It never overrides Image 1 or Image 2.",
  "【REFERENCE-VIDEO PLATFORM OVERLAY REMOVAL】The Douyin logo at the top left of the reference video, the Douyin account ID or account text, and any text or icon inside the search box are platform overlays. They are not scene, product, person, or background facts. Remove all three completely from the finished video. Do not copy, leave remnants, approximately redraw, or blur-cover them. Naturally reconstruct each original position from the adjacent real background so the image remains clean, with no text or icon.",
  "【CAMERA AND ACTION LOCK】Preserve the reference video's shot order, cuts, camera movement, framing, subject placement, action choreography, hand contact, occlusion order, relative scale, and physical interaction shot by shot. Occlusion locks geometry only; it never transfers source facial details, head shape, hair, or identity. The first and last states preserve action, pose, framing, and spatial relationships—not the source face, source hair, or source product. Do not add shots, cuts, people, products, background design, action cycles, or unseen interactions.",
  "【WHOLE-VIDEO CONSISTENCY AND PROHIBITIONS】The product from Image 1 and the identity from Image 2 must remain consistent throughout: no identity drift, product drift, source-person appearance residue, source-product residue, or background drift. Keep hands, fingers, contact, occlusion, shadows, perspective, proportions, and anatomy physically coherent. Do not show the source face, source hair identity, source product, source text, source subtitles, source logos, or any other visual residue; do not create extra limbs, fused faces, floating objects, wrong occlusion, clipping artifacts, or mosaic-like replacement.",
];

const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_ZH = [
  "【总原则】本任务是基于参考视频重新生成，不是复制源视频画面，也不是只在原视频上局部修补。参考视频只负责镜头顺序、切点、时序、运镜、构图、主体位置、动作、姿态、节奏、景别、动态光线变化、色彩处理、景深、镜头质感、身体姿态与非商品穿搭。参考视频绝不提供商品或人物身份的视觉事实；未连接场景图时，参考视频背景只作为背景事实来源。",
  "【图 1：商品正面原图】图 1 是当前商品可见事实的唯一来源。画面中所有可见商品必须完整替换为图 1 的商品，并严格保持图 1 已可见的结构、材质、颜色、纹理、细节、标签和品牌信息。不得保留、混合、近似、借用或推断参考视频原商品的任何外观、结构或细节。图 1 未展示的背面、侧面、内部或隐藏结构，只能从图 1 已可见事实做克制且连续的衍生；绝不能从参考视频原商品借用结构或外观。",
  "【图 2：脸部】图 2 是人物身份唯一且不可覆盖的来源。凡画面中出现人物面部或头部，必须将参考视频原人物的脸完整替换为图 2 中的人物。成片人物必须清晰可识别为图 2 的同一人，保持其脸型与五官比例、眼睛、眉毛、鼻子、嘴唇、下颌线、发际线、发型、肤色、表观年龄及可辨识特征。禁止保留、混合、近似或借用参考视频及其他参考图中的任何人脸、发型、肤色、年龄或身份特征。参考视频仅可提供表情、视线、口型节奏、头部运动、姿势和镜头；不得决定人物是谁。最终成片中不得出现参考视频原人物的人脸。",
  "【冲突优先级】商品优先于脸部；已提供场景图时，场景图优先于参考视频背景。参考视频只控制时间、镜头、动作、身体姿态、非商品穿搭，以及未连接场景图时的背景；它绝不覆盖商品或脸部的视觉事实。",
  "【参考视频平台叠加层清除】参考视频左上角的抖音 Logo、抖音号或账号文字，以及搜索框内的文字或图标，均为平台叠加层，不属于场景、商品、人物或背景事实。成片中必须完全移除这三项，不得复制、残留、近似重绘或以模糊遮挡替代；原位置以相邻真实背景自然补全，保持干净、无文字、无图标。",
  "【镜头与动作锁定】逐镜保留参考视频的镜头顺序、切点、镜头运动、构图、主体位置、动作编排、手部接触、遮挡顺序、相对尺度和物理互动。首尾状态保留的是动作、姿态、构图和空间关系，不是源视频原人物脸部或原商品。不得新增镜头、切点、人物、商品、背景设计、动作轮次或未出现的互动。",
  "【全片一致性与禁止项】图 1 的商品与图 2 的人物身份必须贯穿全片保持一致：不得身份漂移、商品漂移、源商品残留或背景漂移。保持手部、手指、接触、遮挡、阴影、透视、比例和解剖结构真实一致。不得出现源视频原人物脸部、原商品、原文字、原字幕、原标志或其他视觉残留；不得出现额外肢体、融合人脸、浮动物体、错误遮挡、裁切穿帮或马赛克式替换。",
];

const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_REFERENCE_VIDEO_FACE_PROMPT_EN = [
  "【GENERAL PRINCIPLE】This task regenerates the video from the reference video; it does not copy source frames or merely patch the original video. The reference video controls shot order, cuts, timing, camera movement, framing, subject placement, action, pose, pacing, shot scale, dynamic lighting, color treatment, depth of field, lens feel, body pose, non-product styling and—because no face image is supplied—the person's identity. It never supplies product visual facts; when no scene image is connected, its background is only the source of background facts.",
  "【IMAGE 1: PRODUCT FRONT ORIGINAL】Image 1 is the sole authority for all visible current-product facts. Every visible product must be completely replaced by the product in Image 1, retaining its visibly evidenced construction, material, color, texture, details, labels, and brand information. Do not retain, mix, approximate, borrow, or infer any appearance, construction, or detail from the source product in the reference video. A back, side, interior, or hidden area not shown in Image 1 may only be a restrained, continuous derivation of Image 1's visible facts; never borrow its construction or appearance from the source product.",
  "【REFERENCE-VIDEO IDENTITY: NO FACE IMAGE】No face image is supplied. The person in the reference video is the sole identity authority. Preserve that same person's recognizable face shape, feature proportions, eyes, brows, nose, lips, jawline, hairline, hairstyle, hair color, skin tone, apparent age, gender presentation, and distinctive traits continuously across the entire video. Only make restrained, natural improvements to clarity, skin texture, and lighting consistency. Do not swap faces, turn the person into someone else, beautify or de-age them substantially, reshape facial features, alter hair, invent makeup or accessories, or introduce identity drift.",
  "【CONFLICT PRIORITY】PRODUCT overrides the reference-video person. When a scene image is connected, SCENE overrides the reference-video background. The reference video controls time, camera, action, body pose, non-product styling, the identity fallback defined above, and—when no scene image is connected—the background; it never overrides product visual facts.",
  "【REFERENCE-VIDEO PLATFORM OVERLAY REMOVAL】The Douyin logo at the top left of the reference video, the Douyin account ID or account text, and any text or icon inside the search box are platform overlays. They are not scene, product, person, or background facts. Remove all three completely from the finished video. Do not copy, leave remnants, approximately redraw, or blur-cover them. Naturally reconstruct each original position from the adjacent real background so the image remains clean, with no text or icon.",
  "【CAMERA AND ACTION LOCK】Preserve the reference video's shot order, cuts, camera movement, framing, subject placement, action choreography, hand contact, occlusion order, relative scale, and physical interaction shot by shot. The first and last states preserve action, pose, framing, spatial relationships, and the same reference-video person—not the source product. Do not add shots, cuts, people, products, background design, action cycles, or unseen interactions.",
  "【WHOLE-VIDEO CONSISTENCY AND PROHIBITIONS】The product from Image 1 and the reference-video person's identity must remain consistent throughout: no identity drift, product drift, source-product residue, or background drift. Keep hands, fingers, contact, occlusion, shadows, perspective, proportions, and anatomy physically coherent. Do not show source product, source text, source subtitles, source logos, or any other visual residue; do not create extra limbs, fused faces, floating objects, wrong occlusion, clipping artifacts, or mosaic-like replacement.",
];

const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_REFERENCE_VIDEO_FACE_PROMPT_ZH = [
  "【总原则】本任务是基于参考视频重新生成，不是复制源视频画面，也不是只在原视频上局部修补。参考视频负责镜头顺序、切点、时序、运镜、构图、主体位置、动作、姿态、节奏、景别、动态光线变化、色彩处理、景深、镜头质感、身体姿态与非商品穿搭；由于本次未提供人脸图，参考视频中的人物还负责人物身份。参考视频绝不提供商品视觉事实；未连接场景图时，参考视频背景只作为背景事实来源。",
  "【图 1：商品正面原图】图 1 是当前商品可见事实的唯一来源。画面中所有可见商品必须完整替换为图 1 的商品，并严格保持图 1 已可见的结构、材质、颜色、纹理、细节、标签和品牌信息。不得保留、混合、近似、借用或推断参考视频原商品的任何外观、结构或细节。图 1 未展示的背面、侧面、内部或隐藏结构，只能从图 1 已可见事实做克制且连续的衍生；绝不能从参考视频原商品借用结构或外观。",
  "【人物身份：未提供人脸图】本次未提供人脸图。参考视频中的人物是人物身份唯一来源，必须在全片保持为同一可辨识人物：保留其脸型、五官比例、眼睛、眉毛、鼻子、嘴唇、下颌线、发际线、发型、发色、肤色、表观年龄、性别呈现及可辨识特征。仅可做克制、自然的清晰度、肤质与光影一致性优化；不得换脸、变成另一位人物、大幅美颜或年轻化、重塑五官、改变发型发色、臆造妆容或配饰，也不得产生身份漂移。",
  "【冲突优先级】商品优先于参考视频人物；已提供场景图时，场景图优先于参考视频背景。参考视频只控制时间、镜头、动作、身体姿态、非商品穿搭、上述人物身份兜底，以及未连接场景图时的背景；它绝不覆盖商品视觉事实。",
  "【参考视频平台叠加层清除】参考视频左上角的抖音 Logo、抖音号或账号文字，以及搜索框内的文字或图标，均为平台叠加层，不属于场景、商品、人物或背景事实。成片中必须完全移除这三项，不得复制、残留、近似重绘或以模糊遮挡替代；原位置以相邻真实背景自然补全，保持干净、无文字、无图标。",
  "【镜头与动作锁定】逐镜保留参考视频的镜头顺序、切点、镜头运动、构图、主体位置、动作编排、手部接触、遮挡顺序、相对尺度和物理互动。首尾状态保留的是动作、姿态、构图、空间关系及同一位参考视频人物，不是源视频原商品。不得新增镜头、切点、人物、商品、背景设计、动作轮次或未出现的互动。",
  "【全片一致性与禁止项】图 1 的商品与参考视频人物身份必须贯穿全片保持一致：不得身份漂移、商品漂移、源商品残留或背景漂移。保持手部、手指、接触、遮挡、阴影、透视、比例和解剖结构真实一致。不得出现源视频原商品、原文字、原字幕、原标志或其他视觉残留；不得出现额外肢体、融合人脸、浮动物体、错误遮挡、裁切穿帮或马赛克式替换。",
];

// V1 remains the shipped baseline. V2 is the strict-template contract used by
// Direct-edit channels: only explicitly connected replacement domains may change.
const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_ZH_V2 = [
  "【核心任务与允许改动】编辑参考视频：以参考视频作为严格锁定的视频模板。只允许以下改动：用图 1 替换模特当前穿着的整件上衣；用图 2 替换人物的脸部、头部与身份；若连接场景图，则按场景图替换背景；清除下文指定的平台叠加层。除此之外，参考视频中的镜头顺序、切点、时序、运镜、构图、景别、主体位置、身体、动作、姿态、表情、视线、口型节奏、非商品穿搭、道具、物理互动、动态光线、色彩、景深和镜头质感必须保持不变。不得重新设计、重新演绎、扩写或改变未授权内容。",
  "【直接替换上衣】保持参考视频中除模特当前穿着的整件上衣以外的全部内容不变。只把模特当前穿着的整件上衣替换成图 1 商品图中的上衣。替换后的上衣必须严格使用图 1 中可见的款式、颜色、版型、领口、袖子、袖口、下摆、材质、纹理、条纹、印花、刺绣、Logo、文字和装饰。参考视频中模特原上衣上的 Logo、图案、文字、条纹、印花、刺绣、织纹、颜色、领口、袖口和其他装饰全部删除，不得复制、保留、混合或补到替换后的上衣上。图 1 未展示的细节，只能根据图 1 已展示的上衣自然延续，不得从参考视频中的原上衣补充。",
  "【图 2：人物身份】图 2 是人物脸部、头部与身份唯一且不可覆盖的来源。凡画面中出现人物的脸、头部、头发或发际线，必须替换为图 2 中的同一人，并保持其脸型、五官比例、眼睛、眉毛、鼻子、嘴唇、下颌线、发际线、发型、发色、肤色、表观年龄及可辨识特征。参考视频只提供原有表情、视线、口型节奏、头部运动、遮挡关系和姿态，不得提供或残留原人物的身份特征；遮挡只锁定几何关系，所有露出的脸部、头部和头发仍以图 2 为准。",
  "【职责边界】图 1 只负责整件上衣，图 2 只负责人物脸部、头部与身份；两者互不覆盖。若连接场景图，场景图只负责背景，不得改变人物、商品、镜头、构图、动作或剪辑节奏。参考视频负责所有未被已连接素材明确授权替换的内容。任何素材都不得越权改变其他职责域。",
  "【平台叠加层清除】仅清除参考视频左上角的抖音 Logo、抖音号或账号文字，以及搜索框内的文字或图标。它们不属于场景事实。不得复制、残留、近似重绘或以模糊遮挡；原位置须用相邻真实背景自然补全。除这些指定叠加层、原上衣内容及已授权替换领域外，不得擅自删除参考视频中的其他真实文字、标志或画面元素。",
  "【镜头、动作与物理关系锁定】逐镜保持参考视频的镜头顺序、切点、时序、镜头运动、构图、景别、主体位置、动作编排、表情与视线、手部接触、遮挡顺序、相对尺度和物理互动。替换后的上衣必须自然贴合原身体、姿态和动作，并保持真实的布料形变、褶皱、光影、透视及遮挡。不得新增镜头、切点、人物、商品、道具、动作轮次或未出现的互动。",
  "【全片一致性与禁止项】图 1 的上衣和图 2 的人物身份必须贯穿全片稳定一致，不得出现身份漂移、商品漂移、原人物身份残留、原上衣残留、错误文字或 Logo、额外肢体、融合人脸、浮动物体、错误遮挡、穿模、裁切穿帮或马赛克式替换。保持手部、手指、身体比例和解剖结构真实一致；不得把图 1 或图 2 当作首帧、场景图或新构图来源。",
];

const DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_REFERENCE_VIDEO_FACE_PROMPT_ZH_V2 = [
  "【素材绑定】编辑 @video1：只将模特当前穿着的整件上衣替换为 @image1 中的商品，其余画面全部保持参考视频原样。",
  "【参考视频锁定】@video1 是唯一的视频模板，保持其人物身份、脸部、头发、身体、动作、姿态、表情、视线、手部接触、遮挡关系、镜头顺序、切点、时序、运镜、构图、景别、背景、道具、光线、色彩、景深和画面质感。不得将 @image1 用作首帧、人物、场景或新构图来源。",
  "【商品替换】替换后的上衣必须准确还原 @image1 中可见的款式、颜色、版型、领口、袖子、袖口、下摆、材质、纹理、条纹、印花、刺绣、Logo、文字和装饰，并自然贴合原人物的身体、姿态与动作，保持真实的褶皱、光影、透视、接触和遮挡。完全移除模特原上衣的设计与细节，不得混合；商品图未展示的区域，只根据已展示结构自然延续。",
  "【清理与禁止项】清除参考视频左上角的抖音 Logo、抖音号或账号文字，以及搜索框内的文字或图标，并用相邻背景自然补全。不得新增或改变其他人物、商品、场景、镜头、动作或文字；不得出现原上衣残留、商品或人物漂移、错误 Logo、额外肢体、错误遮挡、穿模或马赛克式替换。",
];

function promptSecond(value: number) {
  const rounded = Math.max(0, Number(value.toFixed(2)));
  return String(rounded);
}

function directVideoReplacementTailExtension(
  language: DirectVideoReplacementPromptLanguage,
  generationSeconds: number,
  referenceVideoSeconds: number,
) {
  const outputEnd = Math.max(1, Number(generationSeconds) || 15);
  const referenceEnd = Math.max(0.1, Math.min(Number(referenceVideoSeconds) || 9, outputEnd));
  // A reference that already reaches the requested end needs no invented tail.
  if (outputEnd <= referenceEnd + 0.05) return [];
  const referenceSecond = promptSecond(referenceEnd);
  const outputSecond = promptSecond(outputEnd);
  if (language === "zh-CN") {
    return [
      `【参考视频结束后的片尾延展】本次成片总时长为 ${outputSecond} 秒，参考视频只提供前 ${referenceSecond} 秒的可观察动作、镜头和节奏证据。`,
      `第 ${referenceSecond} 秒至第 ${outputSecond} 秒必须从第 ${referenceSecond} 秒最后一个真实画面状态自然向后衍生：延续此前已经建立的镜头运动方向、构图、主体位置、人物朝向、姿态、手部接触、遮挡关系、商品展示、背景空间、背景物体、背景材质、纵深、环境尺度、光线、景深和动作节奏。若第 ${referenceSecond} 秒仍处于一个已开始的动作中，只完成这一个动作并自然减速收束；若第 ${referenceSecond} 秒已经处于稳定状态，则保持该状态做克制、连续、真实的微小变化，并在第 ${outputSecond} 秒稳定结束。`,
      `不得重复播放前 ${referenceSecond} 秒，不得回到起始状态，不得新增镜头、切点、景别变化、人物、商品、道具、场景、动作轮次、重新接触、松手后再次接触、文字、字幕、对白、口型、音乐或音效。`,
    ];
  }
  return [
    `【TAIL EXTENSION AFTER THE REFERENCE VIDEO】The finished video is ${outputSecond} seconds long. The reference video provides observable action, camera, and pacing evidence only for its first ${referenceSecond} seconds.`,
    `From second ${referenceSecond} through second ${outputSecond}, derive naturally from the last real state at second ${referenceSecond}: continue the established camera-motion direction, framing, subject placement, subject orientation, pose, hand contact, occlusion, product presentation, background space, background objects, background materials, depth, environmental scale, lighting, depth of field, and action rhythm. If an action is already underway at second ${referenceSecond}, complete only that action and ease it to a natural finish. If the state is already stable, preserve it with restrained, continuous, realistic micro-variation and end stably at second ${outputSecond}.`,
    `Do not replay the first ${referenceSecond} seconds, return to the opening state, or add shots, cuts, shot-size changes, people, products, props, scenes, action cycles, renewed contact, contact again after release, text, subtitles, dialogue, lip sync, music, or sound effects.`,
  ];
}

/** Add explicit reference aliases for direct-edit Seedance endpoints. */
export function bindDirectVideoReplacementMediaAliases(
  prompt: string,
  language: DirectVideoReplacementPromptLanguage = "en",
) {
  const normalized = String(prompt || "").trim();
  if (!normalized || normalized.includes("【素材绑定】") || normalized.includes("MATERIAL BINDING:")) {
    return normalized;
  }
  const binding = language === "zh-CN"
    ? "【素材绑定】@video1 是唯一参考视频和严格锁定的视频模板，负责镜头、切点、时序、运镜、构图、人物位置、动作、节奏，以及下文未被已连接素材明确授权替换的内容；@image1 只负责替换模特当前穿着的整件上衣，其余图片只按下文标明的职责生效。所有图片都不得作为首帧或新构图来源。"
    : "MATERIAL BINDING: @video1 is the sole reference video and controls shots, cuts, framing, subject placement, motion, pacing, and background. @image1 supplies only the replacement product; never use @image1 as a first frame, identity, scene, or new-composition source.";
  return `${binding}\n${normalized}`;
}

/** Prompt is fixed per channel: reference video governs motion; images govern replaced visual domains. */
export function buildDirectVideoReplacementPrompt(
  hasAudioReference = false,
  language: DirectVideoReplacementPromptLanguage = "en",
  hasSceneReference = true,
  referenceContract: DirectVideoReplacementReferenceContract = "product_board_face_model",
  hasFaceReference = true,
  faceOptional = false,
  generationSeconds = 15,
  referenceVideoSeconds = 9,
  mikotoSoraFaceHardLock = false,
  promptVersion: DirectVideoReplacementPromptVersion = "v1",
) {
  const isChinese = language === "zh-CN";
  const productFrontFaceContract = referenceContract === "product_front_face";
  const referenceVideoIdentityFallback = productFrontFaceContract && faceOptional && !hasFaceReference;
  const productFrontSceneImageNumber = referenceVideoIdentityFallback ? 2 : 3;
  const scenePrompt = hasSceneReference
    ? isChinese
      ? `【图 ${productFrontFaceContract ? productFrontSceneImageNumber : 4}：场景】图 ${productFrontFaceContract ? productFrontSceneImageNumber : 4} 是背景静态空间、物体、材质、纵深和尺度的唯一来源。必须以图 ${productFrontFaceContract ? productFrontSceneImageNumber : 4} 替换参考视频原背景；不得保留、混合或借用原视频的背景、物体、文字、标志或场景设计。图 ${productFrontFaceContract ? productFrontSceneImageNumber : 4} 不改变参考视频的镜头、构图、主体位置、动作和剪辑节奏。`
      : `Image ${productFrontFaceContract ? productFrontSceneImageNumber : 4} SCENE: background geometry, objects, materials, depth, and scale. Replace the reference video's background with Image ${productFrontFaceContract ? productFrontSceneImageNumber : 4}; do not preserve, mix, or borrow the source background, objects, visible text, logos, or scene design. Image ${productFrontFaceContract ? productFrontSceneImageNumber : 4} never changes the reference camera, framing, subject placement, action, or edit rhythm.`
    : isChinese
      ? "【场景图未连接】本次没有提供场景图。参考视频中的背景空间、背景物体、材质、纵深和环境尺度是唯一背景事实；必须完整延续参考视频背景，不得新增、重设计、替换、混合或臆造背景、物体、文字、标志或场景结构。"
      : "NO SCENE REFERENCE IMAGE IS SUPPLIED: use the reference video's background geometry, objects, materials, depth, and environment scale as the sole background authority. Preserve that background throughout; do not add, redesign, replace, mix, or infer background, objects, visible text, logos, or scene structure.";
  const useChineseV2 = promptVersion === "v2" && isChinese && productFrontFaceContract;
  const promptLines = productFrontFaceContract
    ? referenceVideoIdentityFallback
      ? (isChinese
        ? (useChineseV2 ? DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_REFERENCE_VIDEO_FACE_PROMPT_ZH_V2 : DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_REFERENCE_VIDEO_FACE_PROMPT_ZH)
        : DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_REFERENCE_VIDEO_FACE_PROMPT_EN)
      : (isChinese
        ? (useChineseV2 ? DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_ZH_V2 : DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_ZH)
        : (mikotoSoraFaceHardLock
          ? DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_EN_MIKOTO_SORA
          : DIRECT_VIDEO_REPLACEMENT_PRODUCT_FRONT_FACE_PROMPT_EN))
    : (isChinese ? DIRECT_VIDEO_REPLACEMENT_PROMPT_ZH : DIRECT_VIDEO_REPLACEMENT_PROMPT_EN);
  const sceneIndex = productFrontFaceContract ? (referenceVideoIdentityFallback ? 2 : 3) : (isChinese ? 4 : 5);
  const omitRedundantNoSceneLine = useChineseV2 && referenceVideoIdentityFallback && !hasSceneReference;
  return [
    ...promptLines.slice(0, sceneIndex),
    ...(omitRedundantNoSceneLine ? [] : [scenePrompt]),
    ...promptLines.slice(sceneIndex),
    hasAudioReference
      ? isChinese
        ? "【音频】参考音频是对白、声线、音乐、音效和时间点的唯一来源，不得新增、删除、改写或伪造。"
        : "REFERENCE AUDIO is the sole authority for dialogue, vocal delivery, music, sound effects, and their timing. Preserve it without adding, removing, rewriting, or inventing audio content."
      : isChinese
        ? "【音频】未接入参考音频，不得新增文字、字幕、对白、口型、配音、音乐或音效。"
        : "No new text, subtitles, dialogue, lip sync, vocals, music, or sound effects.",
    ...(isChinese || productFrontFaceContract
      ? directVideoReplacementTailExtension(language, generationSeconds, referenceVideoSeconds)
      : []),
  ].join("\n");
}

export function videoReferenceRole(node?: BoardWorkflowNode): VideoReferenceRole | null {
  if (isVideoVisualBase(node)) return "visual_base";
  if (isVideoProductReference(node)) return "product";
  if (isVideoFaceReference(node)) return "face";
  if (isVideoModelReference(node)) return "model";
  if (isVideoSceneReference(node)) return "scene";
  return null;
}

export function grokReferencePackageFromNodes(nodes: BoardWorkflowNode[]): GrokReferencePackageResult {
  const uniqueNodes = Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  const visualBases = uniqueNodes.filter(isVideoVisualBase);
  const products = uniqueNodes.filter(isVideoProductReference);
  const faces = uniqueNodes.filter(isVideoFaceReference);
  const models = uniqueNodes.filter(isVideoModelReference);
  const scenes = uniqueNodes.filter(isVideoSceneReference);
  const supportedIds = new Set([...visualBases, ...products, ...faces, ...models, ...scenes].map((node) => node.id));
  const unsupported = uniqueNodes.filter((node) => !supportedIds.has(node.id));

  const missing: string[] = [];
  const invalid: string[] = [];
  const collectRoleIssue = (items: BoardWorkflowNode[], label: string) => {
    if (items.length === 0) missing.push(`${label} 1 张`);
    if (items.length > 1) invalid.push(`${label}只能保留 1 张（当前 ${items.length} 张）`);
  };

  collectRoleIssue(visualBases, "合成主图或修复细节图");
  collectRoleIssue(products, "商品图");
  collectRoleIssue(faces, "人脸正面定型图");
  collectRoleIssue(models, "当前镜头模特图");
  collectRoleIssue(scenes, "场景空镜图");
  if (unsupported.length > 0) {
    invalid.push(`不支持的直连素材：${unsupported.map((node) => node.title || node.id).join("、")}。视频节点只接受合成/修复图、商品图、人脸正面图、当前镜头模特图和场景空镜图`);
  }

  if (missing.length > 0 || invalid.length > 0) {
    return {
      missing,
      invalid,
      error: [...missing.map((item) => `缺少：${item}`), ...invalid.map((item) => `冲突：${item}`)].join("；"),
    };
  }

  return {
    missing,
    invalid,
    package: {
      visualBase: visualBases[0],
      product: products[0],
      face: faces[0],
      model: models[0],
      scene: scenes[0],
      ordered: [visualBases[0], products[0], faces[0], models[0], scenes[0]],
    },
  };
}

export function buildVideoPromptWithReferenceResponsibilities(
  directorPrompt: string,
  referenceNodes: BoardWorkflowNode[],
  editorialTimingLock?: string,
) {
  const packageResult = referenceNodes.length === GROK_WORKFLOW_REFERENCE_IMAGE_COUNT
    ? grokReferencePackageFromNodes(referenceNodes)
    : null;
  if (![1, 4, GROK_WORKFLOW_REFERENCE_IMAGE_COUNT].includes(referenceNodes.length)
    || (packageResult && !packageResult.package)) {
    throw new Error(packageResult?.error || "当前视频任务的参考图数量不符合所选模型协议。");
  }
  const singleReference = referenceNodes.length === 1;
  const roleLines = referenceNodes.map((node, index) => {
    const role = videoReferenceRole(node);
    const hasProductEvidenceViewLabels = String(node.meta?.assetRole || "") === "product_evidence_board"
      && Array.isArray(node.meta?.productEvidenceViews)
      && node.meta.productEvidenceViews.length > 0;
    const responsibility = role === "visual_base"
      ? singleReference
        ? "SHOT BASE: sole visual authority for the approved person, product, scene, layout, and existing contact."
        : "SHOT BASE: residual composite continuity, silhouette, occlusion, and existing contact only."
      : role === "product"
        ? hasProductEvidenceViewLabels
          ? "PRODUCT MULTI-VIEW STORYBOARD: in-image view headers define front/back/side. Each panel proves only its labelled visible structure; never flip, mirror, or infer unseen construction."
          : "PRODUCT FACTS: sole authority for visible construction, material, color, trim, labels, and branding."
        : role === "face"
          ? "FACE IDENTITY: sole authority for face, hair, skin tone, and age; not expression or gaze."
          : role === "model"
            ? "MODEL/OUTFIT: sole authority for body, fit, drape, visibility, and non-product styling."
            : role === "scene"
              ? "SCENE: sole authority for static geometry, objects, materials, depth, and scale."
              : "ADDITIONAL VISUAL REFERENCE: use only relevant visible facts; do not invent hidden details.";
    return `Reference Image ${index + 1}: ${responsibility}`;
  });
  const contractPrompt = [
    "EXECUTION PRIORITY:",
    singleReference
      ? "Use the one SHOT BASE for all visible facts. DIRECTOR controls motion, performance changes, timing, and transition without redesigning that image."
      : `Use ${referenceNodes.length} images in order. Domain conflict order: PRODUCT FACTS → FACE IDENTITY → MODEL/OUTFIT → SCENE → SHOT BASE for residual composite continuity. DIRECTOR alone controls camera, framing, action, performance, light, timing, and transition. No source has authority outside its role.`,
    "VISUAL REFERENCE RESPONSIBILITIES:",
    ...roleLines,
    "PRODUCT ACTION: touch only evidenced product areas; never substitute body or styling, expose, or invent hidden structure.",
    editorialTimingLock || "",
    "DIRECTOR SHOT SPECIFICATION:",
    directorPrompt,
    "DIALOGUE: speak only quoted Mandarin lines.",
  ].join("\n");
  if (singleReference) return contractPrompt;
  return contractPrompt
    .replace(/^Use \d+ images in order[^\n]*/m, "Use ordered roles; DIRECTOR controls camera/action/performance/light/timing/transition; roles exclusive.")
    .replace(/^VISUAL REFERENCE RESPONSIBILITIES:\n?/m, "")
    .replace(/Reference Image (\d+): SHOT BASE: residual composite continuity, silhouette, occlusion, and existing contact only\./g, "Reference Image $1: SHOT BASE (continuity/contact).")
    .replace(/Reference Image (\d+): PRODUCT FACTS: sole authority for visible construction, material, color, trim, labels, and branding\./g, "Reference Image $1: PRODUCT FACTS (construction/material/color/brand).")
    .replace(/Reference Image (\d+): PRODUCT MULTI-VIEW STORYBOARD: in-image view headers define front\/back\/side\. Each panel proves only its labelled visible structure; never flip, mirror, or infer unseen construction\./g, "Reference Image $1: PRODUCT MULTI-VIEW (read in-image view headers; no flip/mirror/inference).")
    .replace(/Reference Image (\d+): FACE IDENTITY: sole authority for face, hair, skin tone, and age; not expression or gaze\./g, "Reference Image $1: FACE IDENTITY (face/skin/age).")
    .replace(/Reference Image (\d+): MODEL\/OUTFIT: sole authority for body, fit, drape, visibility, and non-product styling\./g, "Reference Image $1: MODEL/OUTFIT (body/fit/style).")
    .replace(/Reference Image (\d+): SCENE: sole authority for static geometry, objects, materials, depth, and scale\./g, "Reference Image $1: SCENE (geometry/objects/scale).")
    .replace(/^PRODUCT ACTION:.*$/m, "PRODUCT ACTION: touch only evidenced product areas.");
}
