import "server-only";

import { readFile, writeFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createProvider } from "@/lib/providers";
import { parseDataUrl, type BoardWorkflowNode } from "@/lib/board-workflows";
import { buildCanonicalBoardImageTask } from "@/lib/board-image-task-contract";
import { imageDimensionsForPreset } from "@/lib/image-output-size";
import { detailImageOutputSizeForSource } from "@/lib/board-detail-image-batches";
import { resolveGlobalImageChannel, resolveGlobalVideoChannel, resolveGlobalVideoReferenceHosting, resolveGlobalVideoReferenceHostingCredentials } from "@/lib/model-pool";
import { resolveUserVideoReferenceHostingCredentials } from "@/lib/user-video-reference-hosting-credentials";
import { sqlite } from "@/lib/db";
import { auditModelApiCall } from "@/lib/model-api-audit";
import {
  getProductProductionTask,
  prepareProductProductionRetry,
  productProductionAsset,
  productProductionAssetPath,
  productProductionContentSelection,
  productProductionFileUrl,
  productProductionOutputDirectory,
  productProductionTaskRoot,
  updateProductProductionTask,
  type ProductProductionAsset,
  type ProductProductionJob,
  type ProductProductionTask,
} from "@/lib/product-production";
import { getBoardVideoProfile } from "@/lib/board-video-protocol";
import { bindDirectVideoReplacementMediaAliases, buildDirectVideoReplacementPrompt } from "@/lib/video-reference-contract";
import { encodeAudioFileForVideoReference, encodeImageFileForVideoReference, encodeVideoFileForVideoReference } from "@/lib/video-reference-images";
import { isLingganyaTemporaryFileReferenceChannel, prepareVideoReferencesForChannel } from "@/lib/video-reference-transport";
import { cleanupCloudinaryVideoReferences, isReadyVideoReferenceHosting, type HostedVideoReference } from "@/lib/cloudinary-video-reference-hosting";
import {
  assertBoardVideoPromptWithinLimit,
  downloadRjmusGrokVideo,
  getRjmusGrokVideoStatus,
  isTransientVideoPollInterruption,
  RjmusGrokVideoError,
  submitRjmusGrokVideo,
  verifyRjmusGrokVideoChannel,
} from "@/lib/rjmus-grok-video";
import { probeStillImageMedia, probeVideoMedia } from "@/lib/video-media-probe";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";
import { createBoundedOwnerScheduler } from "@/lib/product-production-scheduler";
import { productionStatus, isDefiniteSubmissionRejection } from "@/lib/product-production-state";
import { validateBoardVideoOutput } from "@/lib/board-video-output-contract";
import type { VideoModelChannel, ImageModelChannel } from "@/lib/stores/settings-store";
import { featureEntriesForUser } from "@/lib/workspace-feature-entries";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requireReadableAsset(task: ProductProductionTask, assetId: string | undefined, label: string) {
  const asset = productProductionAsset(task, assetId);
  if (!asset) throw new Error(`${label}不存在，请重新上传。`);
  const info = await stat(productProductionAssetPath(task, asset.id)).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`${label}文件不可读，请重新上传。`);
  return asset;
}

function roleNode(asset: ProductProductionAsset, role: string, kind: BoardWorkflowNode["kind"] = "image_asset", productGroupId?: string): BoardWorkflowNode {
  return {
    id: asset.id,
    kind,
    title: asset.name,
    filePath: asset.filePath,
    publicUrl: asset.publicUrl,
    status: "done",
    meta: { assetRole: role, ...(productGroupId ? { productGroupId } : {}) },
    x: 0,
    y: 0,
    createdAt: asset.createdAt,
  };
}

function mimeForFile(filePath: string, fallback = "application/octet-stream") {
  const ext = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  return fallback;
}

async function imageDataUrl(filePath: string) {
  const bytes = await readFile(filePath);
  return `data:${mimeForFile(filePath, "image/png")};base64,${bytes.toString("base64")}`;
}

function imageEditPath(endpointPath?: string) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/edits";
  return /\/images\/generations$/i.test(value) ? value.replace(/\/images\/generations$/i, "/images/edits") : value;
}

function imageGenerationPath(endpointPath?: string) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/generations";
  return /\/images\/edits$/i.test(value) ? value.replace(/\/images\/edits$/i, "/images/generations") : value;
}

