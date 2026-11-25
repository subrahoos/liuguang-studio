import type { BoardWorkflowNode } from "@/lib/board-workflows";
import {
  IDENTITY_PERFORMANCE_BASELINE_VERSION,
  identityPerformanceBaselineText,
} from "@/lib/identity-performance";

export const BOARD_IMAGE_TASK_CONTRACT_VERSION = 6;
export const BOARD_IMAGE_TASKS = [
  "clean_scene",
  "product_white_background",
  "outfit_front",
  "outfit_side",
  "outfit_back",
  "composite_image",
  "repaired_image",
  "detail_product_replacement",
] as const;

export type BoardImageTask = (typeof BOARD_IMAGE_TASKS)[number];

export type CanonicalBoardImageTask = {
  task: BoardImageTask;
  title: string;
  description: string;
  orderedNodes: BoardWorkflowNode[];
  promptEnglish: string;
  promptMetadata: Record<string, unknown>;
};

const PERSON_REFERENCE_ROLES = new Set([
  "identity_image",
  "identity_auxiliary_asset",
  "face_front",
  "face_left",
  "face_right",
  "face_turnaround",
]);

function roleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

function uniqueNodes(nodes: BoardWorkflowNode[]) {
  return Array.from(new Map(nodes.map((node) => [node.id, node])).values());
}

function isPersonReference(node: BoardWorkflowNode) {
  return PERSON_REFERENCE_ROLES.has(roleOf(node));
}

function isFrontFaceReference(node: BoardWorkflowNode) {
  const sourceKind = String(node.meta?.identityReferenceSourceKind || "");
  const text = `${node.title || ""} ${node.description || ""}`.toLowerCase();
  return isPersonReference(node)
    && (
      roleOf(node) === "face_front"
      || sourceKind === "face_front"
      || /人脸正面|face.*front/.test(text)
    );
}

function productViewKind(node: BoardWorkflowNode) {
  const text = `${node.title || ""} ${node.description || ""} ${node.promptEnglish || ""}`.toLowerCase();
  if (/背面|后面|back|rear/.test(text)) return "back";
  if (/侧面|侧身|side|profile/.test(text)) return "side";
  if (/正面|前面|front/.test(text)) return "front";
  return "unspecified";
}

function productViewRank(node: BoardWorkflowNode) {
  const kind = productViewKind(node);
  if (kind === "front") return 0;
  if (kind === "back") return 1;
  if (kind === "side") return 2;
  return 3;
}

function sortProductNodes(nodes: BoardWorkflowNode[]) {
  return [...nodes].sort((a, b) => {
    const rank = productViewRank(a) - productViewRank(b);
    if (rank !== 0) return rank;
    return Date.parse(a.createdAt || "") - Date.parse(b.createdAt || "");
  });
}

function requireCount(items: BoardWorkflowNode[], label: string, min: number, max = min) {
  if (items.length < min) throw new Error(`缺少：${label}${min === 1 ? " 1 张" : `至少 ${min} 张`}`);
  if (items.length > max) throw new Error(`冲突：${label}最多 ${max} 张（当前 ${items.length} 张）`);
}

function identityPerformanceBaseline(nodes: BoardWorkflowNode[]) {
  const baselines = Array.from(new Set(
    nodes
      .map((node) => String(node.meta?.identityPerformanceBaseline || "").trim())
      .filter(Boolean),
  ));
  return baselines.length === 1 ? baselines[0] : identityPerformanceBaselineText;
}

function productReferenceLine(node: BoardWorkflowNode, index: number, productIndex: number) {
  const imageNumber = index + 1;
  const view = productViewKind(node);
  return productIndex === 0
    ? `Reference image ${imageNumber} is the primary product ${view} view and the sole authority for every visible product fact: category, construction, silhouette, neckline or collar, sleeves, seams, hem, trim, pattern, color, material, label, and branding.`
    : `Reference image ${imageNumber} is an additional ${view} view of the same product. Use it only to complete visible product facts missing from the primary view. Never merge the views into a new design or invent a hidden feature.`;
}

