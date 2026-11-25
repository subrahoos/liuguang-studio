import { mediaExecutable } from "@/lib/runtime-tools";
import { NextRequest, NextResponse } from "next/server";
import { mkdir } from "fs/promises";
import { basename, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createProvider } from "@/lib/providers";
import { composeVideo } from "@/lib/video-composer/composer";
import { formatOmniDurationPlan, isSegmentedVideoModel, splitSegmentedVideoDurations, sumOmniDurations, type SegmentedVideoDuration } from "@/lib/omni-video";
import { compactPromptExcerpt, joinUniqueTextSections, uniqueStrings } from "@/lib/prompt-dedup";
import { readLocalApiImageAsVideoReferenceDataUrl } from "@/lib/video-reference-images";
import { copyProjectFileFromLocal, resolvePublicProjectFilePath, writeProjectFile } from "@/lib/project-local-archive";
import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { resolveVideoChannel, resolveVideoReferenceHosting } from "@/lib/server-model-settings";
import { storagePaths } from "@/lib/storage-root";
import {
  cleanupCloudinaryVideoReferences,
} from "@/lib/cloudinary-video-reference-hosting";
import {
  isLingganyaTemporaryFileReferenceChannel,
  prepareVideoReferencesForChannel,
} from "@/lib/video-reference-transport";

const execFileAsync = promisify(execFile);
const CLONE_VIDEO_REFERENCE_LIMIT = 8;

type CachedCloneVideo = {
  filePath: string;
  publicUrl: string;
  mimeType: string;
};

type OmniSegment = {
  index: number;
  duration: SegmentedVideoDuration;
  start: number;
  end: number;
  prompt: string;
  referenceImageUrls: string[];
  localVideo?: CachedCloneVideo;
};

async function readMediaBytes(url: string): Promise<{ bytes: Buffer; ext: string; mimeType: string }> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("Unsupported data video URL.");
    return {
      bytes: Buffer.from(match[2], "base64"),
      ext: mimeToExt(match[1]),
      mimeType: match[1],
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Generated video download failed: ${response.status} ${response.statusText}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "video/mp4";
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    ext: mimeToExt(mimeType),
    mimeType,
  };
}

function mimeToExt(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("x-matroska")) return "mkv";
  return "mp4";
}

async function cacheCloneVideo(projectId: string, videoUrl: string, versionId?: string | null) {
  const media = await readMediaBytes(videoUrl);
  const fileName = `clone-full-video-${Date.now()}.${media.ext}`;
  const filePath = await writeProjectFile(projectId, "videos", fileName, media.bytes, { versionId });
  return {
    filePath,
    publicUrl: `/api/project/${projectId}/video-clips/file/${encodeURIComponent(fileName)}`,
    mimeType: media.mimeType,
  };
}

function buildOmniSegments(
  prompt: string,
  targetDuration: number,
  referenceImageUrls: string[],
  model: string,
  productReferenceCount = 0
): OmniSegment[] {
  const durations = splitSegmentedVideoDurations(model, targetDuration);
  const providerName = /grok/i.test(model) ? "GROK" : "OMNI";
  let cursor = 0;
  return durations.map((duration, index) => {
    const start = cursor;
    const end = cursor + duration;
    cursor = end;
    const compactFullPrompt = compactPromptExcerpt(prompt, 2600);
    const segmentPrompt = joinUniqueTextSections([
      `${providerName} SEGMENT ${index + 1}/${durations.length}. Duration: ${duration} seconds. This segment is derived from a full-video director prompt that was written first as one complete ${targetDuration}-second video. Follow the global story order, but only generate this time slice. Do not create a complete ending unless this is the final segment.`,
      index === 0
        ? "Continuity in: start from the first-frame anchor and immediately establish the hook."
        : `Continuity in: continue naturally from the previous segment around ${start.toFixed(1)}s; keep the same identity, product, lighting, scene, camera style, and action energy.`,
      index === durations.length - 1
        ? "Continuity out: finish with a complete, stable ending suitable for the final video."
        : "Continuity out: end with motion that can cut directly into the next segment; avoid fade to black, title cards, subtitles, logos, or final CTA closure.",
      buildSegmentMotionRules(duration, providerName),
      buildReferenceRoleGuide(referenceImageUrls.length, productReferenceCount),
      `Relevant full-video director prompt context for this time range (${start.toFixed(1)}s-${end.toFixed(1)}s). This is compacted to avoid repeating the entire long prompt in every segment request:`,
      compactFullPrompt,
    ]);
    return {
      index: index + 1,
      duration,
      start,
      end,
      prompt: segmentPrompt,
    referenceImageUrls: uniqueStrings(referenceImageUrls).slice(0, CLONE_VIDEO_REFERENCE_LIMIT),
    };
  });
}

