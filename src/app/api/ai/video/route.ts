import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { readLocalApiImageAsVideoReferenceDataUrl } from "@/lib/video-reference-images";
import { uniqueStrings } from "@/lib/prompt-dedup";
import { resolveVideoChannel, resolveVideoReferenceHosting } from "@/lib/server-model-settings";
import { canAccessOptionalProject } from "@/lib/server/resource-access";
import {
  cleanupCloudinaryVideoReferences,
} from "@/lib/cloudinary-video-reference-hosting";
import {
  isLingganyaTemporaryFileReferenceChannel,
  prepareVideoReferencesForChannel,
} from "@/lib/video-reference-transport";

// AI video generation.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const access = await canAccessOptionalProject(req, body.projectId);
  if (!access) return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
  const {
    provider: providerName,
    prompt,
    imageUrl,
    imageUrls,
    images,
    referenceImageUrls,
    mode,
    options,
  } = body;

  if (!providerName) {
    return NextResponse.json({ error: "Missing required video provider or model." }, { status: 400 });
  }

  try {
    const channelId = typeof body.videoChannelId === "string" ? body.videoChannelId : undefined;
    if (!channelId?.trim()) {
      return NextResponse.json({ error: "视频生成必须明确指定 videoChannelId，不能回退到默认通道。" }, { status: 409 });
    }
    const taskType = body.taskType === "shot_clip" ? "shot_clip" : "full_video";
    const resolvedChannel = await resolveVideoChannel(req, undefined, channelId, taskType);
    if (!resolvedChannel || (channelId && resolvedChannel.id !== channelId)) {
      return NextResponse.json({ error: "未找到已启用的视频通道" }, { status: 409 });
    }
    if (!resolvedChannel.apiKey || !resolvedChannel.baseUrl || !resolvedChannel.model) {
      return NextResponse.json({ error: "当前账户尚未配置该视频通道的 Key，或通道配置不完整" }, { status: 400 });
    }
    const resolvedApiKey = resolvedChannel.apiKey;
    const resolvedBaseUrl = resolvedChannel.baseUrl;
    const resolvedModel = resolvedChannel.model;
    const usesLingganyaFiles = isLingganyaTemporaryFileReferenceChannel(resolvedChannel);
    const provider = createProvider({
      name: providerName,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      extra: {
        videoApiKey: resolvedApiKey,
        videoBaseUrl: resolvedBaseUrl,
        videoSubmitPath: resolvedChannel.submitPath,
        videoStatusPath: resolvedChannel.statusPath,
        videoContentPath: resolvedChannel.contentPath,
        lingganyaSd20Vip: usesLingganyaFiles && resolvedModel.trim().toLowerCase() === "sd-2.0-vip",
        lingganyaSd20G: usesLingganyaFiles && resolvedModel.trim().toLowerCase() === "sd-2.0-g",
        lingganyaSd20Mini: usesLingganyaFiles && resolvedModel.trim().toLowerCase() === "sd-2.0-mini",
      },
      audit: {
        userId: access.user.id,
        callType: "video",
        providerKey: providerName,
        channelId: resolvedChannel.id,
        channelName: resolvedChannel.name,
        model: resolvedModel,
        source: "ai.video.generate",
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
      },
    });

    const rawReferenceImages = Array.isArray(referenceImageUrls)
      ? referenceImageUrls
      : Array.isArray(imageUrls)
        ? imageUrls
        : Array.isArray(images)
          ? images
          : [];
    const normalizedReferenceImages = await Promise.all(
      rawReferenceImages
        .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
        .map((url) => normalizeMediaUrl(req, url, access.user.id))
    );
    const firstFrameUrl = await normalizeMediaUrl(req, imageUrl, access.user.id);
    const allReferenceImages = uniqueStrings([
      firstFrameUrl,
      ...normalizedReferenceImages,
    ]);
    const referenceHosting = usesLingganyaFiles ? undefined : await resolveVideoReferenceHosting(req);
    const hostedReferences = await prepareVideoReferencesForChannel({
      channel: resolvedChannel,
      sources: allReferenceImages,
      setting: referenceHosting,
      ownerId: access.user.id,
      scopeId: typeof body.projectId === "string" ? body.projectId : "direct-video",
      mediaType: "image",
    });

    const result = await provider.generateVideo({
      // Keep caller options for documented per-task controls, but put the
      // resolved channel identity and hosted references last so stale browser
      // state cannot switch the model or reference payload.
      ...options,
      modelId: resolvedModel,
      mode: mode || (hostedReferences.urls.length ? "image-to-video" : "text-to-video"),
      prompt: prompt || "",
      firstFrameUrl: hostedReferences.urls[0],
      referenceImageUrls: hostedReferences.urls,
    });
    const cleanup = hostedReferences.assets.length > 0 && referenceHosting
      ? await cleanupCloudinaryVideoReferences(referenceHosting, hostedReferences.assets)
      : undefined;

    return NextResponse.json({
      ...result,
      extra: {
        ...(result.extra ?? {}),
        referenceTransport: hostedReferences.transport,
        ...(hostedReferences.uploadCount > 0 ? { referenceUploadCount: hostedReferences.uploadCount } : {}),
        ...(hostedReferences.expiresAt ? { referenceExpiresAt: hostedReferences.expiresAt } : {}),
        ...(cleanup ? { referenceCleanup: cleanup } : {}),
      },
    });
  } catch (error) {
    console.error("generate video failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video generation failed" },
      { status: 500 }
    );
  }
}

async function normalizeMediaUrl(req: NextRequest, url?: string, ownerId?: string): Promise<string | undefined> {
  if (!url) return undefined;
  if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("\\\\")) {
    throw new Error("Video reference images must be HTTPS URLs, data URI, or uploaded project files; Windows local paths cannot be sent to the video API.");
  }
  const localFile = await readLocalApiImageAsVideoReferenceDataUrl(url, ownerId);
  if (localFile) return localFile;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  if (url.startsWith("/")) {
    return `${req.nextUrl.origin}${url}`;
  }
  return url;
}