function identityReferenceLine(node: BoardWorkflowNode, index: number) {
  const imageNumber = index + 1;
  const sourceKind = String(node.meta?.identityReferenceSourceKind || "");
  if (isFrontFaceReference(node)) {
    return `Reference image ${imageNumber} is the frontal face identity authority. Preserve the same face shape, features, hair, hairline, natural skin tone, and age impression. Do not copy its calibration expression, gaze, mouth state, white background, or local lighting.`;
  }
  if (roleOf(node) === "identity_auxiliary_asset") {
    const kind = String(node.meta?.identityAuxiliaryKind || "");
    if (kind === "expression_sheet") {
      return `Reference image ${imageNumber} is a labelled expression board. Use it only for the same face and the visible expression, gaze, and mouth-shape range; never let it alter product, body, clothing, or background facts.`;
    }
    if (kind === "base_multiview_sheet") {
      return `Reference image ${imageNumber} is a labelled full-body multi-view identity board. Preserve only the visible same-person proportions and the requested viewing angle; do not infer numeric body measurements.`;
    }
    if (kind === "camera_pose_sheet") {
      return `Reference image ${imageNumber} is a labelled camera-and-pose identity board. Preserve only the visible same-person posture and apparent image-axis relationship; do not infer physical camera height, distance, or focal length.`;
    }
  }
  const view = sourceKind.replace(/^full_body_/, "").replaceAll("_", " ") || "available";
  return `Reference image ${imageNumber} is a ${view} identity reference. Preserve only the visible same-person face, hair, body proportions, limb relationships, and posture. Do not invent numeric measurements or copy clothing, background, or local lighting.`;
}

function canonicalReferenceOrder(task: BoardImageTask, inputNodes: BoardWorkflowNode[]) {
  const nodes = uniqueNodes(inputNodes);
  const products = sortProductNodes(nodes.filter((node) => roleOf(node) === "product_image"));
  const persons = nodes.filter(isPersonReference);
  const sourceFrames = nodes.filter((node) => roleOf(node) === "selected_scene_frame");
  const cleanScenes = nodes.filter((node) => roleOf(node) === "clean_scene");
  const outfits = nodes.filter((node) => ["outfit_front", "outfit_side", "outfit_back", "outfit_turnaround"].includes(roleOf(node)));
  const repairTargets = nodes.filter((node) => ["composite_image", "repaired_image"].includes(roleOf(node)));
  const detailTargets = nodes.filter((node) => roleOf(node) === "detail_reference_image");
  const whiteBackgroundProducts = nodes.filter((node) => roleOf(node) === "product_white_background");

  if (task === "clean_scene") {
    requireCount(sourceFrames, "当前镜头人工选帧", 1);
    if (nodes.length !== 1) throw new Error("提取场景空镜只接受当前镜头人工选帧 1 张。");
    return sourceFrames;
  }
  if (task === "product_white_background") {
    requireCount(products, "商品图", 1, 3);
    if (products.length !== nodes.length) throw new Error("商品白底图只接受商品图 1–3 张。");
    if (products.length > 1) {
      const groupIds = products.map((node) => String(node.meta?.productGroupId || "").trim());
      if (groupIds.some((groupId) => !groupId) || new Set(groupIds).size !== 1) {
        throw new Error("商品白底图使用多张商品图时，这些图片必须来自同一个当前商品组。");
      }
    }
    return products;
  }
  if (["outfit_front", "outfit_side", "outfit_back"].includes(task)) {
    requireCount(products, "商品图", 1, 3);
    requireCount(persons, "人物身份参考图", 1, 5);
    if (products.length + persons.length !== nodes.length) {
      throw new Error("穿搭图只接受商品图与人物身份参考图。");
    }
    return [...products, ...persons];
  }
  if (task === "composite_image") {
    requireCount(products, "商品图", 1, 3);
    const faces = persons.filter(isFrontFaceReference);
    requireCount(faces, "人脸正面定型图", 1);
    requireCount(outfits, "当前镜头穿搭图", 1);
    requireCount(cleanScenes, "场景空镜", 1);
    requireCount(sourceFrames, "当前镜头人工选帧", 1);
    const ordered = uniqueNodes([...products, faces[0], outfits[0], cleanScenes[0], sourceFrames[0]]);
    if (ordered.length !== nodes.length) {
      throw new Error("合成主图只接受商品图、人脸正面定型图、当前镜头穿搭图、场景空镜和当前镜头人工选帧。");
    }
    return ordered;
  }
  if (task === "detail_product_replacement") {
    requireCount(whiteBackgroundProducts, "产品白底图", 1);
    requireCount(detailTargets, "详情图批次项", 1);
    const faces = persons.filter(isFrontFaceReference);
    requireCount(faces, "人脸正面图", 0, 1);
    if (persons.length !== faces.length) {
      throw new Error("详情图换脸只接受人脸正面图，其他人物身份素材不会作为换脸依据。");
    }
    if (nodes.length !== 2 + faces.length) {
      throw new Error("详情图换装只接受 1 张产品白底图、可选 1 张人脸正面图和 1 张详情图批次项。");
    }
    return faces.length
      ? [whiteBackgroundProducts[0], faces[0], detailTargets[0]]
      : [whiteBackgroundProducts[0], detailTargets[0]];
  }
  requireCount(repairTargets, "合成主图或已有修复图", 1);
  if (nodes.length !== 1) throw new Error("修复细节只接受 1 张合成主图或已有修复图。");
  return repairTargets;
}

