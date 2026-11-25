import { NextRequest, NextResponse } from "next/server";
import { canAccessOptionalProject } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { resolveIdentityImageFile } from "@/lib/identity-pack";
import { readFile } from "fs/promises";
import { resolveOwnedStoredProjectFile } from "@/lib/project-local-archive";
import { auditModelApiCall } from "@/lib/model-api-audit";

const TIMEOUT_MS = 180_000;

type LLMConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
};

type VideoPromptClip = {
  shotId: number;
  shotType: string;
  duration: number;
  description?: string;
  camera?: string;
  voiceover?: string;
  transition?: string;
  imagePrompt?: string;
  baseVideoPrompt?: string;
  imageUrl?: string | null;
  imageUrls?: string[];
  productAnalysis?: string;
  variationSeed?: number;
  useVisionFrame?: boolean;
  visionReferenceNote?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeBaseUrl(baseUrl)
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}/v1${path}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractText(payload: unknown): string {
  const body = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("\n");
  }
  return body.choices?.[0]?.message?.content || "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Request timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1200);
}

function compactText(value: string | undefined, limit: number): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... [trimmed for faster video prompt generation]`;
}

const GLOBAL_VIDEO_QUALITY_RULES = [
  "Weighted Movement: describe real gravity-based motion. Limbs must feel physically weighted; walking must show grounded foot contact, force transfer from feet through knees/hips/torso, and natural balance changes.",
  "Fabric Physics: clothing hems, sleeves, straps, ties, loose fabric, and hair must react to body inertia, hand contact, walking, turning, and camera movement. Reject floating fabric, rigid fabric, or mannequin-like stillness.",
  "Soulful Eyes: if a face is visible, specify clear catchlights, focused gaze direction, and subtle shot-specific micro-expression in the eyes, brows, cheeks, and mouth. Reject vacant eyes, frozen blank faces, plastic skin, or identity-changing expressions.",
  "Atmospheric Scene: add realistic depth through volumetric light when appropriate, suspended air particles or dust only when believable for the location, and subtle natural film grain. Reject flat, overly clean, depthless backgrounds.",
];

const VIDEO_DIRECTOR_SYSTEM_PROMPT =
  "You are a senior cinematic vertical ecommerce video director. Output English only. Write a complete image-to-video director prompt, not a short motion note. Never repeat the full keyframe prompt. Never alter product identity. Create real-time subject/product action, camera direction, timing, continuity, weighted physical movement, soulful eyes when faces are visible, atmospheric scene texture, and negative constraints.";

function imageFileToDataUrl(filePath: string, buffer: Buffer): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return `data:${mimeMap[ext] || "image/png"};base64,${buffer.toString("base64")}`;
}

async function imagePathToBase64(imagePath?: string | null, origin?: string, ownerId?: string): Promise<string | null> {
  if (!imagePath) return null;
  if (imagePath.startsWith("data:image/") || imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    return imagePath;
  }

  const identityMatch = imagePath.match(/\/api\/identity-pack\/file\/([^/?#]+)/);
  if (identityMatch && ownerId) {
    const filePath = await resolveIdentityImageFile(ownerId, decodeURIComponent(identityMatch[1]));
    return filePath ? imageFileToDataUrl(filePath, await readFile(filePath)) : null;
  }

  if (imagePath.startsWith("/") && !imagePath.startsWith("/api/files/") && origin) {
    const response = await fetch(`${origin}${imagePath}`).catch(() => null);
    if (!response?.ok) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }

  const match = imagePath.match(/\/api\/files\/(.+)/);
  if (!match) return null;

  const parts = match[1].split("/");
  const filePath = parts.length >= 2
    ? await resolveOwnedStoredProjectFile(ownerId || "", parts[0], "assets", parts.slice(1).join("/"))
    : "";
  if (!filePath) return null;
  const buffer = await readFile(filePath);
  return imageFileToDataUrl(filePath, buffer);
}

async function collectVisionImages(clip: VideoPromptClip, origin: string, ownerId: string): Promise<string[]> {
  if (!clip.useVisionFrame) return [];
  const candidates = [clip.imageUrl, ...(clip.imageUrls ?? [])]
    .filter((url): url is string => Boolean(url?.trim()));
  const unique = Array.from(new Set(candidates)).slice(0, 6);
  const images = await Promise.all(unique.map((url) => imagePathToBase64(url, origin, ownerId).catch(() => null)));
  return images.filter((url): url is string => Boolean(url));
}

function buildUserPrompt(clip: VideoPromptClip): string {
  const variationSeed = Number.isFinite(clip.variationSeed) ? Number(clip.variationSeed) : Date.now();
  const hasIdentityLockedFrame = /MANUALLY SELECTED PROJECT IDENTITY LOCK|IDENTITY LOCK|same face shape|same identity/i.test(clip.imagePrompt || "");
  const productAnalysis = compactText(clip.productAnalysis, 1000);
  const imagePrompt = compactText(clip.imagePrompt, 700);
  const baseVideoPrompt = compactText(clip.baseVideoPrompt, 1800);
  return [
    "Create a NEW complete Seedance image-to-video cinematic director prompt for this shot.",
    "",
    "LLM creative director mode:",
    "- Treat yourself as a thinking video director, not a template expander.",
    "- Use all rules as boundary conditions. Product identity, person identity, first-frame continuity, and output language are hard boundaries; action design, facial performance, pacing, and camera behavior should be creatively chosen for this exact shot.",
    "- Read the first-frame context, user-facing description, camera direction, voiceover, shot type, duration, and product facts, then decide the best motion plan.",
    "- If visual references are attached, inspect them first before writing the prompt: first image is the current keyframe, following images are product or identity references. Use visual evidence before text assumptions.",
    "- Do not mechanically reuse the examples, the rule-based draft, or fixed action templates. Each shot should have a fresh, purposeful action and camera plan.",
    "",
    "Strict task boundary:",
    "- Do not create a new keyframe prompt.",
    "- Do not rewrite or expand visual scene details from the image prompt.",
    "- Do not change product, person, scene, styling, color, clothing, or composition.",
    "- Use the attached first-frame image as the visual authority.",
    "- Strictly preserve the first-frame person's facial features, hairstyle, skin tone, body proportions, outfit, product details, scene layout, background structure, floor/wall material, lighting direction, camera angle, and framing.",
    "- The video prompt may animate posture, hands, fabric, facial performance, mouth shape, and camera movement only. It must not redesign the first frame.",
    "- Write only an English image-to-video director prompt in the same specificity as a production prompt, not a short motion note.",
    "- The prompt must include first-frame lock, visible product/person preservation, concrete movement, camera, time arc, continuity, product consistency, audio/text handling, and negative prompt.",
    "- Make this version meaningfully different from previous rule-template motion. Do not output a generic slow push-in unless it is truly the best option.",
    "- Give specific physical actions and camera behavior that fit the shot purpose and the voiceover.",
    "- Avoid slow-motion language unless the user explicitly asks for slow motion. Use real-time ecommerce video motion by default.",
    "- The output must include visible subject or product action. Camera movement alone is not enough.",
    "- Keep the keyframe composition, product identity, and scene unchanged.",
    hasIdentityLockedFrame
      ? "- This clip uses only the project's manually selected identity references. Treat identity as a continuity constraint only: keep the selected same face/body and current product outfit, while GPT must create fresh shot-specific action, facial performance, mouth movement, gesture, and camera direction from this clip's voiceover, description, shot type, and purpose. Do not use a fixed expression template."
      : "",
    "",
    "Required output sections:",
    "IMAGE-TO-VIDEO CINEMATIC DIRECTOR PROMPT",
    "IMPORTANT",
    "LOCKED VISUAL ANCHOR",
    "SHOT PURPOSE",
    "CINEMATIC MOTION",
    "CAMERA DIRECTION",
    "LIGHTING AND TEXTURE",
    "TEMPORAL ARC",
    "PRODUCT CONSISTENCY LOCK",
    "CONTINUITY",
    "TRANSITION INTENT",
    "AUDIO AND TEXT",
    "NEGATIVE PROMPT",
    "",
    "Shot facts:",
    `shotId: ${clip.shotId}`,
    `shotType: ${clip.shotType}`,
    `duration: ${clip.duration}s`,
    `transition: ${clip.transition || "direct continuity"}`,
    `voiceover: ${clip.voiceover || "none"}`,
    `user-facing description: ${clip.description || ""}`,
    `user-facing camera direction: ${clip.camera || ""}`,
    `variationSeed: ${variationSeed}`,
    "",
    "Project-level product analysis. Reuse facts only; do not re-analyze or alter the product:",
    productAnalysis,
    "",
    "Attached visual references:",
    clip.visionReferenceNote || "If images are attached, the first image is the current generated keyframe and must be treated as the visual source of truth. Additional images are product or identity references for consistency checking only.",
    "",
    "Short image prompt summary for reference only. Do not copy it wholesale:",
    imagePrompt,
    "",
    "Current rule-based draft. Use it only as a safety baseline, not as a template to copy:",
    baseVideoPrompt,
    "",
    "Motion design requirements:",
    "- Choose one primary subject/product action and one primary camera move. The subject/product action is mandatory and must be more important than the camera move.",
    "- The action must be physically plausible within the shot duration.",
    ...GLOBAL_VIDEO_QUALITY_RULES.map((rule) => `- ${rule}`),
    "- Write the prompt as a complete paragraph/sectioned director instruction that Seedance can use directly. It should resemble a detailed image-to-video prompt: strictly reference the uploaded first-frame image, preserve all visible identity/product/scene details, then describe natural actions, camera following, fabric physics, and prohibitions.",
    "- Do not output a thin summary such as 'slight push-in' or 'model moves naturally'. Every shot must name concrete hand/body/product actions and the exact product detail being shown.",
    "- If this is a fashion/product shot, include one concrete product-serving action such as adjusting hem, brushing collar trim, pinching knit texture, turning from front to side, lifting a bag, taking one or two natural steps, reaching for phone, or revealing collar/sleeve.",
    "- For mirror selfie, try-on, or outfit-showing shots, use medium-range lifestyle motion such as slight side turn, one hand in pocket, adjusting belt/tie/hem/collar, touching waistband or pocket edge, showing short-top-long-bottom proportion, or showing natural fabric wrinkles without changing product geometry. For upper garments, hem actions must be tiny smoothing or 2-4 cm pinching only; never stretch the garment, pull it downward, or change its length/silhouette. Keep the phone/prop relationship and face coverage exactly as the first frame shows.",
    "- For a 3-4 second shot, do not spend the first full second in stillness. Start the action within the first 0.3-0.5 seconds, complete the main action in the middle, then settle briefly.",
    "- Do not use these as the primary motion: generic slow dolly-in, subtle parallax only, calm natural stillness only, gentle push-in only, near-frozen pose, or pure Ken Burns movement.",
    hasIdentityLockedFrame
      ? "- Generate a shot-specific facial performance plan from this clip's voiceover, user-facing description, shot type, and emotional purpose. Do not reuse a generic smile or fixed expression. Specify the expression, eye behavior, eyebrow/cheek subtlety, and mouth-shape only when they serve this exact shot. Keep it restrained and identity-safe; avoid exaggerated laughing, wide-open mouth, distorted lips, or emotion that changes identity."
      : "",
    "- Write a precise temporal arc with seconds.",
    "- End on a stable frame suitable for editing into the next clip.",
    "",
    "For this exact shot, derive the full video director prompt from the user-facing description, camera direction, and voiceover first. The current rule-based draft is only a fallback safety rail. If the draft says slow push-in but the script describes a richer action, follow the script action.",
    "Negative constraints must explicitly include: clothing color change, missing tie/belt/strap, pants becoming skirt, pants becoming tight, garment clipping, limb distortion, fake face, vacant eyes, missing catchlights, identity drift, plastic skin, floating fabric, rigid fabric, weightless walking, text, watermark, logo, price tag, extra people, background mutation, mirror/scene change, flat depthless background, and camera-only motion.",
  ].join("\n");
}

async function callResponses(config: LLMConfig, clip: VideoPromptClip, imageDataUrls: string[]): Promise<string> {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: buildUserPrompt(clip) },
  ];
  for (const imageDataUrl of imageDataUrls) {
    content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
  }

  const response = await fetchWithTimeout(openAIEndpoint(config.baseUrl, "/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.visionModel || config.model,
      instructions: VIDEO_DIRECTOR_SYSTEM_PROMPT,
      input: [{ role: "user", content }],
      max_output_tokens: 1200,
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await readError(response)}`);
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractText(payload).trim();
  if (!text) throw new Error("Responses API returned empty video prompt.");
  return text;
}