async function resultBytes(value: string) {
  const maxBytes = 50 * 1024 * 1024;
  if (value.startsWith("data:")) {
    const bytes = parseDataUrl(value).bytes;
    if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("图片结果为空或超过 50MB 安全上限。");
    return bytes;
  }
  if (!/^https:\/\//i.test(value)) throw new Error("生图模型没有返回安全的 HTTPS 图片地址。");
  const response = await fetch(value, { cache: "no-store" });
  if (!response.ok) throw new Error(`图片结果下载失败（HTTP ${response.status}）。`);
  if (Number(response.headers.get("content-length") || 0) > maxBytes) throw new Error("图片结果超过 50MB 安全上限。");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("图片结果为空或超过 50MB 安全上限。");
  return bytes;
}

async function addOutput(task: ProductProductionTask, job: ProductProductionJob, bytes: Buffer, ext: string, mimeType: string) {
  const assetId = job.id;
  const directory = productProductionOutputDirectory(task.ownerId, task.id);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `${assetId}.partial-${crypto.randomUUID()}.${ext}`);
  let filePath = path.join(directory, `${assetId}.${ext}`);
  let metadata: { width?: number; height?: number; durationSeconds?: number } = {};
  try {
    await writeFile(temporaryPath, bytes);
    if (job.kind === "video") {
      const media = await probeVideoMedia(temporaryPath);
      if (!Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) throw new Error("上游返回的成片没有有效时长。");
      const profile = job.channelSnapshot ? getBoardVideoProfile({ ...job.channelSnapshot, resolution: job.resolution }) : null;
      if (profile && job.generationSeconds) {
        const validation = validateBoardVideoOutput(profile, job.generationSeconds, media);
        if (!validation.valid) throw new Error(`成片规格不符：${validation.violations.join(" ")}`);
      }
      metadata = { width: media.width, height: media.height, durationSeconds: media.durationSeconds };
    } else {
      const inspected = await probeStillImageMedia(temporaryPath);
      ext = inspected.ext.slice(1);
      mimeType = inspected.mimeType;
      filePath = path.join(directory, `${assetId}.${ext}`);
      metadata = { width: inspected.width, height: inspected.height };
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  const asset: ProductProductionAsset = {
    id: assetId,
    kind: job.kind === "video" ? "video_output" : job.kind === "detail" ? "detail_output" : "product_master",
    name: job.kind === "video" ? `${productProductionAsset(task, job.sourceAssetId)?.name.replace(/\.[^.]+$/, "") || "视频"}—版本${String(job.variantIndex || 1).padStart(2, "0")}` : job.kind === "detail" ? `${productProductionAsset(task, job.sourceAssetId)?.name.replace(/\.[^.]+$/, "") || "详情图"}—换装结果` : "产品白底图",
    filePath,
    publicUrl: productProductionFileUrl(task.id, assetId),
    mimeType,
    bytes: bytes.length,
    ...metadata,
    createdAt: new Date().toISOString(),
  };
  return updateProductProductionTask(task.id, task.ownerId, (current) => {
    if (!current.payload.assets.some((item) => item.id === asset.id)) current.payload.assets.push(asset);
    const currentJob = current.payload.jobs.find((item) => item.id === job.id);
    if (currentJob) {
      currentJob.status = "done";
      currentJob.outputAssetId = asset.id;
      currentJob.error = undefined;
      currentJob.finishedAt = new Date().toISOString();
    }
    if (job.kind === "product_master") {
      current.payload.productMasterAssetId = asset.id;
      current.payload.approvedProductMasterAssetId = undefined;
      current.payload.productMasterReviewStatus = "pending";
      current.payload.productMasterApprovedAt = undefined;
    }
    return recalculateTaskStatus(current);
  });
}

function recalculateTaskStatus(task: ProductProductionTask) {
  task.status = productionStatus(task.payload);
  return task;
}

async function markJob(task: ProductProductionTask, jobId: string, patch: Partial<ProductProductionJob>) {
  return updateProductProductionTask(task.id, task.ownerId, (current) => {
    const job = current.payload.jobs.find((item) => item.id === jobId);
    if (job) Object.assign(job, patch);
    return recalculateTaskStatus(current);
  });
}

async function recoverImageOutput(task: ProductProductionTask, job: ProductProductionJob) {
  for (const ext of ["png", "jpg", "webp"] as const) {
    const filePath = path.join(productProductionOutputDirectory(task.ownerId, task.id), `${job.id}.${ext}`);
    const info = await stat(filePath).catch(() => null);
    if (!info) continue;
    if (!info.isFile() || info.size === 0) throw new Error("本地已有不完整的图片结果，已阻止自动重复计费。");
    const inspected = await probeStillImageMedia(filePath).catch(() => null);
    if (!inspected || inspected.ext !== `.${ext}`) throw new Error("本地图片结果格式异常，已阻止自动重复计费。");
    await addOutput(task, job, await readFile(filePath), ext, inspected.mimeType);
    return true;
  }
  return false;
}

async function runImageJob(task: ProductProductionTask, job: ProductProductionJob) {
  if (await recoverImageOutput(task, job)) return;
  const currentChannel = await resolveGlobalImageChannel(task.ownerId, job.channelId);
  if (currentChannel?.id !== job.channelId || !currentChannel.apiKey || !currentChannel.baseUrl || !currentChannel.model) throw new Error("所选生图模型未配置当前账户凭证或已停用。");
  if (job.imageChannelSnapshot && new URL(job.imageChannelSnapshot.baseUrl).origin !== new URL(currentChannel.baseUrl).origin) throw new Error("生图通道主机已变化，请恢复原主机后继续原任务。");
  const channel: ImageModelChannel = job.imageChannelSnapshot ? { ...job.imageChannelSnapshot, apiKey: currentChannel.apiKey } : currentChannel;
  const master = productProductionAsset(task, job.kind === "product_master" ? task.payload.productMasterAssetId : task.payload.approvedProductMasterAssetId);
  const references: BoardWorkflowNode[] = job.kind === "product_master"
    ? (job.productSourceAssetIds || task.payload.productSourceAssetIds).map((id) => productProductionAsset(task, id)).filter(Boolean).map((asset) => roleNode(asset!, "product_image", "image_asset", task.id))
    : [master, task.payload.faceAssetId ? productProductionAsset(task, task.payload.faceAssetId) : undefined, productProductionAsset(task, job.sourceAssetId)]
      .filter(Boolean)
      .map((asset, index, values) => roleNode(asset!, index === 0 ? "product_white_background" : values.length === 3 && index === 1 ? "face_front" : "detail_reference_image"));
  if (job.kind === "product_master" && (references.length < 1 || references.length > 3)) throw new Error("生成产品白底图需要 1–3 张同款商品图。");
  if (job.kind === "detail" && !master) throw new Error("产品白底图尚未就绪。");
  const canonical = buildCanonicalBoardImageTask({
    task: job.kind === "product_master" ? "product_white_background" : "detail_product_replacement",
    referenceNodes: references,
  });
  const urls = await Promise.all(canonical.orderedNodes.map((node) => imageDataUrl(node.filePath!)));
  const size = job.kind === "product_master"
    ? imageDimensionsForPreset("1:1", "4k")!
    : (() => {
      const source = productProductionAsset(task, job.sourceAssetId)!;
      return detailImageOutputSizeForSource(Number(source.width || 9), Number(source.height || 16));
    })();
  const provider = createProvider({
    name: "openai-seedance",
    apiKey: channel.apiKey,
    baseUrl: channel.baseUrl,
    timeout: channel.requestTimeoutMs,
    extra: {
      imageApiKey: channel.apiKey,
      imageBaseUrl: channel.baseUrl,
      imageEditPath: imageEditPath(channel.endpointPath),
      imagePath: imageGenerationPath(channel.endpointPath),
      debugLogPath: path.join(productProductionTaskRoot(task.ownerId, task.id), "image-debug.log"),
    },
    audit: {
      userId: task.ownerId,
      callType: "image",
      providerKey: "openai-seedance",
      channelId: channel.id,
      channelName: channel.name,
      model: channel.model,
      source: job.kind === "product_master" ? "product-production.product-master" : "product-production.detail-replacement",
      productProductionTaskId: task.id,
      productProductionJobId: job.id,
    },
  });
  task = await markJob(task, job.id, { submissionAttemptedAt: new Date().toISOString() });
  const result = await provider.generateImage({
    modelId: channel.model,
    mode: "image-to-image",
    prompt: canonical.promptEnglish,
    referenceImageUrls: urls,
    width: size.width,
    height: size.height,
    count: 1,
    extra: { quality: "auto" },
  });
  const output = result.imageUrls[0];
  if (!output) throw new Error("生图模型没有返回图片结果。");
  await addOutput(task, job, await resultBytes(output), "png", "image/png");
}

async function hostingForOwner(ownerId: string): Promise<VideoReferenceHostingSetting | null> {
  const setting = await resolveGlobalVideoReferenceHosting();
  if (!setting) return null;
  const user = sqlite.prepare(`SELECT role FROM auth_users WHERE id = ? LIMIT 1`).get(ownerId) as { role?: string } | undefined;
  const credentials = user?.role === "admin"
    ? await resolveGlobalVideoReferenceHostingCredentials()
    : await resolveUserVideoReferenceHostingCredentials(ownerId);
  return credentials ? { ...setting, ...credentials } : null;
}

async function cleanupHostedReferences(task: ProductProductionTask, job: ProductProductionJob) {
  if (job.referenceTransport !== "cloudinary_https" || !job.hostedReferences?.length) return;
  const setting = await hostingForOwner(task.ownerId).catch(() => null);
  if (!setting) {
    const now = new Date().toISOString();
    await markJob(task, job.id, { cleanup: { startedAt: now, completedAt: now, total: job.hostedReferences.length, deleted: 0, alreadyAbsent: 0, failed: 0, status: "unverified", errors: ["当前账户托管配置不可用，未执行清理。"], assets: (job.hostedReferences as HostedVideoReference[]).map((item) => ({ publicId: item.publicId, resourceType: item.resourceType || "image", status: "unverified" })) } });
    return;
  }
  try {
    const cleanup = await cleanupCloudinaryVideoReferences(setting, job.hostedReferences as HostedVideoReference[]);
    await markJob(task, job.id, { cleanup });
  } catch {
    const now = new Date().toISOString();
    await markJob(task, job.id, { cleanup: { startedAt: now, completedAt: now, total: job.hostedReferences.length, deleted: 0, alreadyAbsent: 0, failed: 0, status: "unverified", errors: ["临时素材清理回执未能保存，请核查托管平台。"], assets: (job.hostedReferences as HostedVideoReference[]).map((item) => ({ publicId: item.publicId, resourceType: item.resourceType || "image", status: "unverified" })) } });
  }
}

async function runVideoJob(task: ProductProductionTask, job: ProductProductionJob) {
  const currentChannel = await resolveGlobalVideoChannel(task.ownerId, job.channelId, "full_video");
  if (currentChannel?.id !== job.channelId || !currentChannel.apiKey || !currentChannel.baseUrl || !currentChannel.model) throw new Error("所选视频模型未配置当前账户凭证或已停用。");
  if (job.channelSnapshot && new URL(job.channelSnapshot.baseUrl).origin !== new URL(currentChannel.baseUrl).origin) throw new Error("通道主机已变化，为保护凭证，原任务暂停回收；请恢复原主机后重试查询。");
  const channel: VideoModelChannel = job.channelSnapshot ? { ...job.channelSnapshot, apiKey: currentChannel.apiKey } : currentChannel;
  const rawProfile = getBoardVideoProfile(channel);
  if (!rawProfile?.directVideoReplacement || rawProfile.directVideoReplacementReferenceContract !== "product_front_face") {
    throw new Error("所选视频模型不支持商品生产线的参考视频换品合同。");
  }
  const resolution = job.resolution || rawProfile.resolution;
  if (!rawProfile.resolutionOptions.includes(resolution)) throw new Error("已提交任务的清晰度不再受当前模型支持，已阻止静默改档。");
  const profile = getBoardVideoProfile({ ...channel, resolution })!;
  const seconds = job.generationSeconds || profile.generationSeconds;
  if (!profile.durationOptions.includes(seconds)) throw new Error("已提交任务的生成时长不再受当前模型支持，已阻止静默改档。");
  const video = productProductionAsset(task, job.sourceAssetId);
  const master = productProductionAsset(task, task.payload.approvedProductMasterAssetId);
  const face = productProductionAsset(task, task.payload.faceAssetId);
  const scene = productProductionAsset(task, task.payload.sceneAssetId);
  const audio = productProductionAsset(task, task.payload.audioAssetId);
  if (!video || !master) throw new Error("参考视频或产品白底图不可用。");
  if (!profile.directVideoReplacementFaceOptional && !face) throw new Error("所选视频模型要求人脸图。");
  if (!profile.directVideoReplacementSceneOptional && !scene) throw new Error("所选视频模型要求场景图。");
  if (audio && profile.maxReferenceAudios < 1) throw new Error("所选视频模型不支持参考音频。");
  const media = await probeVideoMedia(video.filePath);
  if (media.durationSeconds > seconds + 0.25) throw new Error(`参考视频为 ${media.durationSeconds.toFixed(2)} 秒，超过所选模型本次 ${seconds} 秒。`);
  const basePrompt = buildDirectVideoReplacementPrompt(
    Boolean(audio), profile.directVideoReplacementPromptLanguage, Boolean(scene), "product_front_face", Boolean(face),
    profile.directVideoReplacementFaceOptional, seconds, media.durationSeconds, profile.protocol === "mikoto_sora", profile.directVideoReplacementPromptVersion,
  );
  const prompt = profile.protocol === "lingganya" && ["sd-2.0-vip", "sd-2.0-g"].includes(channel.model.trim().toLowerCase())
    ? bindDirectVideoReplacementMediaAliases(basePrompt, profile.directVideoReplacementPromptLanguage)
    : basePrompt;
  assertBoardVideoPromptWithinLimit(channel.model, prompt);

  if (!job.remoteTaskId) {
    const verified = await verifyRjmusGrokVideoChannel({
      baseUrl: channel.baseUrl, apiKey: channel.apiKey, model: channel.model, videoProtocol: channel.videoProtocol,
      submitPath: channel.submitPath, statusPath: channel.statusPath, contentPath: channel.contentPath,
      durationOptions: channel.durationOptions, maxReferenceImages: channel.maxReferenceImages,
      maxReferenceVideos: channel.maxReferenceVideos, maxReferenceAudios: channel.maxReferenceAudios,
    });
    if ((profile.protocol === "lingganya" || profile.protocol === "mikoto") && !verified.modelVisible) throw new Error(`当前账户的模型目录未包含 ${channel.model}。`);
    const usesFiles = isLingganyaTemporaryFileReferenceChannel(channel);
    const setting = usesFiles ? null : await hostingForOwner(task.ownerId);
    const preparedAssets: HostedVideoReference[] = [];
    let uploadedCount = Number(job.referenceUploadCount || 0);
    let earliestExpiry = job.referenceExpiresAt;
    const onFileUploaded = async (file: { expiresAt: string }) => {
      uploadedCount++;
      if (!earliestExpiry || !Number.isFinite(Date.parse(earliestExpiry)) || Date.parse(file.expiresAt) < Date.parse(earliestExpiry)) earliestExpiry = file.expiresAt;
      // Persist each receipt before starting the next file. Never persist file_id.
      task = await markJob(task, job.id, { referenceTransport: "lingganya_file_id", referenceUploadCount: uploadedCount, referenceExpiresAt: earliestExpiry });
    };
    try {
      const videoBatch = await prepareVideoReferencesForChannel({
        channel, sources: [await encodeVideoFileForVideoReference(video.filePath)], setting,
        ownerId: task.ownerId, scopeId: task.id, referenceIds: [video.id], mediaType: "video",
        onLingganyaFileUploaded: onFileUploaded,
      });
      preparedAssets.push(...videoBatch.assets);
      const imageAssets = [master, ...(face ? [face] : []), ...(scene ? [scene] : [])];
      const imageBatch = await prepareVideoReferencesForChannel({
        channel, sources: await Promise.all(imageAssets.map((asset) => encodeImageFileForVideoReference(asset.filePath, { targetBytes: 1_200 * 1024 }))), setting,
        ownerId: task.ownerId, scopeId: task.id, referenceIds: imageAssets.map((asset) => asset.id), mediaType: "image",
        onLingganyaFileUploaded: onFileUploaded,
      });
      preparedAssets.push(...imageBatch.assets);
      const audioBatch = audio ? await prepareVideoReferencesForChannel({
        channel, sources: [await encodeAudioFileForVideoReference(audio.filePath)], setting,
        ownerId: task.ownerId, scopeId: task.id, referenceIds: [audio.id], mediaType: "audio",
        onLingganyaFileUploaded: onFileUploaded,
      }) : null;
      preparedAssets.push(...(audioBatch?.assets || []));
      const { apiKey: _credential, ...channelSnapshot } = channel;
      void _credential;
      task = await markJob(task, job.id, {
        submissionAttemptedAt: new Date().toISOString(), channelSnapshot,
        hostedReferences: preparedAssets as unknown as Array<Record<string, unknown>>,
        referenceTransport: imageBatch.transport === "lingganya_file_id" ? "lingganya_file_id" : "cloudinary_https",
      });
      const submitted = await auditModelApiCall({
      userId: task.ownerId,
      callType: "video",
      providerKey: "rjmus-grok",
      channelId: channel.id,
      channelName: channel.name,
      model: channel.model,
      source: "product-production.video-replacement",
      productProductionTaskId: task.id,
      productProductionJobId: job.id,
      }, () => submitRjmusGrokVideo({
      baseUrl: channel.baseUrl, apiKey: channel.apiKey, model: channel.model, videoProtocol: channel.videoProtocol,
      prompt, imageUrls: imageBatch.urls, videoUrls: videoBatch.urls, audioUrls: audioBatch?.urls || [],
      submitPath: channel.submitPath, statusPath: channel.statusPath, contentPath: channel.contentPath,
      resolution: profile.resolution, durationOptions: channel.durationOptions, generationSeconds: seconds,
      maxReferenceImages: channel.maxReferenceImages, maxReferenceVideos: channel.maxReferenceVideos,
      maxReferenceAudios: channel.maxReferenceAudios,
      directVideoReplacementSceneOptional: profile.directVideoReplacementSceneOptional,
      directVideoReplacementFaceOptional: profile.directVideoReplacementFaceOptional,
      directVideoReplacementReferenceContract: "product_front_face",
      }), { toResult: (result) => ({ remoteTaskId: result.taskId }) });
      task = await markJob(task, job.id, {
        status: "running", remoteTaskId: submitted.taskId, submittedAt: new Date().toISOString(),
        promptVersion: profile.directVideoReplacementPromptVersion, capabilitySignature: profile.capabilitySignature,
        hostedReferences: preparedAssets as unknown as Array<Record<string, unknown>>,
        referenceTransport: imageBatch.transport === "lingganya_file_id" ? "lingganya_file_id" : "cloudinary_https",
        referenceUploadCount: usesFiles ? uploadedCount : 0,
        referenceExpiresAt: usesFiles ? earliestExpiry : undefined,
      });
      job = task.payload.jobs.find((item) => item.id === job.id)!;
    } catch (error) {
      const fresh = await getProductProductionTask(task.id, task.ownerId);
      const freshJob = fresh?.payload.jobs.find((item) => item.id === job.id);
      if (!freshJob?.submissionAttemptedAt || isDefiniteSubmissionRejection(error)) {
        if (setting && preparedAssets.length) {
          const cleanup = await cleanupCloudinaryVideoReferences(setting, preparedAssets);
          await markJob(task, job.id, { cleanup });
        }
      }
      throw error;
    }
  }

  let upstreamTerminal = false;
  try {
    for (;;) {
      try {
      const status = await getRjmusGrokVideoStatus({
        baseUrl: channel.baseUrl, apiKey: channel.apiKey, model: channel.model, videoProtocol: channel.videoProtocol,
        taskId: job.remoteTaskId!, submitPath: channel.submitPath, statusPath: channel.statusPath, contentPath: channel.contentPath,
        durationOptions: channel.durationOptions, maxReferenceImages: channel.maxReferenceImages,
        maxReferenceVideos: channel.maxReferenceVideos, maxReferenceAudios: channel.maxReferenceAudios,
      });
      if (status.status === "failed" || status.status === "cancelled") { upstreamTerminal = true; throw new Error(status.error || "上游视频任务失败。"); }
      if (status.status === "completed") {
        upstreamTerminal = true;
        const resultUrl = status.resultUrls[0];
        if (!resultUrl) throw new Error("视频任务完成但没有返回下载地址。");
        const result = await downloadRjmusGrokVideo({ resultUrl, apiKey: channel.apiKey, requiresApiKey: status.contentRequiresApiKey, authorizedBaseUrl: channel.baseUrl });
          await addOutput(task, job, result.bytes, result.ext, result.ext === "webm" ? "video/webm" : "video/mp4");
          return;
        }
      } catch (error) {
        if (isTransientVideoPollInterruption(error) || (error instanceof RjmusGrokVideoError && error.statusCode === 403)) {
          await sleep(30_000);
          continue;
        }
        throw error;
      }
      await sleep(30_000);
    }
  } finally {
    if (upstreamTerminal) await cleanupHostedReferences(task, job);
  }
}

async function runJob(task: ProductProductionTask, job: ProductProductionJob) {
  try {
    task = await updateProductProductionTask(task.id, task.ownerId, (current) => {
      const currentJob = current.payload.jobs.find((item) => item.id === job.id);
      if (!currentJob || (currentJob.status !== "queued" && !(currentJob.status === "running" && currentJob.remoteTaskId))) {
        throw new JobNoLongerRunnable();
      }
      currentJob.status = currentJob.remoteTaskId ? "running" : "submitting";
      currentJob.startedAt ||= new Date().toISOString();
      currentJob.error = undefined;
      return recalculateTaskStatus(current);
    });
  } catch (error) {
    if (error instanceof JobNoLongerRunnable) return;
    throw error;
  }
  job = task.payload.jobs.find((item) => item.id === job.id)!;
  try {
    if (job.kind === "video") await runVideoJob(task, job);
    else await runImageJob(task, job);
  } catch (error) {
    const fresh = await getProductProductionTask(task.id, task.ownerId);
    const currentJob = fresh?.payload.jobs.find((item) => item.id === job.id);
    // Cleanup failures must not invalidate a result already durably saved.
    if (currentJob?.status === "done") return;
    const uncertain = !currentJob?.remoteTaskId && Boolean(currentJob?.submissionAttemptedAt) && !isDefiniteSubmissionRejection(error);
    await markJob(task, job.id, { status: uncertain ? "uncertain" : "failed", error: uncertain ? "模型提交或结果回收中断，上游可能已受理并计费。请先核对结果，系统未自动重提。" : error instanceof Error ? error.message : "生成失败。", finishedAt: new Date().toISOString() });
  }
}

class JobNoLongerRunnable extends Error {}

type ScheduledJob = { id: string; task: ProductProductionTask; job: ProductProductionJob };

async function selectNextJob(ownerId: string, activeJobIds: ReadonlySet<string>): Promise<ScheduledJob | null> {
  const owner = sqlite.prepare(`SELECT id, role, disabled FROM auth_users WHERE id = ?`).get(ownerId) as { id: string; role: "admin" | "user"; disabled: number } | undefined;
  if (!owner || owner.disabled || (await featureEntriesForUser(owner))["product-production"] !== "open") return null;
  const rows = sqlite.prepare(`SELECT id FROM product_production_tasks WHERE owner_id = ? AND EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.jobs')) WHERE json_extract(value, '$.status') IN ('waiting', 'queued', 'submitting', 'running', 'uncertain')) ORDER BY updated_at ASC`).all(ownerId) as Array<{ id: string }>;
  for (const row of rows) {
    let task = await getProductProductionTask(row.id, ownerId);
    for (const stale of task?.payload.jobs.filter((item) => item.kind !== "video" && ["submitting", "uncertain"].includes(item.status) && !activeJobIds.has(item.id)) || []) {
      // A fully written image is already paid for; register it without a new API call.
      await recoverImageOutput(task!, stale).catch(() => false);
    }
    task = await getProductProductionTask(row.id, ownerId);
    if (task?.payload.jobs.some((item) => item.status === "submitting" && !item.remoteTaskId && !activeJobIds.has(item.id))) {
      task = await updateProductProductionTask(task.id, ownerId, (current) => {
        current.payload.jobs.forEach((item) => {
          if (item.status === "submitting" && !item.remoteTaskId && !activeJobIds.has(item.id)) {
            item.status = "uncertain";
            item.error = "服务在提交阶段中断，无法确认上游是否已接单。为避免重复扣费，系统没有自动重提。";
            item.finishedAt = new Date().toISOString();
          }
        });
        return recalculateTaskStatus(current);
      });
    }
    const job = task?.payload.jobs.find((item) => !activeJobIds.has(item.id) && (item.status === "queued" || (item.status === "running" && Boolean(item.remoteTaskId))));
    if (task && job) return { id: job.id, task, job };
  }
  return null;
}

const scheduler = createBoundedOwnerScheduler<ScheduledJob>(
  2,
  selectNextJob,
  async (_ownerId, selected) => runJob(selected.task, selected.job),
  (error) => console.error("商品生产线调度失败：", error),
);

export function wakeProductProductionWorker(ownerId: string) {
  scheduler.wake(ownerId);
}

export function recoverProductProductionWorkers() {
  const rows = sqlite.prepare(`SELECT DISTINCT owner_id FROM product_production_tasks WHERE EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.jobs')) WHERE json_extract(value, '$.status') IN ('queued', 'submitting', 'running', 'uncertain'))`).all() as Array<{ owner_id: string }>;
  rows.forEach((row) => wakeProductProductionWorker(row.owner_id));
}

export async function enqueueProductMaster(taskId: string, ownerId: string) {
  const snapshot = await getProductProductionTask(taskId, ownerId);
  if (!snapshot) throw new Error("商品生产任务不存在。");
  const failedMaster = snapshot.payload.jobs.filter((job) => job.kind === "product_master").at(-1);
  if (failedMaster?.status === "failed" && !failedMaster.outputAssetId && !snapshot.payload.jobs.some((job) => job.kind !== "product_master")) {
    const outputDirectory = productProductionOutputDirectory(ownerId, taskId);
    const hasSavedOutput = (await Promise.all(["png", "jpg", "webp"].map((ext) => stat(path.join(outputDirectory, `${failedMaster.id}.${ext}`)).then((info) => info.isFile()).catch(() => false)))).some(Boolean);
    if (hasSavedOutput) {
      const recovered = await updateProductProductionTask(taskId, ownerId, (current) => {
        if (current.revision !== snapshot.revision) throw new Error("任务配置刚刚发生变化，请刷新后恢复结果。");
        const job = current.payload.jobs.find((item) => item.id === failedMaster.id);
        if (!job || job.status !== "failed") throw new Error("原白底图任务状态已变化，请刷新后重试。");
        job.status = "queued";
        job.error = undefined;
        job.finishedAt = undefined;
        return recalculateTaskStatus(current);
      });
      wakeProductProductionWorker(ownerId);
      return recovered;
    }
  }
  if (snapshot.payload.productSourceAssetIds.length < 1 || snapshot.payload.productSourceAssetIds.length > 3) throw new Error("请上传 1–3 张同款商品图。");
  for (const assetId of snapshot.payload.productSourceAssetIds) await requireReadableAsset(snapshot, assetId, "商品图");
  const channel = await resolveGlobalImageChannel(ownerId, snapshot.payload.imageChannelId);
  if (!snapshot.payload.imageChannelId || channel?.id !== snapshot.payload.imageChannelId || !channel.apiKey || !channel.baseUrl || !channel.model) {
    throw new Error("白底图模型不可用或当前账户未配置凭证，请先选择可用模型。");
  }
  const task = await updateProductProductionTask(taskId, ownerId, (current) => {
    if (current.revision !== snapshot.revision) throw new Error("任务配置刚刚发生变化，请刷新后再生成白底图。");
    if (current.payload.jobs.some((job) => job.kind !== "product_master")) throw new Error("内容生产已经开始，不能重新生成产品白底图。");
    if (current.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status))) throw new Error("产品白底图正在生成，请等待当前任务完成。");
    if (current.payload.jobs.some((job) => job.kind === "product_master" && job.status === "uncertain")) throw new Error("请先核实上次白底图提交状态，再决定是否重新生成。");
    if (!current.payload.productSourceAssetIds.length) throw new Error("请先上传 1–3 张同款商品图。");
    if (!current.payload.imageChannelId) throw new Error("请选择用于生成白底图的图片模型。");
    current.payload.approvedProductMasterAssetId = undefined;
    current.payload.productMasterReviewStatus = "not_ready";
    current.payload.productMasterApprovedAt = undefined;
    const { apiKey: _credential, ...imageChannelSnapshot } = channel;
    void _credential;
    current.payload.jobs.push({ id: crypto.randomUUID(), kind: "product_master", status: "queued", channelId: current.payload.imageChannelId, imageChannelSnapshot, productSourceAssetIds: [...current.payload.productSourceAssetIds] });
    return recalculateTaskStatus(current);
  });
  wakeProductProductionWorker(ownerId);
  return task;
}