function assertRepairInstruction(value: string) {
  const instruction = value.trim();
  if (!instruction) {
    throw new Error("修复细节必须先填写英文“区域 + 可见缺陷 + 目标状态”，服务端不会猜修复位置。");
  }
  if (/[\u3400-\u9fff]/.test(instruction)) {
    throw new Error("修复目标将直接进入英文执行 Prompt，请使用英文填写区域、可见缺陷和目标状态。");
  }
  if (instruction.length < 12 || instruction.length > 500) {
    throw new Error("修复目标需为 12–500 个字符，并明确区域、可见缺陷和目标状态。");
  }
  return instruction;
}

function outfitPrompt(task: BoardImageTask, nodes: BoardWorkflowNode[]) {
  const products = nodes.filter((node) => roleOf(node) === "product_image");
  const persons = nodes.filter(isPersonReference);
  const angle = task === "outfit_front"
    ? {
        name: "front full-body",
        pose: "Stand in a strict true front view at zero degrees with head, torso, hips, legs, and feet facing the camera together.",
        visibility: "Keep both arms relaxed with enough separation to reveal the product front, sleeves, side seams, hem, and visible trim.",
      }
    : task === "outfit_side"
      ? {
          name: "left-side full-body",
          pose: "Stand in a strict 90-degree left-side profile with head, torso, hips, legs, and feet turned together; do not drift toward a front or mirrored view.",
          visibility: "Keep arms and hands clear enough to reveal the product side silhouette, sleeve, side seam, hem, and visible trim.",
        }
      : {
          name: "back full-body",
          pose: "Stand in a strict straight-back view with head, torso, hips, legs, and feet facing away; do not turn the head to reveal the face.",
          visibility: "Keep arms and hands clear enough to reveal the product back, back seams, hem, and visible trim.",
        };
  const roles = [
    ...products.map((node, index) => productReferenceLine(node, index, index)),
    ...persons.map((node, index) => identityReferenceLine(node, products.length + index)),
  ];
  return [
    `Generate one photorealistic ${angle.name} outfit image of the supplied person on a seamless pure-white background.`,
    "REFERENCE RESPONSIBILITIES:",
    ...roles,
    `POSE: ${angle.pose}`,
    "FRAME: Show the complete body from the full top of the hair to both soles. Do not crop hair, arms, hands, legs, or feet. Preserve the visible body proportions from the identity references without converting them into numeric measurements.",
    `PRODUCT VISIBILITY: ${angle.visibility}`,
    "NON-PRODUCT STYLING: Do not invent a coordinated look, branded garment, heel type, accessory, or extra product piece. Add only minimal plain neutral coverage where anatomy would otherwise be exposed, keep it visually subordinate, and never let it alter, tuck, cover, shorten, or replace the supplied product.",
    "PERSON PERFORMANCE BASELINE:",
    identityPerformanceBaseline(persons),
    task === "outfit_back"
      ? "Do not add facial performance to the strict back view."
      : "Keep the face alert and relaxed with natural attention appropriate to the requested view; do not force a posed smile, speaking mouth, frontal catchlight, or direct-lens gaze when that is not visible.",
    "Use soft even neutral illumination, natural skin and hair detail, readable product texture, and one subtle contact shadow. Do not add a wall corner, prop, color cast, hard shadow, blown highlight, text, watermark, platform UI, collage, duplicate person, extra limb, or product redesign.",
  ].join("\n");
}

