import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import { readModelImageTestArtifact } from "@/lib/model-image-test";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) {
  try {
    const user = await requireAdmin(req);
    const { channelId } = await params;
    const artifact = await readModelImageTestArtifact(user.id, channelId);
    const bytes = await readFile(artifact.filePath);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": artifact.mimeType,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "未找到该通道的测试图片。" }, { status: 404 });
  }
}
