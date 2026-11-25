import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import { deleteProductProductionTask, updateProductProductionTask } from "@/lib/product-production";
import { wakeProductProductionWorker } from "@/lib/product-production-worker";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  wakeProductProductionWorker(access.user.id);
  return NextResponse.json({ task: access.task }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const task = await updateProductProductionTask(id, access.user.id, (current) => {
      const contentStarted = current.payload.jobs.some((job) => job.kind !== "product_master");
      const masterRunning = current.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status));
      if (masterRunning && ["imageChannelId", "productMasterAssetId"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
        throw new Error("产品白底图正在生成，请完成后再调整白底图模型或候选。");
      }
      if (typeof body.expectedRevision === "number" && body.expectedRevision !== current.revision) throw new Error("REVISION_CONFLICT");
      const mutatesContentSetup = ["productionMode", "imageChannelId", "videoChannelId", "defaultVideoSeconds", "defaultVideoResolution", "faceAssetId", "sceneAssetId", "audioAssetId", "videoSources", "videoSourceUpdate", "detailAssetIds", "productMasterAssetId", "removeAssetId"]
        .some((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (contentStarted && mutatesContentSetup) throw new Error("内容生产开始后，已验收白底图、源素材和模型参数不能修改。");
      if (typeof body.name === "string") current.name = body.name;
      if (["video", "detail", "both"].includes(String(body.productionMode || ""))) {
        current.payload.productionMode = body.productionMode as "video" | "detail" | "both";
      }
      if (typeof body.imageChannelId === "string") current.payload.imageChannelId = body.imageChannelId;
      if (typeof body.videoChannelId === "string") current.payload.videoChannelId = body.videoChannelId;
      if (typeof body.defaultVideoSeconds === "number" && Number.isFinite(body.defaultVideoSeconds)) current.payload.defaultVideoSeconds = Math.round(body.defaultVideoSeconds);
      if (body.defaultVideoResolution === "720p" || body.defaultVideoResolution === "1080p") current.payload.defaultVideoResolution = body.defaultVideoResolution;
      if (typeof body.productMasterAssetId === "string" && current.payload.assets.some((asset) => asset.id === body.productMasterAssetId && asset.kind === "product_master")) {
        current.payload.productMasterAssetId = body.productMasterAssetId;
        current.payload.approvedProductMasterAssetId = undefined;
        current.payload.productMasterReviewStatus = "pending";
        current.payload.productMasterApprovedAt = undefined;
      }
      if (typeof body.faceAssetId === "string" && current.payload.assets.some((asset) => asset.id === body.faceAssetId && asset.kind === "face_image")) current.payload.faceAssetId = body.faceAssetId;
      if (body.faceAssetId === null) current.payload.faceAssetId = undefined;
      if (typeof body.sceneAssetId === "string" && current.payload.assets.some((asset) => asset.id === body.sceneAssetId && asset.kind === "scene_image")) current.payload.sceneAssetId = body.sceneAssetId;
      if (body.sceneAssetId === null) current.payload.sceneAssetId = undefined;
      if (typeof body.audioAssetId === "string" && current.payload.assets.some((asset) => asset.id === body.audioAssetId && asset.kind === "audio")) current.payload.audioAssetId = body.audioAssetId;
      if (body.audioAssetId === null) current.payload.audioAssetId = undefined;
      if (body.videoSourceUpdate && typeof body.videoSourceUpdate === "object") {
        const update = body.videoSourceUpdate as { id?: string; patch?: Record<string, unknown> };
        if (!current.payload.videoSources.some((source) => source.id === update.id)) throw new Error("参考素材已变化，请刷新。");
        const patch = update.patch || {};
        body.videoSources = current.payload.videoSources.map((source) => source.id === update.id ? {
          ...source,
          ...Object.fromEntries(["copies", "channelId", "generationSeconds", "resolution"].filter((key) => key in patch).map((key) => [key, patch[key]])),
        } : source);
      }
      if (Array.isArray(body.videoSources)) {
        current.payload.videoSources = body.videoSources.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const item = raw as Record<string, unknown>;
          const assetId = String(item.assetId || "");
          if (!current.payload.assets.some((asset) => asset.id === assetId && asset.kind === "reference_video")) return [];
          const resolution = item.resolution === "1080p" ? "1080p" as const : item.resolution === "720p" ? "720p" as const : undefined;
          return [{
            id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
            assetId,
            copies: Math.max(1, Math.min(10, Math.round(Number(item.copies || 1)))),
            channelId: typeof item.channelId === "string" && item.channelId ? item.channelId : undefined,
            generationSeconds: item.generationSeconds != null && Number.isFinite(Number(item.generationSeconds)) ? Math.round(Number(item.generationSeconds)) : undefined,
            resolution,
          }];
        });
      }
      if (Array.isArray(body.detailAssetIds)) current.payload.detailAssetIds = body.detailAssetIds.filter((assetId): assetId is string => typeof assetId === "string" && current.payload.assets.some((asset) => asset.id === assetId && asset.kind === "detail_image"));
      if (typeof body.removeAssetId === "string") {
        if (current.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status))) throw new Error("产品白底图正在生成，请完成后再修改商品素材。");
        const assetId = body.removeAssetId;
        current.payload.productSourceAssetIds = current.payload.productSourceAssetIds.filter((value) => value !== assetId);
        current.payload.videoSources = current.payload.videoSources.filter((value) => value.assetId !== assetId);
        current.payload.detailAssetIds = current.payload.detailAssetIds.filter((value) => value !== assetId);
        if (current.payload.productMasterAssetId === assetId) {
          current.payload.productMasterAssetId = undefined;
          current.payload.approvedProductMasterAssetId = undefined;
          current.payload.productMasterReviewStatus = "not_ready";
          current.payload.productMasterApprovedAt = undefined;
        }
        if (current.payload.faceAssetId === assetId) current.payload.faceAssetId = undefined;
        if (current.payload.sceneAssetId === assetId) current.payload.sceneAssetId = undefined;
        if (current.payload.audioAssetId === assetId) current.payload.audioAssetId = undefined;
        current.payload.assets = current.payload.assets.filter((asset) => asset.id !== assetId);
      }
      return current;
    });
    return NextResponse.json({ task }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "REVISION_CONFLICT") return NextResponse.json({ error: "配置已变化，请重新同步。", task: (await getOwnedProductProductionAccess(req, id))?.task }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存失败。" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  try {
    await deleteProductProductionTask(id, access.user.id);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除任务失败。" }, { status: 400 });
  }
}