function buildSegmentMotionRules(duration: number, providerName: string) {
  return [
    "NORMAL ECOMMERCE SHORT-VIDEO MOTION RULES:",
    `This ${providerName} request must generate a normal real-time ecommerce short-video segment, not a cinemagraph, not a slideshow, not a slow-motion animated photo, and not a still image with only hair/fabric shimmer.`,
    `For this ${duration}-second segment, create a visible action arc: start pose for about 1 second, main body/action change through the middle, then a short hold or transition at the end. The subject's body and hands must be the primary motion; camera push-in is only secondary.`,
    "If the full prompt says slow push-in, slow zoom, or gentle camera push without a subject action, reinterpret it as an insufficient instruction: keep only a tiny supporting push-in and add real subject action. Never generate a segment whose main movement is only slow push-in.",
    "The camera plan must name one concrete movement and its limits: locked-off mirror shot, handheld follow, short push-in, pull-out reveal, lateral truck/pan, tilt up/down, rise/lower, small 10-30 degree arc orbit, gentle rotation, fixed close-up, parallax slider move, dolly-in/out, rack focus, foreground reveal, low-angle rise, or overhead-to-eye-level tilt. Avoid generic dynamic camera.",
    "Cinematic camera moves are allowed only if the full prompt asks for brand-ad, magazine, cafe lifestyle, or atmosphere work. If used, preserve product readability and name focus target, foreground object, depth of field, light direction, and movement speed. Do not replace subject action with cinematic camera movement.",
    "For outdoor mirror / storefront-glass selfie, prefer locked mirror framing with handheld micro-jitter, slight lateral drift, short pull-out reveal, or tiny push-in that follows the body. Do not use large orbit movement because it breaks mirror-reflection logic.",
    "Use 2-4 concrete action beats when the segment is 8-10 seconds, or 1-3 action beats when it is 4-6 seconds. Examples: step toward the mirror, rotate from front to three-quarter side, shift weight through hip and knee, look back over shoulder, lift phone slightly, adjust collar/cuff/hem/waist/tie, touch pocket edge, smooth fabric downward, then settle into a readable product pose.",
    "Write movement through the body, not as abstract mood: foot contact, toe pivot, knee bend, hip weight transfer, shoulder/neck follow-through, elbow/wrist path, hand contact with fabric, tiny fabric tension and rebound, hem/cuff sway caused by the hand or body turn. For upper-body garments, never turn the product into a stretched fabric panel or change its length/silhouette.",
    "Outdoor mirror / street OOTD segments should look like a phone-recorded fashion account clip: handheld micro-jitter, mirror or storefront-glass edge, dappled tree shadows moving across pavement, parked car or sidewalk depth behind the model, slight phone compression, imperfect crop, but the product remains sharp and structurally locked.",
    "Do not let the model solve the shot by slowly zooming into the first reference image. The reference images are story anchors; generate real transitions between poses and product interactions while preserving identity, product structure, outfit, scene anchors, and lighting.",
  ].join("\n");
}

