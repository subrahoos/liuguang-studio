import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import { resolveGlobalImageChannel } from "@/lib/model-pool";
import {
  MODEL_IMAGE_TEST_PROMPT,
  MODEL_IMAGE_TEST_REFERENCE,
  saveModelImageTestArtifact,
} from "@/lib/model-image-test";

export const runtime = "nodejs";

function imageEditPathFromChannel(endpointPath?: string) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/edits";
  return /\/images\/generations$/i.test(value)
    ? value.replace(/\/images\/generations$/i, "/images/edits")
    : value;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!channelId) return NextResponse.json({ error: "缺少要测试的生图通道。" }, { status: 400 });

    const channel = await resolveGlobalImageChannel(user.id, channelId);
    if (!channel || channel.id !== channelId) {
      return NextResponse.json({ error: "未找到已保存的生图通道。请先保存模型与 API 配置后再测试。" }, { status: 409 });
    }
    if (channel.enabled === false || !channel.apiKey?.trim() || !channel.baseUrl?.trim() || !channel.model?.trim()) {
      return NextResponse.json({ error: "该生图通道未启用或配置不完整。" }, { status: 400 });
    }

    const endpointPath = imageEditPathFromChannel(channel.endpointPath);
    const provider = createProvider({
      name: "openai-seedance",
      apiKey: channel.apiKey,
      baseUrl: channel.baseUrl,
      timeout: channel.requestTimeoutMs,
      extra: {
        imageApiKey: channel.apiKey,
        imageBaseUrl: channel.baseUrl,
        imageEditPath: endpointPath,
      },
    });

    const startedAt = Date.now();
    const result = await provider.generateImage({
      modelId: channel.model,
      mode: "image-to-image",
      prompt: MODEL_IMAGE_TEST_PROMPT,
      referenceImageUrl: MODEL_IMAGE_TEST_REFERENCE,
      width: 1024,
      height: 1024,
      count: 1,
      extra: { quality: "auto" },
    });
    const imageUrl = result.imageUrls[0];
    if (!imageUrl) throw new Error("上游没有返回测试图片。");

    const artifact = await saveModelImageTestArtifact({
      ownerId: user.id,
      channelId,
      imageUrl,
    });
    const durationMs = Date.now() - startedAt;
    const version = encodeURIComponent(artifact.createdAt);

    return NextResponse.json({
      ok: true,
      message: "真实生图、图片回传与本地保存均已通过。",
      model: channel.model,
      endpoint: endpointPath,
      durationMs,
      transport: artifact.transport,
      saved: true,
      previewUrl: `/api/ai/image/test/file/${encodeURIComponent(channelId)}?v=${version}`,
    });
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    const detail = providerError?.message || (error instanceof Error ? error.message : String(error));
    return handleAuthRouteError(error) ?? NextResponse.json({
      error: "真实生图测试失败。",
      detail,
      code: providerError?.code,
      statusCode: providerError?.statusCode,
    }, { status: providerError?.statusCode && providerError.statusCode >= 400 && providerError.statusCode < 600 ? providerError.statusCode : 502 });
  }
}
