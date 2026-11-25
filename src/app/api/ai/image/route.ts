import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { writeProjectFile } from "@/lib/project-local-archive";
import { uniqueStrings } from "@/lib/prompt-dedup";
import { resolveImageChannel } from "@/lib/server-model-settings";
import { canAccessOptionalProject } from "@/lib/server/resource-access";
import { prepareImageEditReferenceUrl } from "@/lib/image-edit-reference";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { provider: providerName, prompt, imageUrl, imageUrls, mode, options, projectId, versionId, shotId } = body;

  const access = await canAccessOptionalProject(req, projectId);
  if (!access) return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });

  if (!providerName || !prompt) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
  }

  try {
    const channelId = typeof body.imageChannelId === "string" ? body.imageChannelId : undefined;
    const resolvedChannel = await resolveImageChannel(req, undefined, channelId);
    if (!resolvedChannel || (channelId && resolvedChannel.id !== channelId)) {
      return NextResponse.json({ error: "未找到已启用的生图通道" }, { status: 409 });
    }
    if (!resolvedChannel.apiKey || !resolvedChannel.baseUrl || !resolvedChannel.model) {
      return NextResponse.json({ error: "当前账户尚未配置该生图通道的 Key，或通道配置不完整" }, { status: 400 });
    }
    const resolvedApiKey = resolvedChannel.apiKey;
    const resolvedBaseUrl = resolvedChannel.baseUrl;
    const resolvedModel = resolvedChannel.model;
    const effectiveBaseUrl = resolvedBaseUrl;
    const baseHost = (() => {
      try {
        return effectiveBaseUrl ? new URL(effectiveBaseUrl).host : "";
      } catch {
        return effectiveBaseUrl.replace(/\/.*$/, "");
      }
    })();
    const requestedCount = Number(options?.count ?? 1);
    const referenceCount = [
      imageUrl,
      ...(Array.isArray(imageUrls) ? imageUrls : []),
    ].filter(Boolean).length;
    console.info("[image-generate] request", {
      provider: providerName,
      model: resolvedModel,
      baseHost,
      mode: mode || "text-to-image",
      requestedCount,
      promptChars: typeof prompt === "string" ? prompt.length : 0,
      referenceCount,
      projectId,
      versionId,
      shotId,
    });

    const provider = createProvider({
      name: providerName,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      timeout: resolvedChannel?.requestTimeoutMs,
      extra: {
        imageApiKey: resolvedApiKey,
        imageBaseUrl: resolvedBaseUrl,
      },
      audit: {
        userId: access.user.id,
        callType: "image",
        providerKey: providerName,
        channelId: resolvedChannel.id,
        channelName: resolvedChannel.name,
        model: resolvedModel,
        source: "ai.image.generate",
        projectId: typeof projectId === "string" ? projectId : undefined,
      },
    });

    const normalizedImageUrl = normalizeImageUrl(req, imageUrl);
    const normalizedImageUrls = uniqueStrings([
      normalizedImageUrl,
      ...(normalizeImageUrls(req, imageUrls) ?? []),
    ]);

    const preparedImageUrls = await Promise.all(
      normalizedImageUrls.map((url) => prepareImageEditReferenceUrl(url, { ownerId: access.user.id }))
    );

    const result = await provider.generateImage({
      modelId: resolvedModel,
      mode: mode || "text-to-image",
      prompt,
      referenceImageUrl: preparedImageUrls[0],
      referenceImageUrls: preparedImageUrls.length > 0 ? preparedImageUrls : undefined,
      ...options,
    });
    const cachedImageUrls = await cacheProjectImages(result.imageUrls, projectId, shotId, versionId);
    console.info("[image-generate] response", {
      provider: providerName,
      model: resolvedModel,
      baseHost,
      requestedCount,
      returnedCount: result.imageUrls.length,
      cachedCount: cachedImageUrls.length,
      projectId,
      versionId,
      shotId,
    });
    return NextResponse.json({
      ...result,
      imageUrls: cachedImageUrls,
      extra: {
        ...(result.extra ?? {}),
        originalImageUrls: result.imageUrls,
        cachedLocally: cachedImageUrls.some((url) => url.startsWith("/api/files/")),
      },
    });
  } catch (error) {
    console.error("Image generation failed:", error);
    if (error instanceof ProviderError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          provider: error.provider,
          statusCode: error.statusCode,
        },
        { status: error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Image generation failed" },
      { status: 500 }
    );
  }
}

async function cacheProjectImages(imageUrls: string[], projectId?: unknown, shotId?: unknown, versionId?: unknown): Promise<string[]> {
  if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    return imageUrls;
  }

  const shotLabel = typeof shotId === "number" || typeof shotId === "string"
    ? String(shotId).replace(/[^a-zA-Z0-9_-]/g, "")
    : "unknown";

  const cached = await Promise.all(imageUrls.map(async (url, index) => {
    try {
      const image = await readImageBytes(url);
      const fileName = `ai-shot-${shotLabel}-${Date.now()}-${index + 1}.${image.ext}`;
      await writeProjectFile(projectId, "assets", fileName, image.bytes, {
        versionId: typeof versionId === "string" ? versionId : null,
      });
      return `/api/files/${projectId}/${fileName}`;
    } catch (error) {
      console.warn("Cache generated image failed:", error);
      return url;
    }
  }));

  return cached;
}

async function readImageBytes(url: string): Promise<{ bytes: Buffer; ext: string }> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("Unsupported data image URL");
    return {
      bytes: Buffer.from(match[2], "base64"),
      ext: mimeToExt(match[1]),
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Generated image download failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    ext: mimeToExt(contentType),
  };
}

function mimeToExt(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

function normalizeImageUrl(req: NextRequest, imageUrl?: string): string | undefined {
  if (!imageUrl) return undefined;
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://") || imageUrl.startsWith("data:")) {
    return imageUrl;
  }
  if (imageUrl.startsWith("/")) {
    return `${req.nextUrl.origin}${imageUrl}`;
  }
  return imageUrl;
}

function normalizeImageUrls(req: NextRequest, imageUrls?: unknown): string[] | undefined {
  if (!Array.isArray(imageUrls)) return undefined;
  const normalized = imageUrls
    .map((url) => typeof url === "string" ? normalizeImageUrl(req, url) : undefined)
    .filter((url): url is string => Boolean(url));
  return normalized.length > 0 ? normalized : undefined;
}