function buildReferenceRoleGuide(referenceCount: number, productReferenceCount = 0) {
  if (referenceCount <= 0) return "";
  const productCount = Math.max(0, Math.min(referenceCount, Math.round(productReferenceCount || 0)));
  const productStart = productCount > 0 ? referenceCount - productCount + 1 : 0;
  const supportEnd = productCount > 0 ? productStart - 1 : referenceCount;

  return [
    "REFERENCE IMAGE ROLE RULES:",
    `There are ${referenceCount} reference image(s). Do not average them into a new random design.`,
    "Reference image 1 is the hard first-frame/composition anchor. Start the video from this composition unless it is purely a product cutout.",
    supportEnd >= 2
      ? `Reference images 2-${supportEnd} are supporting pose, action, scene, and continuity references. Use their motion and account-template feeling only; do not inherit conflicting pants, shoes, phone color, body crop, lighting defects, or product mutations.`
      : "Supporting pose/action references are secondary only.",
    productCount > 0
      ? `Reference images ${productStart}-${referenceCount} are product-structure lock references. Use them to preserve collar, sleeve length, fabric texture, pattern, hem, transparency level, and silhouette. Do not treat product cutouts as a scene or as a new outfit pose.`
      : "All reference images are approved image-2 asset frames. Treat the clothing shown in those approved assets as the locked product truth; do not redesign it from text or generic fashion knowledge.",
    productCount > 0
      ? "Priority order: product structure from product references and first-frame garment > first-frame composition > supporting motion/scene references > text prompt style."
      : "Priority order: approved asset garment/product appearance > first-frame composition > supporting motion/scene references > text prompt style.",
    productCount > 0
      ? "PRODUCT MICRO-STRUCTURE PRESERVATION: the product references override any averaged or simplified texture in generated asset frames. Preserve exact neckline trim, sleeve trim, hem trim, openwork holes, lace/crochet/knit density, embroidery or jacquard rhythm, horizontal bands, flecked yarn colors, transparency level, fabric weight, and silhouette. Do not smooth openwork into a plain knit, do not remove colored flecks, do not thicken thin lace into heavy sweater texture, and do not simplify black edge stitching into a generic outline."
      : "PRODUCT MICRO-STRUCTURE PRESERVATION: preserve the approved asset garment texture frame by frame. Do not smooth openwork, lace, crochet, jacquard, flecks, trims, hems, or patterned bands into a generic plain knit or a different fabric.",
    "During motion, fabric can bend, wrinkle slightly, show tiny tension, rebound, and catch light, but the garment structure itself must not be redrawn or stretched into a new shape. If texture confidence is low, keep the product closer to the reference image instead of inventing new material.",
    "VIDEO ANIMATION RULES:",
    "The approved images are not a slideshow order. They are key poses and structure anchors. Animate between them with visible normal-speed body motion, hand-to-fabric interaction, and product display beats.",
    "At least one supporting reference must contribute a body-direction change or hand action. If all references are similar, invent only a small safe action that does not change garment structure: weight shift, side turn, hem adjustment, collar/cuff touch, phone lift, or a short step.",
    "Reject outputs where the only movement is camera push, slight smile, blinking, hair shimmer, or fabric breathing. The finished clip must read as a real short-video take.",
    "OUTFIT / BOTTOM STYLING LOCK:",
    "If the marketed product is an upper-body garment, lower-body items are styling supports, not the product. Choose exactly one bottom styling from the hard first-frame/full-body outfit anchor and keep it unchanged for the whole segment.",
    "Do not switch between shorts, wide-leg trousers, skirts, jeans, different shoes, or different waist details across frames. Supporting pose/action references may show conflicting bottoms; use those images only for pose, gesture, mirror-account feeling, and motion, never for bottom garment inheritance.",
    "If the first reference is an upper-body crop or product cutout and no full-body bottom is visible, use a neutral simple bottom that matches the full-video prompt once, then keep it stable. Do not invent a new bottom every time the body moves.",
    "The lower-body styling must stay visually quiet and secondary so the current product remains the hero. No new belts, bags, logos, printed patterns, or dramatic accessories unless already present in the first-frame anchor.",
    "Reject visible product drift: no missing collar, no fake holes, no chest stains, no random damage, no long sleeves, no changed neckline, no changing from trousers to shorts unless the first-frame anchor explicitly shows shorts.",
  ].join("\n");
}

