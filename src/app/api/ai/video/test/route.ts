import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAdmin } from "@/lib/auth";
import { resolveGlobalVideoChannel } from "@/lib/model-pool";
import { verifyRjmusGrokVideoChannel } from "@/lib/rjmus-grok-video";

const TIMEOUT_MS = 60_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeBaseUrl(baseUrl)
    .replace(/\/v1\/videos(?:\/.*)?$/i, "")
    .replace(/\/v1\/video\/generations(?:\/.*)?$/i, "")
    .replace(/\/v1\/images\/edits$/i, "")
    .replace(/\/v1\/images\/generations$/i, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
  const rawPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const path = rawPath.replace(/^\/v1(?=\/)/i, "");
  return `${base}/v1${path}`;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1000);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Video API connection test timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isRjmAsyncVideoBaseUrl(baseUrl: string) {
  return /^https:\/\/video\.rjm\.us\.ci(?:\/|$)/i.test(normalizeBaseUrl(baseUrl));
}

function isLingganyaAsyncVideoBaseUrl(baseUrl: string) {
  return /^https:\/\/(?:www\.)?lingganyaapi\.com(?:\/|$)/i.test(normalizeBaseUrl(baseUrl));
}

function normalizedPath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") ? path.replace(/\/+$/, "") || "/" : "";
}

function isRjmMultimediaChannel(input: {
  baseUrl: string;
  submitPath?: string;
  statusPath?: string;
  contentPath?: string;
  maxReferenceVideos?: number;
  maxReferenceAudios?: number;
}) {
  return isRjmAsyncVideoBaseUrl(input.baseUrl)
    && (Number(input.maxReferenceVideos || 0) > 0 || Number(input.maxReferenceAudios || 0) > 0)
    && normalizedPath(input.submitPath) === "/videos"
    && normalizedPath(input.statusPath) === "/videos/{id}"
    && normalizedPath(input.contentPath) === "/videos/{id}/content";
}