async function callChatCompletions(config: LLMConfig, clip: VideoPromptClip, imageDataUrls: string[]): Promise<string> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: buildUserPrompt(clip) },
  ];
  for (const imageDataUrl of imageDataUrls) {
    content.push({ type: "image_url", image_url: { url: imageDataUrl, detail: "high" } });
  }

  const response = await fetchWithTimeout(openAIEndpoint(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.visionModel || config.model,
      messages: [
        {
          role: "system",
          content: VIDEO_DIRECTOR_SYSTEM_PROMPT,
        },
        { role: "user", content },
      ],
      max_tokens: 1200,
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await readError(response)}`);
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractText(payload).trim();
  if (!text) throw new Error("Chat Completions returned empty video prompt.");
  return text;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const access = await canAccessOptionalProject(req, body.projectId);
  if (!access) return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
  const llmConfig = await resolveLLMSetting(req, body.llmConfig) as LLMConfig | null;
  const clip = body.clip as VideoPromptClip | undefined;

  if (!llmConfig?.baseUrl || !llmConfig?.apiKey || !llmConfig?.model) {
    return NextResponse.json({ error: "Missing LLM config: baseUrl, apiKey, model." }, { status: 400 });
  }

  if (!clip?.shotId || !clip.duration) {
    return NextResponse.json({ error: "Missing clip shotId or duration." }, { status: 400 });
  }

  const errors: Record<string, string> = {};
  const imageDataUrls = await collectVisionImages(clip, req.nextUrl.origin, access.user.id);

  try {
    const prompt = await auditModelApiCall({
      userId: access.user.id,
      callType: "llm",
      providerKey: "openai-compatible",
      channelId: "llm-default",
      channelName: "LLM",
      model: llmConfig.visionModel || llmConfig.model,
      source: "llm.video-prompt.chat",
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    }, () => callChatCompletions(llmConfig, clip, imageDataUrls));
    return NextResponse.json({ prompt, method: "chat/completions" });
  } catch (error) {
    errors.chat = errorMessage(error);
  }

  try {
    const prompt = await auditModelApiCall({
      userId: access.user.id,
      callType: "llm",
      providerKey: "openai-compatible",
      channelId: "llm-default",
      channelName: "LLM",
      model: llmConfig.visionModel || llmConfig.model,
      source: "llm.video-prompt.responses",
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    }, () => callResponses(llmConfig, clip, imageDataUrls));
    return NextResponse.json({ prompt, method: "responses", chatError: errors.chat });
  } catch (error) {
    errors.responses = errorMessage(error);
  }

  return NextResponse.json(
    {
      error: "Failed to generate video prompt with the configured LLM.",
      chatError: errors.chat,
      responsesError: errors.responses,
    },
    { status: 502 }
  );
}