async function localPublicPathToFilePath(projectId: string, publicUrl: string, versionId?: string | null) {
  const match = publicUrl.match(/\/api\/project\/[^/]+\/video-clips\/file\/([^/?#]+)/);
  if (!match) return publicUrl;
  return await resolvePublicProjectFilePath(projectId, publicUrl, "videos", versionId)
    ?? storagePaths.projects("_legacy", "videos", projectId, basename(decodeURIComponent(match[1])));
}

async function copyComposedVideoToVideoFolder(projectId: string, composedPath: string, versionId?: string | null): Promise<CachedCloneVideo> {
  const fileName = `clone-full-video-omni-${Date.now()}.mp4`;
  const filePath = await copyProjectFileFromLocal(projectId, "videos", fileName, composedPath, { versionId });
  return {
    filePath,
    publicUrl: `/api/project/${projectId}/video-clips/file/${encodeURIComponent(fileName)}`,
    mimeType: "video/mp4",
  };
}

function ffmpegExecutable() {
  return mediaExecutable("ffmpeg");
}

async function trimVideoToDuration(projectId: string, inputPath: string, duration: number, versionId?: string | null): Promise<CachedCloneVideo> {
  const dir = storagePaths.tmp("trimmed-videos", projectId);
  await mkdir(dir, { recursive: true });
  const fileName = `clone-full-video-omni-${Date.now()}.mp4`;
  const filePath = join(dir, fileName);
  await execFileAsync(ffmpegExecutable(), [
    "-y",
    "-i",
    inputPath,
    "-t",
    String(Math.max(1, duration)),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    filePath,
  ], { maxBuffer: 50 * 1024 * 1024 });
  const storedPath = await copyProjectFileFromLocal(projectId, "videos", fileName, filePath, { versionId });
  return {
    filePath: storedPath,
    publicUrl: `/api/project/${projectId}/video-clips/file/${encodeURIComponent(fileName)}`,
    mimeType: "video/mp4",
  };
}

async function normalizeReferenceImageUrl(req: NextRequest, ownerId: string, url?: string): Promise<string | undefined> {
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      projectId,
      versionId,
      prompt,
      negativePrompt,
      model,
      apiKey,
      baseUrl,
      videoSubmitPath,
      videoStatusPath,
      videoContentPath,
      duration,
      aspectRatio,
      resolution,
      referenceImageUrl,
      referenceImageUrls,
      options,
    } = body as {
      projectId?: string;
      versionId?: string;
      prompt?: string;
      negativePrompt?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      videoSubmitPath?: string;
      videoStatusPath?: string;
      videoContentPath?: string;
      duration?: number;
      aspectRatio?: "9:16" | "16:9" | "1:1";
      resolution?: "720p" | "1080p";
      referenceImageUrl?: string;
      referenceImageUrls?: string[];
      options?: Record<string, unknown>;
    };

    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return NextResponse.json({ error: "Missing or invalid projectId." }, { status: 400 });
    }
    const projectAccess = await getOwnedProjectAccess(req, projectId);
    if (!projectAccess) {
      return NextResponse.json({ error: "未登录或无权访问该项目。" }, { status: 401 });
    }
    if (!prompt?.trim()) {
      return NextResponse.json({ error: "Missing full-video prompt." }, { status: 400 });
    }
    const requestedVideoChannelId = typeof body.videoChannelId === "string"
      ? body.videoChannelId.trim()
      : "";
    if (!requestedVideoChannelId) {
      return NextResponse.json({ error: "完整视频生成必须明确指定 videoChannelId，不能回退到默认通道。" }, { status: 409 });
    }
    const resolvedChannel = await resolveVideoChannel(req, {
      id: requestedVideoChannelId,
      name: "Request video channel",
      apiKey: apiKey || "",
      baseUrl: baseUrl || "",
      model: model || "",
      submitPath: videoSubmitPath,
      statusPath: videoStatusPath,
      contentPath: videoContentPath,
    }, requestedVideoChannelId, "full_video");
    if (!resolvedChannel || resolvedChannel.id !== requestedVideoChannelId) {
      return NextResponse.json({ error: "所选视频通道已不可用，不能改用其他通道继续任务。" }, { status: 409 });
    }
    if (!resolvedChannel?.apiKey || !resolvedChannel.baseUrl || !resolvedChannel.model) {
      return NextResponse.json({ error: "Missing full-video API key, base URL, or model." }, { status: 400 });
    }
    const effectiveModel = resolvedChannel.model;

    const dimensions = aspectRatio === "16:9"
      ? { width: resolution === "1080p" ? 1920 : 1280, height: resolution === "1080p" ? 1080 : 720 }
      : aspectRatio === "1:1"
        ? { width: resolution === "1080p" ? 1080 : 720, height: resolution === "1080p" ? 1080 : 720 }
        : { width: resolution === "1080p" ? 1080 : 720, height: resolution === "1080p" ? 1920 : 1280 };

    const normalizedReferenceImageUrl = await normalizeReferenceImageUrl(req, projectAccess.user.id, referenceImageUrl);
    const normalizedReferenceImageUrls = await Promise.all(
      (Array.isArray(referenceImageUrls) ? referenceImageUrls : [])
        .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
        .map((url) => normalizeReferenceImageUrl(req, projectAccess.user.id, url))
    );
    const referenceImageSources = uniqueStrings([
      normalizedReferenceImageUrl,
      ...normalizedReferenceImageUrls,
    ]);
    const usesLingganyaFiles = isLingganyaTemporaryFileReferenceChannel(resolvedChannel);
    const referenceHosting = usesLingganyaFiles ? undefined : await resolveVideoReferenceHosting(req);
    const hostedReferences = await prepareVideoReferencesForChannel({
      channel: resolvedChannel,
      sources: referenceImageSources,
      setting: referenceHosting,
      ownerId: projectAccess.user.id,
      scopeId: projectId,
      mediaType: "image",
    });
    const allReferenceImageUrls = hostedReferences.urls;
    const cleanupHostedReferences = async () => {
      if (hostedReferences.assets.length === 0 || !referenceHosting) {
        return undefined;
      }
      return cleanupCloudinaryVideoReferences(referenceHosting, hostedReferences.assets);
    };

    const provider = createProvider({
      name: "openai-seedance",
      apiKey: resolvedChannel.apiKey,
      baseUrl: resolvedChannel.baseUrl,
      extra: {
        videoApiKey: resolvedChannel.apiKey,
        videoBaseUrl: resolvedChannel.baseUrl,
        videoSubmitPath: resolvedChannel.submitPath,
        videoStatusPath: resolvedChannel.statusPath,
        videoContentPath: resolvedChannel.contentPath,
        lingganyaSd20Vip: usesLingganyaFiles && effectiveModel.trim().toLowerCase() === "sd-2.0-vip",
        lingganyaSd20G: usesLingganyaFiles && effectiveModel.trim().toLowerCase() === "sd-2.0-g",
        lingganyaSd20Mini: usesLingganyaFiles && effectiveModel.trim().toLowerCase() === "sd-2.0-mini",
      },
      audit: {
        userId: projectAccess.user.id,
        callType: "video",
        providerKey: "openai-seedance",
        channelId: resolvedChannel.id,
        channelName: resolvedChannel.name,
        model: effectiveModel,
        source: "clone.generate-full-video",
        projectId,
      },
    });

    const isSegmentedModel = isSegmentedVideoModel(effectiveModel);
    if (isSegmentedModel) {
      const targetDuration = Math.max(4, Math.round(duration || 10));
      const productReferenceCount = Number((options ?? {}).productReferenceCount);
      const segments = buildOmniSegments(
        prompt,
        targetDuration,
        allReferenceImageUrls.slice(0, CLONE_VIDEO_REFERENCE_LIMIT),
        effectiveModel,
        Number.isFinite(productReferenceCount) ? productReferenceCount : 0
      );
      const requestedSegmentIndex = Number((options ?? {}).segmentIndex);
      if (Number.isFinite(requestedSegmentIndex) && requestedSegmentIndex > 0) {
        const segment = segments.find((item) => item.index === Math.round(requestedSegmentIndex));
        if (!segment) {
          return NextResponse.json({ error: `Segment ${requestedSegmentIndex} is not available for this duration plan.` }, { status: 400 });
        }

        const segmentResult = await provider.generateVideo({
          modelId: effectiveModel,
          mode: allReferenceImageUrls.length ? "image-to-video" : "text-to-video",
          prompt: segment.prompt,
          negativePrompt,
          firstFrameUrl: allReferenceImageUrls[0],
          referenceImageUrls: allReferenceImageUrls.slice(0, CLONE_VIDEO_REFERENCE_LIMIT),
          duration: segment.duration,
          width: dimensions.width,
          height: dimensions.height,
          extra: {
            aspect_ratio: aspectRatio,
            resolution,
            ...(options ?? {}),
            segmentedVideoModel: effectiveModel,
            segmentIndex: segment.index,
            segmentCount: segments.length,
          },
        });

        const cachedVideos = await Promise.all(
          segmentResult.videoUrls.map((url) => cacheCloneVideo(projectId, url, versionId).catch((error) => {
            console.warn("Cache single segmented full-video clip failed:", error);
            return null;
          }))
        );
        const referenceCleanup = await cleanupHostedReferences();

        return NextResponse.json({
          ...segmentResult,
          localVideos: cachedVideos.filter(Boolean),
          duration: segment.duration,
          extra: {
            mode: "single_segment_full_video",
            targetDuration,
            segmentIndex: segment.index,
            segmentCount: segments.length,
            segmentDuration: segment.duration,
            start: segment.start,
            end: segment.end,
            durationPlan: formatOmniDurationPlan(segments.map((item) => item.duration)),
            referenceImageCount: allReferenceImageUrls.slice(0, CLONE_VIDEO_REFERENCE_LIMIT).length,
            referenceTransport: hostedReferences.transport,
            ...(hostedReferences.uploadCount > 0 ? { referenceUploadCount: hostedReferences.uploadCount } : {}),
            ...(hostedReferences.expiresAt ? { referenceExpiresAt: hostedReferences.expiresAt } : {}),
            ...(referenceCleanup ? { referenceCleanup } : {}),
          },
        });
      }
      const generatedSegments: OmniSegment[] = [];

      for (const segment of segments) {
        const segmentResult = await provider.generateVideo({
          modelId: effectiveModel,
          mode: segment.referenceImageUrls.length ? "image-to-video" : "text-to-video",
          prompt: segment.prompt,
          negativePrompt,
          firstFrameUrl: segment.referenceImageUrls[0],
          referenceImageUrls: segment.referenceImageUrls,
          duration: segment.duration,
          width: dimensions.width,
          height: dimensions.height,
          extra: {
            aspect_ratio: aspectRatio,
            resolution,
            ...(options ?? {}),
            segmentedVideoModel: effectiveModel,
            segmentIndex: segment.index,
            segmentCount: segments.length,
          },
        });

        const cached = await Promise.all(
          segmentResult.videoUrls.map((url) => cacheCloneVideo(projectId, url, versionId).catch((error) => {
            console.warn("Cache segmented full-video clip failed:", error);
            return null;
          }))
        );
        const localVideo = cached.find(Boolean) as CachedCloneVideo | undefined;
        if (!localVideo) {
          throw new Error(`Segment ${segment.index} generated but no video could be downloaded locally.`);
        }
        generatedSegments.push({ ...segment, localVideo });
      }

      const composedPath = await composeVideo({
        projectId,
        clips: await Promise.all(generatedSegments.map(async (segment) => ({
          type: "video" as const,
          filePath: await localPublicPathToFilePath(projectId, segment.localVideo!.publicUrl, versionId),
          duration: segment.duration,
          transition: "direct_concat",
          hasAudio: false,
        }))),
        output: {
          resolution: resolution ?? "720p",
          aspectRatio: aspectRatio ?? "9:16",
        },
      });
      if (!composedPath) {
        throw new Error("Segmented full-video clips generated, but local composition did not return an output file.");
      }

      const segmentDurations = generatedSegments.map((segment) => segment.duration);
      const generatedDuration = sumOmniDurations(segmentDurations);
      const finalVideo = generatedDuration > targetDuration
        ? await trimVideoToDuration(projectId, composedPath, targetDuration, versionId)
        : await copyComposedVideoToVideoFolder(projectId, composedPath, versionId);
      const referenceCleanup = await cleanupHostedReferences();

      return NextResponse.json({
        taskId: `segmented-full-video-${Date.now()}`,
        videoUrls: [finalVideo.publicUrl],
        localVideos: [finalVideo],
        modelId: effectiveModel,
        duration: targetDuration,
        extra: {
          mode: "segmented_full_video",
          requestedDuration: duration,
          finalDuration: targetDuration,
          generatedDuration,
          trimmed: generatedDuration > targetDuration,
          durationPlan: formatOmniDurationPlan(segmentDurations),
          segmentDurations,
          referenceTransport: hostedReferences.transport,
          ...(hostedReferences.uploadCount > 0 ? { referenceUploadCount: hostedReferences.uploadCount } : {}),
          ...(hostedReferences.expiresAt ? { referenceExpiresAt: hostedReferences.expiresAt } : {}),
          ...(referenceCleanup ? { referenceCleanup } : {}),
          segments: generatedSegments.map((segment) => ({
            index: segment.index,
            duration: segment.duration,
            start: segment.start,
            end: segment.end,
            referenceImageCount: segment.referenceImageUrls.length,
            localVideo: segment.localVideo,
          })),
        },
      });
    }

    const result = await provider.generateVideo({
      modelId: effectiveModel,
      mode: allReferenceImageUrls.length ? "image-to-video" : "text-to-video",
      prompt: joinUniqueTextSections([
        buildReferenceRoleGuide(allReferenceImageUrls.length, Number((options ?? {}).productReferenceCount)),
        prompt,
      ]),
      negativePrompt,
      firstFrameUrl: allReferenceImageUrls[0],
      referenceImageUrls: allReferenceImageUrls,
      duration,
      width: dimensions.width,
      height: dimensions.height,
      extra: {
        aspect_ratio: aspectRatio,
        resolution,
        ...options,
      },
    });

    const cachedVideos = await Promise.all(
      result.videoUrls.map((url) => cacheCloneVideo(projectId, url, versionId).catch((error) => {
        console.warn("Cache clone video failed:", error);
        return null;
      }))
    );
    const referenceCleanup = await cleanupHostedReferences();

    return NextResponse.json({
      ...result,
      localVideos: cachedVideos.filter(Boolean),
      extra: {
        ...(result.extra ?? {}),
        referenceTransport: hostedReferences.transport,
        ...(hostedReferences.uploadCount > 0 ? { referenceUploadCount: hostedReferences.uploadCount } : {}),
        ...(hostedReferences.expiresAt ? { referenceExpiresAt: hostedReferences.expiresAt } : {}),
        ...(referenceCleanup ? { referenceCleanup } : {}),
      },
    });
  } catch (error) {
    console.error("clone full-video generation failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Clone full-video generation failed." },
      { status: 500 }
    );
  }
}
