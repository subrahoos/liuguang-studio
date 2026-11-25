import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { storagePaths } from "@/lib/storage-root";
import { auditModelApiCall } from "@/lib/model-api-audit";

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

interface PlanRequest {
  projectId?: string;
  versionId?: string;
  clientRequestId?: string;
  productName?: string;
  productFeatures?: string;
  category?: string;
  duration?: number;
  videoMode?: string;
  productImages?: string[];
  cloneAnalysis?: string;
  transcript?: string;
  userRequirements?: string;
  cloneMethodInstruction?: string;
  identityPackInstruction?: string;
  llmConfig?: LlmConfig;
}

const activePlanControllers = ((globalThis as typeof globalThis & {
  __daihuoClonePlanControllers?: Map<string, AbortController>;
}).__daihuoClonePlanControllers ??= new Map<string, AbortController>());

function planControllerKey(projectId: string, clientRequestId?: string) {
  return clientRequestId ? `${projectId}:${clientRequestId}` : projectId;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizeBaseUrl(baseUrl)}/v1${path}`;
}

async function fetchChatTextStream(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs = 0,
  controller = new AbortController()
) {
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`LLM planning request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
    : null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "daihuo-jianshou/1.0",
        ...headers,
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}: ${errorText.slice(0, 1200)}`);
    }
    if (!response.body) throw new Error("LLM stream response has no body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    let rawBody = "";

    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (error) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          throw new Error(reason instanceof Error ? reason.message : "LLM 规划请求已取消。");
        }
        const partialText = output.trim();
        if (partialText) {
          console.warn("LLM stream ended unexpectedly after receiving partial planning text; attempting to use recovered text.", {
            chars: partialText.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return partialText;
        }
        const partialRaw = rawBody.trim();
        if (partialRaw) {
          console.warn("LLM stream ended unexpectedly after receiving raw body; attempting to parse recovered raw body.", {
            chars: partialRaw.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return partialRaw;
        }
        throw new Error(`LLM 规划连接被中断，请重试。底层错误：${error instanceof Error ? error.message : String(error)}`);
      }

      const { value, done } = readResult;
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      rawBody += chunk;
      buffer += chunk;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
        for (const line of lines) {
          const data = line.replace(/^data:\s*/, "").trim();
          if (!data) continue;
          if (data === "[DONE]") return output.trim();

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const choices = event.choices;
          if (!Array.isArray(choices)) continue;
          for (const choice of choices) {
            const item = choice as Record<string, unknown>;
            const delta = item.delta as Record<string, unknown> | undefined;
            const message = item.message as Record<string, unknown> | undefined;
            const content = delta?.content ?? message?.content;
            if (typeof content === "string") output += content;
            if (Array.isArray(content)) {
              output += content.map((part) => {
                const record = part as Record<string, unknown>;
                return typeof record.text === "string" ? record.text : "";
              }).join("");
            }
          }
        }
      }
    }

    const streamedText = output.trim();
    if (streamedText) return streamedText;

    try {
      return extractText(JSON.parse(rawBody)).trim();
    } catch {
      return rawBody.trim();
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function maskEndpoint(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.replace(/\?.*$/, "");
  }
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;

  const choices = record.choices;
  if (Array.isArray(choices)) {
    return choices
      .map((choice) => {
        const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((item) => {
              const part = item as Record<string, unknown>;
              return typeof part.text === "string" ? part.text : "";
            })
            .join("");
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  const output = record.output;
  if (Array.isArray(output)) {
    return output
      .flatMap((item) => {
        const content = (item as Record<string, unknown>).content;
        return Array.isArray(content) ? content : [];
      })
      .map((part) => {
        const item = part as Record<string, unknown>;
        return typeof item.text === "string" ? item.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function extractJsonObject(text: string): Record<string, unknown> {
  const direct = text.trim();
  try {
    return JSON.parse(direct) as Record<string, unknown>;
  } catch {
    const match = direct.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM did not return a JSON object.");
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function flattenSegmentAssetPrompts(plan: Record<string, unknown>) {
  const segmentPlans = Array.isArray(plan.segmentAssetPlans)
    ? plan.segmentAssetPlans as Record<string, unknown>[]
    : [];
  const nestedPrompts = segmentPlans.flatMap((segment, segmentIndex) => {
    const explicitIndex = Number(segment.segmentIndex);
    const safeSegmentIndex = Number.isFinite(explicitIndex) && explicitIndex > 0
      ? Math.round(explicitIndex)
      : segmentIndex + 1;
    const prompts = Array.isArray(segment.image2AssetPrompts)
      ? segment.image2AssetPrompts as Record<string, unknown>[]
      : [];
    return prompts.slice(0, 7).map((prompt, promptIndex) => ({
      ...prompt,
      segmentIndex: Number(prompt.segmentIndex) || safeSegmentIndex,
      segmentTimeRange: prompt.segmentTimeRange || segment.timeRange || "",
      segmentStoryPurpose: prompt.segmentStoryPurpose || segment.storyPurpose || segment.segmentDirectorSummary || "",
      assetRole: prompt.assetRole || prompt.role || `segment-${safeSegmentIndex}-asset-${promptIndex + 1}`,
    }));
  });

  if (nestedPrompts.length > 0) {
    plan.image2AssetPrompts = nestedPrompts;
  }

  return plan;
}

function normalizeForDedup(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function removeEmbeddedDuplicate(text: string, duplicate: string) {
  const cleanText = text.trim();
  const cleanDuplicate = duplicate.trim();
  if (!cleanText || !cleanDuplicate) return cleanText;
  if (cleanText === cleanDuplicate) return "";
  if (cleanText.includes(cleanDuplicate)) {
    return cleanText.replace(cleanDuplicate, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  const normalizedText = normalizeForDedup(cleanText);
  const normalizedDuplicate = normalizeForDedup(cleanDuplicate);
  if (normalizedText === normalizedDuplicate) return "";
  if (normalizedText.includes(normalizedDuplicate)) return "";
  return cleanText;
}

function promptFieldIfNotDuplicate(label: string, value: string, ...existingLongFields: string[]) {
  const cleanValue = value.trim();
  if (!cleanValue) return "";
  const normalizedValue = normalizeForDedup(cleanValue);
  const duplicated = existingLongFields.some((field) => {
    const normalizedField = normalizeForDedup(field || "");
    return normalizedField && (
      normalizedField === normalizedValue ||
      normalizedField.includes(normalizedValue) ||
      normalizedValue.includes(normalizedField)
    );
  });
  return duplicated ? "" : `${label}: ${cleanValue}`;
}

function buildPrompt(input: Required<Omit<PlanRequest, "llmConfig" | "clientRequestId" | "versionId">>) {
  const segmentCount = Math.max(1, Math.ceil((Number(input.duration) || 10) / 10));
  const maxAssetPrompts = Math.min(42, segmentCount * 7);
  const cleanCloneAnalysis = removeEmbeddedDuplicate(
    removeEmbeddedDuplicate(input.cloneAnalysis || "", input.cloneMethodInstruction || ""),
    input.transcript || ""
  );
  const cleanProductFeatures = promptFieldIfNotDuplicate(
    "Product selling points / clone-specific requirements",
    input.productFeatures || "",
    input.userRequirements || ""
  );
  const cleanUserRequirements = input.userRequirements
    ? `Current product package / product structure lock: ${input.userRequirements}`
    : "";
  const segmentAssetCountPolicy = [
    "SEGMENT ASSET COUNT POLICY:",
    "- 10s=exactly 7 assets; 8s=6; 6s=5; 4s=4. Do not output only 5 assets for a 10s segment.",
    "- Assets must be derived from that segment's time range in fullVideoPrompt and approved before video generation.",
    "- Product reference images are the only product truth. Never invent garment details from method/source clothing.",
    "- 10s asset roles: A1 first frame/scene/outfit anchor; A2 identity/expression/phone/gaze anchor; A3 product-on-body proof; A4 front structure lock; A5 hand/product detail interaction; A6 mid-action transition; A7 ending continuity.",
    "- Method-aware framing: outdoor/home mirror needs enough full/3/4 body keyframes; car OOTD stays seated in the car container; brand/magazine follows its composition while keeping product readable.",
    "- Every asset prompt must include scene anchors, camera crop, body direction, hand contact, visible product structures, outfit lock, and negative constraints.",
  ].join("\n");
  const crossSegmentDiversityPolicy = [
    "CROSS-SEGMENT DIVERSITY POLICY:",
    "- A1-A7 is a per-segment reference-asset structure, not a repeated pose template. For 20s/30s/40s+ videos, every segment must represent a different time slice, narrative phase, body direction, action path, and camera-distance mix.",
    "- Before writing image2AssetPrompts, create a segmentDifferentiationPlan. It must assign each segment a unique narrative phase and action family. Example phases: opening scene setup, product-on-body proof, detail interaction, movement transition, back/side reveal, lifestyle proof, ending hold. Do not reuse the same side-body mirror selfie across segments.",
    "- Segment 1 should usually establish the account scene and first readable outfit/product state. Segment 2 should advance into a different body direction or product interaction. Segment 3 should not copy segment 1/2; use a new movement stage such as walking step, turn-back, seated/leaning/lifestyle action, deeper detail proof, or scene transition when the chosen method allows it. Segment 4+ should continue the story with new continuity anchors, not another duplicate A1-A7 set.",
    "- Within one segment, A1-A7 must cover distinct asset purposes. Across segments, the same asset role must also change its body direction/action/crop. For example, Segment 1 A3 cannot be the same side pose as Segment 2 A3 or Segment 3 A3.",
    "- Track body direction explicitly: front, 3/4 side, true side, back/over-shoulder, walking diagonal, seated/leaning, hand-detail close-up. No single body direction may dominate more than half of the total assets unless the method physically requires it.",
    "- Track camera distance explicitly: full-body, 3/4 body, waist-up, chest-up, detail close-up, scene anchor. For fashion try-on/mirror/street methods, each 10s segment should contain at least two full-body or 3/4-body assets unless the method is car/interior seated.",
    "- Track hand action explicitly: phone hold, collar/cuff touch, tiny hem pinch, waist/pocket touch, fabric smoothing, bag/prop contact, hair/face gesture, no-hand ending hold. Do not repeat the same hand path in most assets.",
    "- For upper-body garments, do not ask for large hem pulls, wide two-hand stretching, downward pulling, or fabric-panel display. If looseness must be shown, use a tiny 2-4 cm side-seam/lower-hem pinch, one light fabric smoothing motion, collar/cuff/hem tapping, or a brief sleeve/texture point. The product silhouette and length must return to the approved shape immediately.",
    "- Human anatomy safety: every person asset must describe one natural adult with exactly two arms and two hands. For mirror/selfie assets, one hand may hold the phone and the other may perform one simple action only. Avoid crossed arms, arms wrapping across the torso, both hands touching opposite sleeves, hidden elbows, overlapping forearms, or ambiguous reflected limbs.",
    "- If a hand action risks extra arms or fused limbs, simplify it before output: use one visible hand pinching the sleeve edge, one hand smoothing the hem, one hand touching the collar, or one relaxed hand in pocket. Keep the other arm either holding the phone or relaxed at the side.",
    "- If a proposed asset looks similar to a previous segment asset, rewrite it before output. Similar means same body direction + same crop + same hand action + same camera angle, even if the text uses different adjectives.",
  ].join("\n");
  const schema = {
    totalDuration: Number(input.duration) || 30,
    methodType: "Auto-selected clone method type, for example street mirror selfie / car scene / indoor mirror / home / brand ad / magazine mood / other",
    selectedMethodReason: "Explain why this method was selected, citing evidence from the reference-video analysis.",
    productVisualAnalysis: {
      productType: "Chinese user-review text. Identify the exact product type from the uploaded product images.",
      silhouetteAndFit: "Chinese user-review text. Shape, length, looseness, proportion, on-body fit.",
      colorMaterialTexture: "Chinese user-review text. Color, material, texture, transparency, knit/lace/embroidery/openwork/pattern if visible.",
      structureDetails: ["Chinese visible product details: neckline, collar, sleeve, hem, waist, placket, trim, pattern, closure, pocket, strap, etc."],
      mustKeepDetails: ["Chinese details that must be preserved in every asset and video segment."],
      mustNotInventDetails: ["Chinese details that must not be invented if absent from product images."],
      mutationRisks: ["Chinese likely image/video generation drift risks for this product."],
    },
    productStructureLock: {
      chineseLock: "Chinese hard product lock for user review.",
      englishLock: "English hard product lock to be repeated in fullVideoPrompt, every image-2 prompt, and every Grok/Omni segment prompt.",
      priorityRule: "Product images override product name, selling text, method library, and old example clothing.",
    },
    chineseSummary: "Chinese summary for user review: how the final video will be shot, where it stays highly similar, and how the person/product will be replaced.",
    fullVideoPrompt: "English Grok full-video director prompt. It must include identity lock, product lock, outfit coordination lock, scene continuity, camera rhythm, actions, facial expressions, product interactions, timing, voiceover rhythm, subtitle logic, negative constraints, and source-derived camera placement/intent, subject-environment relationship including foreground occlusion, light motivation/natural exposure, observable atmosphere/physical texture, and emotional color-grade rules.",
    negativePrompt: "English negative prompt.",
    outfitCoordinationLock: "Chinese review text. Define one stable lower-body styling / pants / shoes / accessories for this project. If the product is an upper-body garment, the bottom styling is not the product but must stay consistent across all assets and video segments.",
    segmentDifferentiationPlan: [
      {
        segmentIndex: 1,
        timeRange: "0-10s",
        narrativePhase: "Unique story phase for this segment.",
        primaryBodyDirection: "front / 3-4 side / true side / back / diagonal walking / seated / leaning / detail-only, chosen for this exact segment.",
        primaryActionBeats: ["Concrete action beats that must differ from other segments."],
        cameraDistanceMix: ["full-body / 3-4 body / waist-up / chest-up / detail close-up / scene anchor mix for this segment."],
        differenceFromPreviousSegments: "How this segment avoids repeating the body direction, hand path, camera crop, and action family of earlier segments.",
        anatomySafetyPlan: "How this segment avoids extra arms, fused hands, crossed-arm ambiguity, and mirror-reflection limb confusion.",
      },
    ],
    videoSegmentPlan: [
      {
        segmentIndex: 1,
        durationSeconds: 10,
        timeRange: "0-10s",
        requiredAssetCount: 7,
        storyPurpose: "The narrative responsibility of this segment inside the full 20/30/60-second video.",
        segmentUniquenessRule: "What must be visually different from other segments: body direction, hand path, action family, crop, camera movement, and product proof angle.",
        anatomySafetyRule: "For person shots, use only simple non-overlapping hand actions. One phone-holding hand plus one product-touching hand is allowed; avoid crossed arms or ambiguous mirror limbs.",
        cameraMovementPlan: "A camera movement plan derived from this exact time range of fullVideoPrompt, not a fixed template. Choose the movement only after reading the segment's action, product-showing task, scene container, and continuity need. Include physical camera placement, viewpoint intent, foreground/occlusion relationship, camera type, start framing, end framing, speed, subject distance, product area kept visible, and forbidden camera behavior.",
        fullPromptExcerpt: "A concise excerpt from fullVideoPrompt for this time range: action, scene, product display, and voiceover rhythm.",
        requiredReferenceAssets: ["Exactly 7 asset roles for a 10-second segment, following the segment keyframe / asset count policy."],
      },
    ],
    segmentVideoPromptDrafts: [
      {
        segmentIndex: 1,
        timeRange: "0-10s",
        durationSeconds: 10,
        promptEnglishDraft: "English segment-specific Grok/Omni prompt draft. It must combine the fullVideoPrompt, this segment's story purpose, cameraMovementPlan, asset references to be approved later, productStructureLock, source-derived light motivation/natural exposure, only observable air/physical texture, and emotional color-grade rules.",
        referenceImageUsagePlan: ["How this segment should use A1-A7 approved assets plus product reference image when available."],
        motionAndCameraChecks: ["Checks for normal-speed motion, subject-driven action, camera limits, product readability, and continuity."],
      },
    ],
    segmentAssetPlans: [
      {
        segmentIndex: 1,
        durationSeconds: 10,
        timeRange: "0-10s",
        requiredAssetCount: 7,
        sourceFromFullVideoPrompt: "Must come from the corresponding time range of the full director prompt; do not invent a separate new video.",
        segmentDirectorSummary: "Scene, action, camera, expression, product display, voiceover rhythm, and continuity summary for this segment.",
        assetDiversityMap: "Explain how A1-A7 in this segment differ from each other and from previous segment assets.",
        anatomySafetyMap: "For each person asset, define a simple hand layout: phone hand, product-touching hand, relaxed hand, pocket hand, or no-hand action. Avoid crossed arms and overlapping forearms.",
        image2AssetPrompts: [
          {
            assetName: "asset name",
            assetRole: "A1 first_frame_composition_anchor / A2 identity_expression_anchor / A3 product_on_body_structure_anchor / A4 product_front_structure_lock / A5 product_detail_interaction / A6 motion_transition_pose / A7 ending_continuity_anchor",
            purpose: "why this asset is needed for this exact time segment",
            promptChinesePreview: "Chinese preview text for the user.",
            promptEnglish: "English prompt for image-2. It must serve this segment only and be fully concrete: scene container, foreground/midground/background anchors, light direction and texture, camera framing, lens feel, body pose/action, simple non-overlapping hand contact, facial/phone/gaze state, product-visible areas, outfit lock, product-reference truth, anatomy safety, and negative constraints.",
            referencePriority: "product first / identity first / scene first",
          },
        ],
      },
    ],
    voiceoverRewrite: "Chinese voiceover rewrite that preserves the reference video's selling rhythm while replacing the current product.",
    scriptPreviewAdvice: {
      hook: "Opening advice.",
      sellingLogic: "Selling logic.",
      shotCountAdvice: "Suggested shot/segment responsibilities according to target duration.",
    },
    assetPlan: {
      personViews: ["Needed person angles, expressions, actions, mouth-shape assets."],
      identityGaps: ["If selected identity references are insufficient, report a user-facing suggestion only. Never auto-create or auto-attach another identity image."],
      productViews: ["Needed product front/side/back/flat-lay/try-on/detail/material assets."],
      outfitCoordination: ["One stable lower-body styling / pants / shoes / accessories rule shared by all assets."],
      sceneImages: ["Main scene, auxiliary scene, atmosphere image, first-frame background."],
      motionReferences: ["Action, hand gesture, camera movement, expression rhythm references."],
      firstFrameAnchors: ["First-frame anchor images needed by Grok full-video generation."],
      detailAssets: ["Collar, cuff, waist, hem, fabric, hand interaction, or other close details."],
      atmosphereAssets: ["Lighting, color tone, props, environment atmosphere images."],
    },
    image2AssetPrompts: "Do not output this top-level compatibility field. The server will derive it from segmentAssetPlans.image2AssetPrompts.",
    grokGenerationNotes: ["Notes for generating the full video with Grok."],
    replacementBoundaries: ["Elements that must be replaced and structures that should remain highly similar."],
    qualityChecklist: [
      "Chinese checklist item: product structure is accurate and not polluted by method source clothing.",
      "Chinese checklist item: method/account-template similarity is visible.",
      "Chinese checklist item: image-2 assets are useful video keyframes.",
      "Chinese checklist item: Grok/Omni prompts are normal-speed video instructions, not slow animated stills.",
    ],
  };

  return [
    "You are a senior ecommerce short-video clone director, asset planner, and prompt engineer.",
    "Treat yourself as an intelligent model that can reason independently. Combine the reference-video analysis, method library, manually selected identity references, current product images, and product selling points into one executable high-similarity clone generation plan.",
    "This step is a planning preview, not the final generated video. Return one parseable JSON object only. Do not output Markdown or code fences.",
    "",
    "Target workflow: analyze the reference video -> write one complete full-video director prompt first -> split it into approximately 10-second video tasks according to target duration -> derive an asset package for every time segment -> image-2 generates segment assets -> user reviews segment assets -> Grok/Omni generates each segment -> FFmpeg composes the full video.",
    "",
    "High-similarity clone requirements:",
    "- Keep source directing grammar: scene logic, shot order, rhythm, actions, expressions, product-showing method, camera movement, transitions, and account-template feel.",
    "- Replace source person/product/brand/logo/price/shop/subtitle identity/copyrighted elements. When people appear, use only the manually selected identity references; if an angle is missing, list a user-facing suggestion in assetPlan.identityGaps and never auto-add a new identity image.",
    "- Product images are highest priority. Infer productVisualAnalysis and productStructureLock before all prompts; never invent decorative details, neckline, trim, fabric, logo, label, or category changes absent from product images.",
    "- Repeat concise productStructureLock.englishLock in fullVideoPrompt, segmentVideoPromptDrafts, and every image-2 prompt.",
    "- If product is upper-body clothing, create one outfitCoordinationLock for bottom/shoes/accessories and keep it consistent across all assets/video segments.",
    "- fullVideoPrompt must be English and read like a complete director script, not a loose shot list. Chinese fields are for user review.",
    "- Avoid vague style words. Convert premium/realistic/account/cinematic into observable details: body angle, hand path, physical camera placement and viewpoint intent, foreground/midground/background relationship and occlusion, camera distance, lens feel, visible/evidenced light source and natural exposure compromise, only observable air/physical texture, emotional color-grade bias, scene anchor, fabric force, pause point, and visible product structure.",
    "- The fullVideoPrompt and every segmentVideoPromptDraft must explicitly preserve the source-derived photographic logic: where the camera is and why that angle works; how the person relates to environmental layers, reflections, ground plane, and any foreground obstruction; why the light exists and how natural exposure behaves; only observable haze/humidity/dust/smoke/compression/grain/reflection/motion-blur texture; and palette, white-balance bias, contrast, saturation, skin/background treatment, and emotional color-grade effect. When source evidence cannot establish a detail, retain that uncertainty instead of inventing a cinematic substitute.",
    "- Motion must be normal-speed and subject-driven. Every 8-10s needs 2-4 visible action beats: turn, step, weight shift, hand adjusts collar/cuff/hem/waist/tie, look-back, pocket touch, fabric smoothing, final product hold. Camera movement cannot be the only motion.",
    "- Human anatomy must stay simple and readable. For image-2 person assets, never ask for crossed arms, two hands reaching across the torso, both hands touching opposite sleeves, hidden elbows, or complex overlapping hand paths. Use one clear hand action per asset.",
    "- Pick one concrete camera movement per segment only after reading that segment's purpose: locked mirror frame, handheld follow, short push-in, pull-out reveal, lateral truck, tilt/rise, small 10-30 degree arc, parallax slider, dolly, rack focus, foreground reveal. State start/end framing, speed, distance, product area visible, and forbidden camera behavior.",
    "- image-2 prompts must be concrete video-keyframe instructions: scene container, foreground/midground/background, light, camera crop, body pose/action, hand contact, expression/phone/gaze, product-visible areas, outfit lock, and negative constraints.",
    "- Outdoor mirror/street methods should feel like real phone-recorded fashion account frames: reflective mirror/storefront edge, off-center model, phone partly covering face, sidewalk/cars/plane trees, dappled hard sunlight, imperfect crop, no generated text/UI/watermark.",
    "- Hierarchy: fullVideoPrompt controls global story; videoSegmentPlan controls segment; approved image assets control visual structure; product images/productStructureLock control product truth.",
    segmentAssetCountPolicy,
    crossSegmentDiversityPolicy,
    "",
    "Required reasoning and output order:",
    "0. Infer productVisualAnalysis and productStructureLock from product reference images.",
    `1. Write one fullVideoPrompt for all ${Number(input.duration) || 30}s before assets.`,
    `2. Split into about ${segmentCount} segment(s): 20s=10+10, 30s=10+10+10. Then write segmentDifferentiationPlan before writing any A1-A7 prompts.`,
    "3. For each segment, derive cameraMovementPlan, segmentAssetPlans, image2AssetPrompts, and segmentVideoPromptDrafts from that time range only. Every segment must be visually different from the others.",
    "4. Do not duplicate segment image prompts into top-level image2AssetPrompts; the server will flatten them after parsing.",
    `- totalDuration must equal ${Number(input.duration) || 30}. Normal business logic uses segmentAssetPlans. Total max asset prompts: ${maxAssetPrompts}.`,
    "- Output scale: fullVideoPrompt 280-480 English words; negativePrompt 60-120 words; each image prompt 55-95 words; each Chinese preview 1 short sentence; assetPlan arrays max 4 items.",
    "",
    "Local high-similarity method library / auto-selection reference:",
    input.cloneMethodInstruction || "No method library passed; infer from reference-video analysis.",
    "",
    "Manually selected identity reference rules:",
    input.identityPackInstruction || "No identity reference was selected. Do not auto-select, infer, or create an identity pack.",
    "",
    "Current product information:",
    `Product name: ${input.productName}`,
    `Product category: ${input.category}`,
    `Target duration: ${input.duration} seconds`,
    `Video mode: ${input.videoMode}`,
    cleanProductFeatures,
    cleanUserRequirements,
    `Product reference image paths:\n${input.productImages.join("\n")}`,
    "",
    "Method-library short summary / current clone context:",
    cleanCloneAnalysis || "No separate short summary; use the method library instruction without duplicating source-video evidence.",
    "",
    "Method-source transcript:",
    input.transcript || "No source transcript is passed at planning time. Use the method library voiceover rules and write a new voiceover for the current product.",
    "",
    "Return strict JSON only. Use this JSON structure:",
    JSON.stringify(schema),
  ].filter(Boolean).join("\n");
}

function buildSavedMarkdown(input: {
  projectId: string;
  versionId?: string;
  plan: Record<string, unknown>;
  rawText: string;
}) {
  return [
    "# Clone Full-Video Plan",
    "",
    `- Project ID: ${input.projectId}`,
    input.versionId ? `- Version ID: ${input.versionId}` : "",
    `- Generated at: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "## Method Type",
    "",
    String(input.plan.methodType || ""),
    "",
    "## Method Decision Reason",
    "",
    String(input.plan.selectedMethodReason || ""),
    "",
    "## Chinese Summary",
    "",
    String(input.plan.chineseSummary || ""),
    "",
    "## Product Visual Analysis",
    "",
    "```json",
    JSON.stringify(input.plan.productVisualAnalysis ?? {}, null, 2),
    "```",
    "",
    "## Product Structure Lock",
    "",
    "```json",
    JSON.stringify(input.plan.productStructureLock ?? {}, null, 2),
    "```",
    "",
    "## Full-Video Prompt",
    "",
    "```text",
    String(input.plan.fullVideoPrompt || ""),
    "```",
    "",
    "## Negative Prompt",
    "",
    "```text",
    String(input.plan.negativePrompt || ""),
    "```",
    "",
    "## Outfit Coordination Lock",
    "",
    String(input.plan.outfitCoordinationLock || ""),
    "",
    "## Voiceover Rewrite",
    "",
    String(input.plan.voiceoverRewrite || ""),
    "",
    "## Script Preview Advice",
    "",
    "```json",
    JSON.stringify(input.plan.scriptPreviewAdvice ?? {}, null, 2),
    "```",
    "",
    "## Asset Plan",
    "",
    "```json",
    JSON.stringify(input.plan.assetPlan ?? {}, null, 2),
    "```",
    "",
    "## Segment Asset Plans",
    "",
    "```json",
    JSON.stringify(input.plan.segmentAssetPlans ?? [], null, 2),
    "```",
    "",
    "## Segment Video Prompt Drafts",
    "",
    "```json",
    JSON.stringify(input.plan.segmentVideoPromptDrafts ?? [], null, 2),
    "```",
    "",
    "## image-2 Asset Prompts",
    "",
    "```json",
    JSON.stringify(input.plan.image2AssetPrompts ?? [], null, 2),
    "```",
    "",
    "## Grok Generation Notes",
    "",
    "```json",
    JSON.stringify(input.plan.grokGenerationNotes ?? [], null, 2),
    "```",
    "",
    "## Replacement Boundaries",
    "",
    "```json",
    JSON.stringify(input.plan.replacementBoundaries ?? [], null, 2),
    "```",
    "",
    "## Quality Checklist",
    "",
    "```json",
    JSON.stringify(input.plan.qualityChecklist ?? [], null, 2),
    "```",
    "",
    "## Raw JSON",
    "",
    "```json",
    JSON.stringify(input.plan, null, 2),
    "```",
    "",
    input.rawText && !input.rawText.trim().startsWith("{") ? `\n## Raw Text\n\n${input.rawText}` : "",
  ].filter(Boolean).join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as PlanRequest;
    const {
      projectId,
      versionId,
      productName,
      productFeatures,
      category,
      duration,
      videoMode,
      productImages,
      cloneAnalysis,
      transcript,
      userRequirements,
      cloneMethodInstruction,
      identityPackInstruction,
      llmConfig,
      clientRequestId,
    } = body;

    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return NextResponse.json({ error: "Missing or invalid projectId." }, { status: 400 });
    }
    const projectAccess = await getOwnedProjectAccess(req, projectId);
    if (!projectAccess) {
      return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
    }
    const resolvedLlmConfig = await resolveLLMSetting(req, llmConfig);
    if (!resolvedLlmConfig?.baseUrl || !resolvedLlmConfig.apiKey || !resolvedLlmConfig.model) {
      return NextResponse.json({ error: "Missing LLM config." }, { status: 400 });
    }
    if (!cloneAnalysis?.trim()) {
      return NextResponse.json({ error: "Missing clone analysis text." }, { status: 400 });
    }

    const prompt = buildPrompt({
      projectId,
      productName: productName || "",
      productFeatures: productFeatures || "",
      category: category || "",
      duration: Number(duration || 30),
      videoMode: videoMode || "live_presenter",
      productImages: Array.isArray(productImages) ? productImages : [],
      cloneAnalysis,
      transcript: transcript || "",
      userRequirements: userRequirements || "",
      cloneMethodInstruction: cloneMethodInstruction || "",
      identityPackInstruction: identityPackInstruction || "",
    });

    const endpoint = openAIEndpoint(resolvedLlmConfig.baseUrl, "/chat/completions");
    const startedAt = Date.now();
    console.log(`[clone-plan:${projectId}] start`, {
      endpoint: maskEndpoint(endpoint),
      model: resolvedLlmConfig.model,
      versionId: typeof versionId === "string" ? versionId : "",
      promptChars: prompt.length,
      fieldChars: {
        productFeatures: (productFeatures || "").length,
        userRequirements: (userRequirements || "").length,
        cloneAnalysis: (cloneAnalysis || "").length,
        cloneMethodInstruction: (cloneMethodInstruction || "").length,
        transcript: (transcript || "").length,
      },
      productImages: Array.isArray(productImages) ? productImages.length : 0,
      duration: Number(duration || 30),
    });

    const requestKey = planControllerKey(projectId, typeof clientRequestId === "string" ? clientRequestId : undefined);
    const planController = new AbortController();
    activePlanControllers.get(requestKey)?.abort(new Error("同一规划请求已被新的请求替换。"));
    activePlanControllers.set(requestKey, planController);

    let rawText = "";
    try {
      rawText = await auditModelApiCall({
        userId: projectAccess.user.id,
        callType: "llm",
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        model: resolvedLlmConfig.model,
        source: "clone.plan-full-video",
        projectId,
      }, () => fetchChatTextStream(endpoint, {
        model: resolvedLlmConfig.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.25,
        max_tokens: 4500,
      }, {
        Authorization: `Bearer ${resolvedLlmConfig.apiKey}`,
      }, 0, planController));
    } finally {
      if (activePlanControllers.get(requestKey) === planController) {
        activePlanControllers.delete(requestKey);
      }
    }

    console.log(`[clone-plan:${projectId}] llm returned`, {
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      chars: rawText.length,
    });

    if (!rawText.trim()) throw new Error("Full-video plan returned empty text.");
    const plan = flattenSegmentAssetPrompts(extractJsonObject(rawText));
    const requestedDuration = Number(duration || 30);
    plan.totalDuration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? Math.round(requestedDuration) : 30;

    const safeVersionId = typeof versionId === "string" && /^[a-zA-Z0-9_-]+$/.test(versionId) ? versionId : "no-version";
    const planDir = storagePaths.clone("plans", projectId, safeVersionId, String(Date.now()));
    await mkdir(planDir, { recursive: true });
    const savedMarkdown = buildSavedMarkdown({
      projectId,
      versionId: safeVersionId === "no-version" ? undefined : safeVersionId,
      plan,
      rawText,
    });
    const savedMarkdownPath = join(planDir, "clone-full-video-plan.md");
    const savedJsonPath = join(planDir, "clone-full-video-plan.json");
    await writeFile(savedMarkdownPath, savedMarkdown, "utf8");
    await writeFile(savedJsonPath, JSON.stringify(plan, null, 2), "utf8");
    console.log(`[clone-plan:${projectId}] saved`, {
      versionId: safeVersionId,
      savedMarkdownPath,
      savedJsonPath,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    });

    return NextResponse.json({
      ok: true,
      plan,
      savedMarkdown,
      savedMarkdownPath,
      savedJsonPath,
    });
  } catch (error) {
    console.error("clone full-video planning failed:", error);
    const message = error instanceof Error ? error.message : "Clone full-video planning failed.";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { projectId?: string; clientRequestId?: string };
  const projectId = body.projectId || req.nextUrl.searchParams.get("projectId") || "";
  const clientRequestId = body.clientRequestId || req.nextUrl.searchParams.get("clientRequestId") || "";
  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    return NextResponse.json({ error: "Missing or invalid projectId." }, { status: 400 });
  }
  if (!await getOwnedProjectAccess(req, projectId)) {
    return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
  }

  const keys = clientRequestId
    ? [planControllerKey(projectId, clientRequestId)]
    : Array.from(activePlanControllers.keys()).filter((key) => key === projectId || key.startsWith(`${projectId}:`));

  let cancelled = 0;
  for (const key of keys) {
    const controller = activePlanControllers.get(key);
    if (!controller) continue;
    controller.abort(new Error("用户已点击取消，LLM 规划请求已停止。"));
    activePlanControllers.delete(key);
    cancelled += 1;
  }

  return NextResponse.json({ ok: true, cancelled });
}
