import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeAudioMedia, probeStillImageMedia, probeVideoMedia } from "@/lib/video-media-probe";
import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import {
  productProductionFileUrl,
  productProductionTaskRoot,
  updateProductProductionTask,
  type ProductProductionAsset,
  type ProductProductionAssetKind,
} from "@/lib/product-production";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
const IMAGE_KINDS = new Set<ProductProductionAssetKind>(["product_source", "product_master", "detail_image", "face_image", "scene_image"]);
const ALLOWED_KINDS = new Set<ProductProductionAssetKind>([...IMAGE_KINDS, "reference_video", "audio"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

function extension(file: File) {
  const ext = path.extname(file.name).toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (ext && ext.length <= 6) return ext;
  if (file.type.includes("png")) return ".png";
  if (file.type.includes("webp")) return ".webp";
  if (file.type.includes("jpeg")) return ".jpg";
  if (file.type.includes("webm")) return ".webm";
  if (file.type.includes("quicktime")) return ".mov";
  if (file.type.includes("audio")) return ".mp3";
  return ".mp4";
}

function kindAcceptsFile(kind: ProductProductionAssetKind, file: File) {
  if (IMAGE_KINDS.has(kind)) return file.type.startsWith("image/");
  if (kind === "reference_video") return file.type.startsWith("video/");
  if (kind === "audio") return file.type.startsWith("audio/");
  return false;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  const form = await req.formData();
  const kind = String(form.get("kind") || "") as ProductProductionAssetKind;
  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  if (!ALLOWED_KINDS.has(kind) || files.length === 0) return NextResponse.json({ error: "请选择有效素材。" }, { status: 400 });
  if (["product_master", "face_image", "scene_image", "audio"].includes(kind) && files.length !== 1) {
    return NextResponse.json({ error: "这个素材位每次只能上传一个文件。" }, { status: 400 });
  }
  if (access.task.payload.jobs.some((job) => job.kind !== "product_master")) return NextResponse.json({ error: "内容生产开始后不能再修改本次源素材。" }, { status: 400 });
  if (["product_source", "product_master"].includes(kind) && access.task.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status))) return NextResponse.json({ error: "产品白底图正在生成，请完成后再修改商品素材。" }, { status: 400 });
  if (kind === "product_source" && access.task.payload.productSourceAssetIds.length + files.length > 3) return NextResponse.json({ error: "同一商品最多上传 3 张商品图。" }, { status: 400 });
  const directory = path.join(productProductionTaskRoot(access.user.id, id), "uploads");
  await mkdir(directory, { recursive: true });
  const created: ProductProductionAsset[] = [];
  const createdPaths = new Set<string>();
  try {
    for (const file of files) {
      if (!kindAcceptsFile(kind, file)) throw new Error(`${file.name} 的文件类型不适用于当前素材位。`);
      const maxBytes = IMAGE_KINDS.has(kind) ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES;
      if (file.size <= 0 || file.size > maxBytes) throw new Error(`${file.name} 超过允许大小。`);
      const assetId = crypto.randomUUID();
      let filePath = path.join(directory, `${assetId}${extension(file)}`);
      createdPaths.add(filePath);
      await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      let mimeType = file.type || "application/octet-stream";
      let dimensions: { width?: number; height?: number; durationSeconds?: number } = {};
      if (IMAGE_KINDS.has(kind)) {
        const inspected = await probeStillImageMedia(filePath);
        const canonicalPath = path.join(directory, `${assetId}${inspected.ext}`);
        if (canonicalPath !== filePath) {
          await rename(filePath, canonicalPath);
          createdPaths.delete(filePath);
          createdPaths.add(canonicalPath);
          filePath = canonicalPath;
        }
        mimeType = inspected.mimeType;
        dimensions = { width: inspected.width, height: inspected.height };
      } else if (kind === "reference_video") {
        const media = await probeVideoMedia(filePath);
        if (!Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) throw new Error(`${file.name} 不是可用的参考视频。`);
        dimensions = { width: media.width, height: media.height, durationSeconds: media.durationSeconds };
      } else if (kind === "audio") {
        await probeAudioMedia(filePath);
      }
      created.push({
        id: assetId, kind, name: file.name.slice(0, 180), filePath,
        publicUrl: productProductionFileUrl(id, assetId), mimeType,
        bytes: file.size, ...dimensions, createdAt: new Date().toISOString(),
      });
    }
    const task = await updateProductProductionTask(id, access.user.id, (current) => {
      if (current.payload.jobs.some((job) => job.kind !== "product_master")) throw new Error("内容生产开始后不能再修改本次源素材。");
      if (["product_source", "product_master"].includes(kind) && current.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status))) throw new Error("产品白底图正在生成，请完成后再修改商品素材。");
      if (kind === "product_source" && current.payload.productSourceAssetIds.length + created.length > 3) throw new Error("同一商品最多上传 3 张商品图。");
      current.payload.assets.push(...created);
      if (kind === "product_source") current.payload.productSourceAssetIds.push(...created.map((asset) => asset.id));
      if (kind === "product_master") {
        current.payload.productMasterAssetId = created.at(-1)?.id;
        current.payload.approvedProductMasterAssetId = undefined;
        current.payload.productMasterReviewStatus = "pending";
        current.payload.productMasterApprovedAt = undefined;
      }
      if (kind === "reference_video") current.payload.videoSources.push(...created.map((asset) => ({ id: crypto.randomUUID(), assetId: asset.id, copies: 1 })));
      if (kind === "detail_image") current.payload.detailAssetIds.push(...created.map((asset) => asset.id));
      if (kind === "face_image") current.payload.faceAssetId = created.at(-1)?.id;
      if (kind === "scene_image") current.payload.sceneAssetId = created.at(-1)?.id;
      if (kind === "audio") current.payload.audioAssetId = created.at(-1)?.id;
      return current;
    });
    return NextResponse.json({ task, assets: created }, { status: 201 });
  } catch (error) {
    await Promise.all([...createdPaths].map((filePath) => unlink(filePath).catch(() => undefined)));
    return NextResponse.json({ error: error instanceof Error ? error.message : "上传失败。" }, { status: 400 });
  }
}
