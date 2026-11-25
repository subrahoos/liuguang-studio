import { NextRequest, NextResponse } from "next/server";
import {
  cleanupCloudinaryVideoReferences,
  mergeVideoReferenceHostingSetting,
  uploadCloudinaryVideoReference,
} from "@/lib/cloudinary-video-reference-hosting";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import {
  resolveGlobalVideoReferenceHosting,
  resolveGlobalVideoReferenceHostingCredentials,
} from "@/lib/model-pool";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";

export const runtime = "nodejs";

const TEST_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const existing = await resolveGlobalVideoReferenceHosting();
    const existingCredentials = await resolveGlobalVideoReferenceHostingCredentials();
    const setting = mergeVideoReferenceHostingSetting(
      body.setting as VideoReferenceHostingSetting | undefined,
      existing ? { ...existing, ...existingCredentials } : undefined,
    );
    if (!setting) {
      return NextResponse.json({ ok: false, error: "请先填写 Cloudinary 配置。" }, { status: 400 });
    }

    const startedAt = Date.now();
    const asset = await uploadCloudinaryVideoReference({
      source: TEST_IMAGE_DATA_URL,
      setting,
      ownerId: admin.id,
      scopeId: "connection-test",
      referenceId: "pixel",
    });
    const cleanup = await cleanupCloudinaryVideoReferences(setting, [asset]);
    return NextResponse.json({
      ok: true,
      message: cleanup.failed === 0
        ? "Cloudinary 上传、HTTPS 回传和临时文件清理均已通过。"
        : "Cloudinary 上传和 HTTPS 回传已通过，但测试文件清理失败，请检查密钥权限。",
      durationMs: Date.now() - startedAt,
      cleanup,
    });
  } catch (error) {
    return handleAuthRouteError(error)
      ?? NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "Cloudinary 托管测试失败。" },
        { status: 502 },
      );
  }
}
