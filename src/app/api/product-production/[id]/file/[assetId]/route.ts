import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import { productProductionAsset, productProductionAssetPath } from "@/lib/product-production";
import { parseByteRange } from "@/lib/http-byte-range";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string; assetId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id, assetId } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "素材不存在或无权访问。" }, { status: 404 });
  const asset = productProductionAsset(access.task, assetId);
  if (!asset) return NextResponse.json({ error: "素材不存在。" }, { status: 404 });
  try {
    const filePath = productProductionAssetPath(access.task, assetId);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const range = parseByteRange(req.headers.get("range"), info.size);
    if (range === "invalid") return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}`, "Cache-Control": "private, no-store" } });
    const stream = createReadStream(filePath, range || undefined);
    const filename = `${asset.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}${asset.name.toLowerCase().endsWith(path.extname(filePath).toLowerCase()) ? "" : path.extname(filePath)}`;
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(range ? range.end - range.start + 1 : info.size),
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}),
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch {
    return NextResponse.json({ error: "素材文件不可读。" }, { status: 404 });
  }
}