export async function POST(req: NextRequest) {
  const actor = await getSessionUser(req);
  if (!actor || !isAdmin(actor)) return NextResponse.json({ error: "需要管理员权限。" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  const savedChannel = channelId
    ? await resolveGlobalVideoChannel(actor.id, channelId, "full_video")
    : null;
  if (!savedChannel || savedChannel.id !== channelId || !savedChannel.apiKey || !savedChannel.baseUrl || !savedChannel.model) {
    return NextResponse.json({ error: "未找到该用户已保存且完整的视频通道凭证" }, { status: 400 });
  }
  const {
    baseUrl,
    apiKey,
    model,
    submitPath,
    statusPath,
    contentPath,
    maxReferenceVideos,
    maxReferenceAudios,
  } = savedChannel;

  if (!baseUrl || !apiKey || !model) {
    return NextResponse.json(
      { error: "Please fill in this video channel's Base URL, API key, and model name." },
      { status: 400 }
    );
  }

  try {
    const isMikotoCatalogueChannel = savedChannel.videoProtocol === "mikoto"
      || savedChannel.videoProtocol === "mikoto_sora";
    if (isMikotoCatalogueChannel) {
      const result = await verifyRjmusGrokVideoChannel({
        id: savedChannel.id,
        baseUrl,
        apiKey,
        model,
        videoProtocol: savedChannel.videoProtocol,
        submitPath,
        statusPath,
        contentPath,
        durationOptions: savedChannel.durationOptions,
        maxReferenceImages: savedChannel.maxReferenceImages,
        maxReferenceVideos,
        maxReferenceAudios,
        directVideoReplacementSceneOptional: savedChannel.directVideoReplacementSceneOptional,
        directVideoReplacementFaceOptional: savedChannel.directVideoReplacementFaceOptional,
        directVideoReplacementReferenceContract: savedChannel.directVideoReplacementReferenceContract,
      });
      return NextResponse.json({
        ok: true,
        hasModel: result.modelVisible,
        modelCount: result.modelIds.length,
        message: result.modelVisible
          ? `Mikoto API connected. Model ${model} is available. This test did not submit a generation task, so it will not create cost.`
          : `Mikoto API connected, but /models did not list ${model}. This test did not submit a generation task, so it will not create cost.`,
      });
    }
    if (isLingganyaAsyncVideoBaseUrl(baseUrl)) {
      const modelsResponse = await fetchWithTimeout(openAIEndpoint(baseUrl, "/models"), {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!modelsResponse.ok) {
        return NextResponse.json({
          error: `Lingganya model catalogue request failed (HTTP ${modelsResponse.status}): ${await readError(modelsResponse)}`,
        }, { status: 502 });
      }
      const payload = await modelsResponse.json().catch(() => ({}));
      const modelIds = (Array.isArray(payload.data) ? payload.data : [])
        .map((item: unknown) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") {
            const record = item as { id?: unknown; name?: unknown; model?: unknown };
            return String(record.id || record.name || record.model || "").trim();
          }
          return "";
        })
        .filter(Boolean);
      const hasModel = modelIds.includes(model);
      return NextResponse.json({
        ok: hasModel,
        hasModel,
        modelCount: modelIds.length,
        message: hasModel
          ? `Lingganya API connected. Model ${model} is available. This test did not submit a generation task, so it will not create cost.`
          : `Lingganya API connected, but this key did not list ${model}. Select an exact model name from the account's /models response before creating a paid task.`,
      });
    }
    if (isRjmAsyncVideoBaseUrl(baseUrl) || /omni/i.test(model) || /grok.*video|grok-imagine/i.test(model) || /video\/generations/i.test(String(submitPath || ""))) {
      const rjmAsyncVideo = isRjmAsyncVideoBaseUrl(baseUrl);
      const rjmMultimedia = isRjmMultimediaChannel({
        baseUrl,
        submitPath,
        statusPath,
        contentPath,
        maxReferenceVideos,
        maxReferenceAudios,
      });
      const modelsResponse = await fetchWithTimeout(openAIEndpoint(baseUrl, rjmMultimedia ? "/models" : rjmAsyncVideo ? "/models?type=video" : "/models"), {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (modelsResponse.ok) {
        const payload = await modelsResponse.json().catch(() => ({}));
        const models = Array.isArray(payload.data) ? payload.data : [];
        const modelIds = models
          .map((item: { id?: string }) => item.id)
          .filter((id: unknown): id is string => typeof id === "string");
        const hasModel = modelIds.includes(model);
        return NextResponse.json({
          ok: true,
          hasModel,
          modelListAdvisory: !hasModel,
          modelCount: modelIds.length,
          message: hasModel
            ? `Video API connected. Model ${model} is available. This test did not submit a generation task, so it will not create cost.`
            : `Video API connected. /models did not list ${model}, which is advisory for this async video channel; actual model permission is verified when a video task is submitted. This test did not submit a generation task, so it will not create cost.`,
        });
      }

      const fakeTaskId = `codex_connection_test_${Date.now()}`;
        const defaultStatusPath = rjmMultimedia
          ? "/videos/{id}"
          : rjmAsyncVideo
          ? "/videos/tasks/{id}"
          : /grok.*video|grok-imagine/i.test(model)
            ? "/videos/{id}"
        : "/video/generations/{id}";
      const endpoint = openAIEndpoint(
        baseUrl,
        String(statusPath || defaultStatusPath).replace("{id}", fakeTaskId).replace("{task_id}", fakeTaskId)
      );
      const response = await fetchWithTimeout(endpoint, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      const detail = await readError(response);
      if (response.ok || response.status === 400 || response.status === 404 || response.status === 422) {
        return NextResponse.json({
          ok: true,
          hasModel: true,
          message: `Video status endpoint is reachable and authenticated. This test used a fake task id and did not submit a generation task, so it will not create cost.`,
        });
      }
      return NextResponse.json(
        {
          error: "Video API connection failed.",
          detail: `${response.status} ${response.statusText}: ${detail.slice(0, 1000)}`,
        },
        { status: 502 }
      );
    }

    const response = await fetchWithTimeout(openAIEndpoint(baseUrl, "/models"), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Video API connection failed.",
          detail: `${response.status} ${response.statusText}: ${await readError(response)}`,
        },
        { status: 502 }
      );
    }

    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload.data) ? payload.data : [];
    const modelIds = models
      .map((item: { id?: string }) => item.id)
      .filter((id: unknown): id is string => typeof id === "string");
    const hasModel = modelIds.includes(model);
    const seedanceModels = modelIds.filter((id: string) => /seedance/i.test(id)).slice(0, 12);

    return NextResponse.json({
      ok: true,
      hasModel,
      modelCount: modelIds.length,
      seedanceModels,
      message: hasModel
        ? `Video API connected. Model ${model} is available.`
        : `Video API connected, but /models did not list ${model}. Available Seedance models: ${seedanceModels.join(", ") || "none"}.`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 }
    );
  }
}