export async function approveProductMaster(taskId: string, ownerId: string) {
  const snapshot = await getProductProductionTask(taskId, ownerId);
  if (!snapshot) throw new Error("商品生产任务不存在。");
  await requireReadableAsset(snapshot, snapshot.payload.productMasterAssetId, "产品白底图");
  return updateProductProductionTask(taskId, ownerId, (current) => {
    if (current.revision !== snapshot.revision) throw new Error("白底图刚刚发生变化，请刷新后重新验收。");
    if (current.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status))) throw new Error("产品白底图仍在生成，请完成后再验收。");
    if (current.payload.jobs.some((job) => job.kind === "product_master" && job.status === "uncertain")) throw new Error("请先核实提交中断的白底图任务，避免遗漏或重复扣费。");
    const master = productProductionAsset(current, current.payload.productMasterAssetId);
    if (!master || master.kind !== "product_master") throw new Error("当前没有可验收的产品白底图。");
    current.payload.approvedProductMasterAssetId = master.id;
    current.payload.productMasterReviewStatus = "approved";
    current.payload.productMasterApprovedAt = new Date().toISOString();
    return recalculateTaskStatus(current);
  });
}

export async function resolveUncertainProductMasterWithUpload(taskId: string, ownerId: string) {
  return updateProductProductionTask(taskId, ownerId, (current) => {
    if (current.payload.jobs.some((job) => job.kind !== "product_master")) throw new Error("内容生产已经开始，不能再处理白底图提交状态。");
    const uncertain = [...current.payload.jobs].reverse().find((job) => job.kind === "product_master" && job.status === "uncertain");
    const master = productProductionAsset(current, current.payload.productMasterAssetId);
    if (!uncertain || !master || master.kind !== "product_master") throw new Error("没有待核实的白底图任务或已上传结果。");
    if (!uncertain.finishedAt || Date.parse(master.createdAt) <= Date.parse(uncertain.finishedAt)) {
      throw new Error("请先上传从模型平台取得的本次白底图结果。");
    }
    uncertain.status = "done";
    uncertain.outputAssetId = master.id;
    uncertain.recoveredManually = true;
    uncertain.error = undefined;
    current.payload.productMasterReviewStatus = "pending";
    return recalculateTaskStatus(current);
  });
}