function productWhiteBackgroundPrompt(nodes: BoardWorkflowNode[]) {
  const products = nodes.filter((node) => roleOf(node) === "product_image");
  return [
    "Create one product-only ecommerce catalogue image from the supplied references.",
    "REFERENCE AUTHORITY:",
    ...products.map((node, index) => index === 0
      ? `Reference image ${index + 1} is the primary product ${productViewKind(node)} view and determines the output viewing direction.`
      : `Reference image ${index + 1} is an additional ${productViewKind(node)} view of the same product and may only clarify visible construction that is unclear in the primary image.`),
    "Never combine different views into a new design or infer an unseen product feature.",
    "PRODUCT PRESERVATION: Accurately preserve every visible product fact, including category, construction, neckline or collar, shoulder line, sleeves, cuffs, seams, closure, pockets, hem, trim, color, material, texture, pattern, print, embroidery, labels, product text, Logo, and branding. Do not add, remove, simplify, or redesign any visible product feature.",
    "WORN-GARMENT EXTRACTION: If the product is worn by a model, remove the person, face, hair, skin, hands, jewellery, bottoms, shoes, styling, and source background. The visible garment boundary, construction, and fabric remain valid product evidence, but the model's identity, anatomy, and body proportions do not define the garment design.",
    "OCCLUSION RULE: Reconstruct only garment areas directly covered by hair, hands, or the body, using continuous edges, fabric, color, and patterns visible nearby or in another supplied view. Do not invent hidden seams, closures, pockets, prints, or decorations.",
    "PRODUCT-ONLY OUTPUT: Show one complete, isolated instance of the product, centered and fully visible in the straightforward view established by the primary reference. Do not crop, mirror, duplicate, fold, distort, or change the viewing direction. Do not include a person, mannequin, hanger, accessory, packaging, prop, skin, or other clothing.",
    "BACKGROUND AND TEXT: Use a plain, featureless, evenly lit white background with no floor, horizon, studio scene, shadow, reflection, gradient, vignette, hotspot, or color cast. Remove only non-product subtitles, watermarks, account text, and platform interface elements. Preserve all text, labels, prints, Logos, and branding that physically belong to the product.",
  ].join("\n");
}

