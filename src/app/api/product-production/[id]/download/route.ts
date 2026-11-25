import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import { productProductionAsset, productProductionAssetPath } from "@/lib/product-production";
import { streamZip, zipSizeUpperBound } from "@/lib/streaming-zip";

export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  const kind = req.nextUrl.searchParams.get("kind");
  try {
    const files = await Promise.all(access.task.payload.jobs.filter((job) => job.status === "done" && job.kind !== "product_master" && (!kind || job.kind === kind)).map(async (job) => {
      const asset = productProductionAsset(access.task, job.outputAssetId);
      if (!asset) throw new Error("结果素材缺失，请刷新。");
      const filePath = productProductionAssetPath(access.task, asset.id);
      const info = await stat(filePath);
      if (!info.isFile() || !info.size) throw new Error("结果文件不可读。");
      return { path: filePath, name: `${asset.name}${asset.name.toLowerCase().endsWith(path.extname(filePath).toLowerCase()) ? "" : path.extname(filePath)}`, size: info.size };
    }));
    if (!files.length) throw new Error("当前没有可下载的结果。");
    if (files.length > 65535 || zipSizeUpperBound(files) > 0xffffffff) throw new Error("批次过大，请分类型下载。");
    return new NextResponse(Readable.toWeb(Readable.from(streamZip(files))) as ReadableStream<Uint8Array>, {
      headers: { "Content-Type": "application/zip", "Cache-Control": "private, no-store", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${access.task.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}-${kind === "video" ? "视频" : kind === "detail" ? "详情图" : "结果"}.zip`)}` },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "下载失败。" }, { status: 400 });
  }
}