export async function resetProductMasterApproval(taskId: string, ownerId: string) {
  return updateProductProductionTask(taskId, ownerId, (current) => {
    if (current.payload.jobs.some((job) => job.kind !== "product_master")) throw new Error("内容生产已经开始，本次任务的产品白底图不能更换。");
    current.payload.approvedProductMasterAssetId = undefined;
    current.payload.productMasterReviewStatus = current.payload.productMasterAssetId ? "pending" : "not_ready";
    current.payload.productMasterApprovedAt = undefined;
    return recalculateTaskStatus(current);
  });
}

export async function enqueueProductProduction(taskId: string, ownerId: string) {
  const snapshot = await getProductProductionTask(taskId, ownerId);
  if (!snapshot) throw new Error("商品生产任务不存在。");
  const selection = productProductionContentSelection(
    snapshot.payload.productionMode,
    snapshot.payload.videoSources.length,
    snapshot.payload.detailAssetIds.length,
  );
  if (!snapshot.payload.approvedProductMasterAssetId || snapshot.payload.productMasterReviewStatus !== "approved") {
    throw new Error("请先验收通过产品白底图。");
  }
  await requireReadableAsset(snapshot, snapshot.payload.approvedProductMasterAssetId, "已验收白底图");
  const videoConfig = new Map<string, { seconds: number; resolution: "720p" | "1080p"; channelSnapshot: Omit<VideoModelChannel, "apiKey"> }>();
  let imageChannelSnapshot: Omit<ImageModelChannel, "apiKey"> | undefined;
  if (selection.detail) {
    const imageChannel = await resolveGlobalImageChannel(ownerId, snapshot.payload.imageChannelId);
    if (!snapshot.payload.imageChannelId || imageChannel?.id !== snapshot.payload.imageChannelId || !imageChannel.apiKey || !imageChannel.baseUrl || !imageChannel.model) {
      throw new Error("详情图模型不可用或当前账户未配置凭证，请先选择可用模型。");
    }
    for (const assetId of snapshot.payload.detailAssetIds) {
      await requireReadableAsset(snapshot, assetId, "详情原图");
    }
    const { apiKey: _credential, ...frozenChannel } = imageChannel;
    void _credential;
    imageChannelSnapshot = frozenChannel;
    if (snapshot.payload.faceAssetId) await requireReadableAsset(snapshot, snapshot.payload.faceAssetId, "人脸正面图");
  }
  if (selection.video) {
    for (const source of snapshot.payload.videoSources) {
      const video = await requireReadableAsset(snapshot, source.assetId, "参考视频");
      if (!video || video.kind !== "reference_video") throw new Error("有参考视频已失效，请移除后重新上传。");
      const selectedChannelId = source.channelId || snapshot.payload.videoChannelId;
      const channel = await resolveGlobalVideoChannel(ownerId, selectedChannelId, "full_video");
      if (!selectedChannelId || channel?.id !== selectedChannelId || !channel.apiKey || !channel.baseUrl || !channel.model) throw new Error(`参考视频「${video.name}」所选模型不可用或当前账户未配置凭证。`);
      const profile = getBoardVideoProfile(channel);
      if (!profile?.directVideoReplacement || profile.directVideoReplacementReferenceContract !== "product_front_face") {
        throw new Error(`参考视频「${video.name}」所选模型不支持商品换品。`);
      }
      if (!profile.directVideoReplacementFaceOptional && !snapshot.payload.faceAssetId) throw new Error(`模型「${channel.name}」要求人脸正面图。`);
      if (!profile.directVideoReplacementSceneOptional && !snapshot.payload.sceneAssetId) throw new Error(`模型「${channel.name}」要求场景参考图。`);
      if (snapshot.payload.audioAssetId && profile.maxReferenceAudios < 1) throw new Error(`模型「${channel.name}」不支持参考音频。`);
      if (snapshot.payload.faceAssetId) await requireReadableAsset(snapshot, snapshot.payload.faceAssetId, "人脸正面图");
      if (snapshot.payload.sceneAssetId) await requireReadableAsset(snapshot, snapshot.payload.sceneAssetId, "场景参考图");
      if (snapshot.payload.audioAssetId) await requireReadableAsset(snapshot, snapshot.payload.audioAssetId, "参考音频");
      const seconds = source.generationSeconds || snapshot.payload.defaultVideoSeconds || profile.generationSeconds;
      if (!profile.durationOptions.includes(seconds)) throw new Error(`参考视频「${video.name}」的 ${seconds} 秒档位不受当前模型支持。`);
      const resolution = source.resolution || snapshot.payload.defaultVideoResolution || profile.resolution;
      if (!profile.resolutionOptions.includes(resolution)) throw new Error(`参考视频「${video.name}」的 ${resolution} 档位不受当前模型支持。`);
      const { apiKey: _credential, ...channelSnapshot } = channel;
      void _credential;
      videoConfig.set(source.id, { seconds, resolution, channelSnapshot });
      const media = await probeVideoMedia(video.filePath);
      if (!Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || media.durationSeconds > seconds + 0.25) {
        throw new Error(`参考视频「${video.name}」时长为 ${media.durationSeconds.toFixed(2)} 秒，超过或无法匹配 ${seconds} 秒模型档位。`);
      }
      if (!isLingganyaTemporaryFileReferenceChannel(channel) && !isReadyVideoReferenceHosting(await hostingForOwner(ownerId))) {
        throw new Error(`模型「${channel.name}」需要先为当前账户配置视频参考素材公网托管。`);
      }
    }
  }
  const task = await updateProductProductionTask(taskId, ownerId, (current) => {
    if (current.revision !== snapshot.revision) throw new Error("任务配置刚刚发生变化，请刷新后再开始生产。");
    const master = productProductionAsset(current, current.payload.approvedProductMasterAssetId);
    const { video: includesVideo, detail: includesDetail } = productProductionContentSelection(
      current.payload.productionMode,
      current.payload.videoSources.length,
      current.payload.detailAssetIds.length,
    );
    if (!master || current.payload.productMasterReviewStatus !== "approved") throw new Error("请先验收通过产品白底图。");
    if (current.payload.productionMode === "video" && !includesVideo) throw new Error("请先上传参考视频。");
    if (current.payload.productionMode === "detail" && !includesDetail) throw new Error("请先上传详情原图。");
    if (!includesVideo && !includesDetail) throw new Error("请至少上传参考视频或详情图。");
    if (includesDetail && !current.payload.imageChannelId) throw new Error("请选择用于详情图换装的图片模型。");
    if (current.payload.jobs.some((job) => job.kind !== "product_master")) throw new Error("本批次已开始，请重试原执行项或沿用白底图新建一批。");
    const activeKeys = new Set(current.payload.jobs.map((job) => `${job.kind}:${job.sourceAssetId || "master"}:${job.variantIndex || 0}`));
    for (const source of includesVideo ? current.payload.videoSources : []) {
      for (let variant = 1; variant <= Math.max(1, Math.min(10, source.copies)); variant++) {
        const key = `video:${source.assetId}:${variant}`;
        if (!activeKeys.has(key)) current.payload.jobs.push({
          id: crypto.randomUUID(), kind: "video", status: "queued", sourceAssetId: source.assetId,
          variantIndex: variant, channelId: source.channelId || current.payload.videoChannelId!, generationSeconds: videoConfig.get(source.id)!.seconds, resolution: videoConfig.get(source.id)!.resolution,
          channelSnapshot: videoConfig.get(source.id)!.channelSnapshot,
        });
      }
    }
    for (const assetId of includesDetail ? current.payload.detailAssetIds : []) {
      const key = `detail:${assetId}:0`;
      if (!activeKeys.has(key)) current.payload.jobs.push({ id: crypto.randomUUID(), kind: "detail", status: "queued", sourceAssetId: assetId, channelId: current.payload.imageChannelId!, imageChannelSnapshot });
    }
    return recalculateTaskStatus(current);
  });
  wakeProductProductionWorker(ownerId);
  return task;
}

export async function retryFailedProductProduction(
  taskId: string,
  ownerId: string,
  options: { includeUncertain?: boolean; includeProductMaster?: boolean; jobId?: string } = {},
) {
  const task = await updateProductProductionTask(taskId, ownerId, (current) => {
    if (options.includeProductMaster && current.payload.jobs.some((job) => job.kind !== "product_master")) {
      throw new Error("内容生产已经开始，不能重新提交白底图任务。");
    }
    return recalculateTaskStatus(prepareProductProductionRetry(current, options));
  });
  wakeProductProductionWorker(ownerId);
  return task;
}

export async function cancelQueuedProductProduction(taskId: string, ownerId: string) {
  return updateProductProductionTask(taskId, ownerId, (current) => {
    current.payload.jobs.forEach((job) => {
      if (["waiting", "queued"].includes(job.status)) {
        job.status = "cancelled";
        job.error = "已在提交模型前停止。";
        job.finishedAt = new Date().toISOString();
      }
    });
    return recalculateTaskStatus(current);
  });
}
