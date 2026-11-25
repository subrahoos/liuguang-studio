import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { writeProjectFile } from "@/lib/project-local-archive";
import { prepareImageEditReferenceUrl } from "@/lib/image-edit-reference";
import { joinUniqueTextSections, uniqueStrings } from "@/lib/prompt-dedup";
import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { resolveImageChannel } from "@/lib/server-model-settings";
import { storagePaths } from "@/lib/storage-root";

export const runtime = "nodejs";

interface AssetPrompt {
  assetName?: string;
  purpose?: string;
  promptEnglish?: string;
  referencePriority?: string;
  assetRole?: string;
  segmentIndex?: number;
  segmentTimeRange?: string;
  segmentStoryPurpose?: string;
}

function normalizeUrl(req: NextRequest, url: string) {
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  if (url.startsWith("/")) return `${req.nextUrl.origin}${url}`;
  return url;
}

function safeFileLabel(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "asset";
}

function buildImage2ExecutionContract(asset: AssetPrompt) {
  return [
    "IMAGE-2 EXECUTION CONTRACT:",
    "Use this as a concrete video-reference keyframe, not a generic beauty still. The prompt must be interpreted as pixels, composition, and action state.",
    "If any part of the prompt is vague, make it concrete without changing the product: specify the scene container, foreground/midground/background anchors, light direction and light texture, camera distance, crop, lens feel, body angle, hand contact point, facial/phone/gaze state, visible product structures, and negative constraints.",
    "Match the asset role and segment purpose. Full-body proof assets should show the whole outfit/product-on-body and scene anchors. Detail assets should show the exact collar/cuff/hem/fabric/hand interaction. Motion transition assets should show a caught-in-motion body direction, weight shift, hand path, and fabric tension or rebound.",
    "Human anatomy safety: if a person appears, generate one natural adult with exactly two arms and two hands. Use one simple non-overlapping hand action only. In mirror/selfie shots, one hand may hold the phone and the other may touch one product detail. Avoid crossed arms, both hands reaching across the torso, hidden elbows, overlapping forearms, ambiguous reflected limbs, extra arms, extra hands, fused fingers, twisted wrists, or duplicated limbs.",
    "Do not create text, subtitles, app UI, status bar, progress bar, watermark, logo, price tag, random labels, collage, split screen, poster layout, or a clean catalog product still unless explicitly requested.",
    asset.assetRole ? `Asset role: ${asset.assetRole}` : "",
    asset.segmentTimeRange ? `Segment time range: ${asset.segmentTimeRange}` : "",
    asset.segmentStoryPurpose ? `Segment story purpose: ${asset.segmentStoryPurpose}` : "",
  ].filter(Boolean).join("\n");
}

async function readImageBytes(url: string): Promise<{ bytes: Buffer; ext: string }> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("Unsupported data image URL");
    return { bytes: Buffer.from(match[2], "base64"), ext: mimeToExt(match[1]) };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Generated asset download failed: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  return { bytes: Buffer.from(await response.arrayBuffer()), ext: mimeToExt(contentType) };
}