export function buildCanonicalBoardImageTask(input: {
  task: BoardImageTask;
  referenceNodes: BoardWorkflowNode[];
  repairInstruction?: string;
}): CanonicalBoardImageTask {
  if (!BOARD_IMAGE_TASKS.includes(input.task)) throw new Error("当前 image-2 任务角色不受支持。");
  const orderedNodes = canonicalReferenceOrder(input.task, input.referenceNodes);
  const promptMetadata: Record<string, unknown> = {
    imageTaskContractVersion: BOARD_IMAGE_TASK_CONTRACT_VERSION,
    identityPerformanceBaselineVersion: IDENTITY_PERFORMANCE_BASELINE_VERSION,
    serverOwnedPrompt: true,
  };

  if (input.task === "clean_scene") {
    return {
      task: input.task,
      title: "场景空镜修复图",
      description: "基于当前镜头人工选帧去除原人物，并按可见证据补全被遮挡背景。",
      orderedNodes,
      promptMetadata,
      promptEnglish: [
        "Using Reference image 1, generate one empty background plate for the current shot.",
        "Reference image 1 controls only the visible location, crop, image-axis relationship, perspective appearance, environment layout, props, light, exposure, color, depth, and texture.",
        "Remove the original person and all person-bound hair, limbs, hands, phone, clothing, accessories, and contact shadows that obscure the scene.",
        "Rebuild only the obscured area by continuing visible surface directions, object boundaries, material texture, reflections, depth layers, exposure, color, and shadow relationships from the surrounding evidence.",
        "Preserve the original aspect ratio, crop, object geometry, visible wear, minor irregularity, foreground, midground, background, and atmosphere. Do not infer or state a physical camera height, shooting distance, device, focal length, or real light position from this still.",
        "Remove subtitles, platform UI, watermarks, account text, and unrelated text. Do not add a person, silhouette, human residue, new prop, repeated texture, blurred patch, warped geometry, or melted detail.",
      ].join("\n"),
    };
  }

  if (input.task === "product_white_background") {
    return {
      task: input.task,
      title: "商品白底图",
      description: "基于直接连入的商品图生成单张无人物、无环境、无阴影的纯白底商品图；服装穿着参考会自动去除模特。",
      orderedNodes,
      promptMetadata,
      promptEnglish: productWhiteBackgroundPrompt(orderedNodes),
    };
  }

  if (["outfit_front", "outfit_side", "outfit_back"].includes(input.task)) {
    const title = input.task === "outfit_front"
      ? "全身穿搭正面白底图"
      : input.task === "outfit_side"
        ? "全身穿搭侧面白底图"
        : "全身穿搭背面白底图";
    return {
      task: input.task,
      title,
      description: "按服务端固定职责合同生成单张穿搭角度图。",
      orderedNodes,
      promptMetadata,
      promptEnglish: outfitPrompt(input.task, orderedNodes),
    };
  }

  if (input.task === "composite_image") {
    const products = orderedNodes.filter((node) => roleOf(node) === "product_image");
    const face = orderedNodes.find(isFrontFaceReference)!;
    const outfit = orderedNodes.find((node) => ["outfit_front", "outfit_side", "outfit_back", "outfit_turnaround"].includes(roleOf(node)))!;
    const scene = orderedNodes.find((node) => roleOf(node) === "clean_scene")!;
    const shot = orderedNodes.find((node) => roleOf(node) === "selected_scene_frame")!;
    const faceIndex = orderedNodes.indexOf(face);
    const outfitIndex = orderedNodes.indexOf(outfit);
    const sceneIndex = orderedNodes.indexOf(scene);
    const shotIndex = orderedNodes.indexOf(shot);
    const roles = [
      ...products.map((node, index) => productReferenceLine(node, index, index)),
      `Reference image ${faceIndex + 1} is the sole face-identity authority. It does not control expression, gaze, mouth, pose, clothing, background, or shot lighting.`,
      `Reference image ${outfitIndex + 1} controls only visible body continuity, on-body fit and drape, product visibility, and non-product styling. Product construction still comes only from the product references.`,
      `Reference image ${sceneIndex + 1} is the sole authority for static background geometry, objects, materials, depth layers, and environment scale. It does not control the person's identity, product facts, pose, or performance.`,
      `Reference image ${shotIndex + 1} controls only observable shot execution: crop, framing, figure scale and placement, apparent image axis, perspective outcome, body direction, pose, hand relationship, gaze, mouth state, expression function, visible light, exposure, depth of field, atmosphere, and color. The source person and source product are never identity or product evidence.`,
    ];
    return {
      task: input.task,
      title: "场景人物商品合成主图",
      description: "按当前镜头可观察证据替换人物与商品，并保持五类参考职责不重叠。",
      orderedNodes,
      promptMetadata,
      promptEnglish: [
        "Generate one photorealistic main image for the current shot by replacing only the source person and source product with the supplied person and supplied product.",
        "REFERENCE RESPONSIBILITIES:",
        ...roles,
        `CONFLICT PRIORITY: product facts → Reference images ${products.map((node) => orderedNodes.indexOf(node) + 1).join(", ")} only; face identity → Reference image ${faceIndex + 1} only; body continuity, fit, and non-product styling → Reference image ${outfitIndex + 1} only; static background geometry → Reference image ${sceneIndex + 1} only; observable framing, placement, pose, performance, visible light, exposure, depth, and color → Reference image ${shotIndex + 1} only. A reference loses authority outside its listed domain.`,
        `Match the visible body scale, crop, frame occupancy, margins, anchor point, body direction, head turn, weight distribution, hands, product-proof contact, gaze, eye state, mouth state, and functional expression from Reference image ${shotIndex + 1}. Do not infer physical camera height, distance, device, focal length, or numeric body measurements.`,
        "Preserve product construction, color, material, label, and branding only when visible in the supplied product references. Never copy the source product, source styling, source face, source body shape, or an unseen product feature.",
        "Integrate the supplied person into the clean scene with coherent visible perspective, focus, edge sharpness, cast/contact shadow, reflections, occlusion, depth, environment scale, exposure, and color. Preserve every already-correct scene object.",
        "Keep hands anatomically complete and the intended product-proof area readable. Output one image only with no caption, watermark, platform UI, duplicate person, extra product, or non-product logo.",
      ].join("\n"),
    };
  }

  if (input.task === "detail_product_replacement") {
    const product = orderedNodes.find((node) => roleOf(node) === "product_white_background")!;
    const face = orderedNodes.find(isFrontFaceReference);
    const detail = orderedNodes.find((node) => roleOf(node) === "detail_reference_image")!;
    const productIndex = orderedNodes.indexOf(product) + 1;
    const faceIndex = face ? orderedNodes.indexOf(face) + 1 : 0;
    const detailIndex = orderedNodes.indexOf(detail) + 1;
    if (face) {
      return {
        task: input.task,
        title: "详情图换装＋换脸",
        description: "保留详情图的发型、身材、动作、表情、构图和场景，只替换商品与人物面部身份。",
        orderedNodes,
        promptMetadata: {
          ...promptMetadata,
          batchItem: true,
          replacementMode: "product_and_face",
          preserveDetailTypography: false,
        },
        promptEnglish: [
          "Generate one photorealistic ecommerce detail image by changing only the original garment or product and the model's facial identity in the target detail image.",
          `Reference image ${productIndex} is the sole product authority. Use it only for the supplied product's visible category, construction, silhouette, proportions, neckline or collar, sleeves, seams, hem, trim, pattern, color, material, label, and branding. Never copy the original product from the target image.`,
          `Reference image ${faceIndex} is the sole facial-identity authority. Preserve only its face shape, facial features, natural skin tone, and age impression. Do not copy its expression, gaze, mouth state, head angle, hairstyle, hairline styling, body, clothing, background, or local lighting.`,
          `Reference image ${detailIndex} is the sole target-composition and performance authority. Preserve its hairstyle and hair silhouette, body proportions, pose, hands, facial expression, gaze, mouth state, head angle, crop, subject placement, background, props, lighting, perspective, depth, color grade, and overall ecommerce layout.`,
          "Replace the target image's original product everywhere it is visible with the supplied product, and replace only the visible facial identity with the supplied face. Adapt the supplied facial identity naturally to the target head angle, expression, gaze, mouth state, lighting, skin transition, focus, and occlusion.",
          "Keep the supplied product structurally faithful and naturally fitted to the existing body. Preserve coherent folds, occlusion, contact shadows, highlights, neck transition, ears, and hair overlap.",
          "Do not change the target hairstyle, body shape, pose, hands, expression, gaze, framing, scene, graphic layout, or add unsupported accessories. Do not transfer clothing, background, pose, or styling from the face reference.",
          "Preserve the target image's visible graphic layout and text regions as much as possible, but do not invent, rewrite, or add text. Output one image only with no watermark, platform UI, collage, split screen, duplicate person, extra limbs, malformed hands, or product redesign.",
        ].join("\n"),
      };
    }
    return {
      task: input.task,
      title: "详情图换装",
      description: "保留详情图中的模特、构图、背景和画幅，只替换原商品为选定的产品白底图。",
      orderedNodes,
      promptMetadata: {
        ...promptMetadata,
        batchItem: true,
        replacementMode: "product_only",
        preserveDetailTypography: false,
      },
      promptEnglish: [
        "Generate one photorealistic ecommerce detail image by replacing only the original garment or product worn or shown in the target detail image.",
        `Reference image ${productIndex} is the sole product authority. Use it only for the supplied product's visible category, construction, silhouette, proportions, neckline or collar, sleeves, seams, hem, trim, pattern, color, material, label, and branding. Do not copy any original product from the target image.`,
        `Reference image ${detailIndex} is the sole target-composition authority. Preserve its model identity, body proportions, pose, hands, facial expression, gaze, crop, subject placement, background, props, lighting, perspective, depth, color grade, and overall ecommerce layout.`,
        "Replace the target image's original product everywhere it is visible with the supplied product. Keep the supplied product structurally faithful, naturally fitted to the existing model, and consistent across visible folds, occlusion, contact shadows, and highlights.",
        "Do not replace the model, change the scene, recenter the frame, alter the crop, add a second product, invent hidden product details, or add unsupported accessories.",
        "Preserve the target image's visible graphic layout and text regions as much as possible, but do not invent, rewrite, or add text. Output one image only with no watermark, platform UI, collage, split screen, duplicate person, extra limbs, malformed hands, or product redesign.",
      ].join("\n"),
    };
  }

  const repairInstruction = assertRepairInstruction(String(input.repairInstruction || ""));
  return {
    task: input.task,
    title: "细节修复图",
    description: "只修复人工明确指定的区域和可见缺陷，其余画面保持不变。",
    orderedNodes,
    promptMetadata: {
      ...promptMetadata,
      repairInstruction,
      preserveExistingPerformance: true,
    },
    promptEnglish: [
      "Using Reference image 1, create one repaired version of the provided image.",
      "Reference image 1 is the only repair target and the authority for the complete existing image.",
      `APPROVED REPAIR TARGET: ${repairInstruction}`,
      "Change only the named region and only the named visible defect. Keep every unlisted pixel region semantically unchanged, including identity, product construction and color, clothing, expression, gaze, mouth state, pose, hand relationship, scene, props, crop, image-axis relationship, visible perspective, light, exposure, color, depth, and style.",
      "Do not guess a second defect, broaden the repair region, redesign the image, add a person, garment, accessory, object, text, watermark, platform UI, or unsupported product detail.",
    ].join("\n"),
  };
}