function mimeToExt(mimeType: string) {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

async function cacheAsset(projectId: string, url: string, label: string, versionId?: string | null) {
  const image = await readImageBytes(url);
  const fileName = `clone-asset-${safeFileLabel(label)}-${Date.now()}.${image.ext}`;
  await writeProjectFile(projectId, "assets", fileName, image.bytes, { versionId });
  return `/api/files/${projectId}/${fileName}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      projectId,
      versionId,
      provider,
      imageChannelId,
      productImages,
      identityImages,
      assetPrompts,
      maxAssets,
    } = body as {
      projectId?: string;
      versionId?: string;
      provider?: string;
      imageChannelId?: string;
      productImages?: string[];
      identityImages?: string[];
      assetPrompts?: AssetPrompt[];
      maxAssets?: number;
    };

    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return NextResponse.json({ error: "Missing or invalid projectId." }, { status: 400 });
    }
    const access = await getOwnedProjectAccess(req, projectId);
    if (!access) {
      return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
    }
    const resolvedChannel = await resolveImageChannel(req, undefined, imageChannelId);
    if (!provider || !resolvedChannel?.model || !resolvedChannel.apiKey || !resolvedChannel.baseUrl) {
      return NextResponse.json({ error: "Missing image-2 provider config." }, { status: 400 });
    }
    if (!Array.isArray(assetPrompts) || assetPrompts.length === 0) {
      return NextResponse.json({ error: "Missing image-2 asset prompts." }, { status: 400 });
    }

    const imageProvider = createProvider({
      name: provider,
      apiKey: resolvedChannel.apiKey,
      baseUrl: resolvedChannel.baseUrl,
      timeout: resolvedChannel.requestTimeoutMs,
      extra: { imageApiKey: resolvedChannel.apiKey, imageBaseUrl: resolvedChannel.baseUrl },
      audit: {
        userId: access.user.id,
        callType: "image",
        providerKey: provider,
        channelId: resolvedChannel.id,
        channelName: resolvedChannel.name,
        model: resolvedChannel.model,
        source: "clone.generate-assets",
        projectId,
      },
    });

    const productRefs = (productImages || []).map((url) => normalizeUrl(req, url));
    const preparedProductRefs = await Promise.all(productRefs
      .map((url) => prepareImageEditReferenceUrl(url, { ownerId: access.user.id })));
    const identityRefs = await Promise.all((identityImages || [])
      .map((url) => normalizeUrl(req, url))
      .map((url) => prepareImageEditReferenceUrl(url, { ownerId: access.user.id })));
    const limit = Math.max(1, Math.min(Number(maxAssets || 8), 16));
    const selectedPrompts = assetPrompts.slice(0, limit);
    const generatedAssets = [];

    for (const [index, asset] of selectedPrompts.entries()) {
      const prompt = joinUniqueTextSections([
        String(asset.promptEnglish || "").trim(),
        buildImage2ExecutionContract(asset),
        "PROJECT OUTFIT CONSISTENCY RULE: If the current product is an upper-body garment, keep one stable lower-body styling across every generated asset for this project. Pants, skirt, shoes, bag, belt, and other styling items are secondary supports, not product structure. Do not switch between shorts, wide-leg trousers, skirts, jeans, or different shoes across assets unless the user explicitly requested outfit changes. Keep the current product as the hero.",
      ]);
      if (!prompt) continue;
      const priority = String(asset.referencePriority || "").toLowerCase();
      const referenceImageUrls = uniqueStrings(priority.includes("identity")
        ? [...identityRefs, ...preparedProductRefs]
        : priority.includes("scene")
          ? [...preparedProductRefs, ...identityRefs]
          : [...preparedProductRefs, ...identityRefs]);

      const result = await imageProvider.generateImage({
        modelId: resolvedChannel.model,
        mode: referenceImageUrls.length ? "image-to-image" : "text-to-image",
        prompt,
        referenceImageUrls,
      });

      const cachedUrls = [];
      for (const [urlIndex, url] of result.imageUrls.entries()) {
        cachedUrls.push(await cacheAsset(projectId, url, `${index + 1}-${asset.assetName || urlIndex + 1}`, versionId));
      }

      const generated = {
        assetName: asset.assetName || `asset-${index + 1}`,
        purpose: asset.purpose || "",
        promptEnglish: prompt,
        referencePriority: asset.referencePriority || "",
        imageUrls: cachedUrls,
        identityReferenceUsed: referenceImageUrls.some((url) => identityRefs.includes(url)),
      };
      generatedAssets.push(generated);
    }

    const manifestDir = storagePaths.clone("assets", projectId);
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, `assets-${Date.now()}.json`);
    await writeFile(manifestPath, JSON.stringify(generatedAssets, null, 2), "utf8");

    return NextResponse.json({ assets: generatedAssets, manifestPath });
  } catch (error) {
    console.error("clone asset generation failed:", error);
    if (error instanceof ProviderError) {
      return NextResponse.json(
        { error: error.message, code: error.code, provider: error.provider, statusCode: error.statusCode },
        { status: error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Clone asset generation failed." },
      { status: 500 }
    );
  }
}
