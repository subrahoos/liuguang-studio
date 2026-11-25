import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAdmin } from "@/lib/auth";
import { resolveGlobalLLMSetting } from "@/lib/model-pool";

const DEFAULT_COLOR_TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAsSURBVFhH7c4hAQAADASh61/6F2MGgafVPgkICAgICAgICAgICAgICDwH2gFUDfhqkE3cCgAAAABJRU5ErkJggg==";
const TIMEOUT_MS = 90_000;
type VisionTestMode = "fruit" | "color";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeBaseUrl(baseUrl)
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1\/images\/edits$/i, "")
    .replace(/\/v1\/images\/generations$/i, "")
    .replace(/\/v1\/videos(?:\/.*)?$/i, "")
    .replace(/\/v1$/i, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}/v1${path}`;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1200);
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

function extractText(payload: unknown): string {
  const body = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("\n");
  }
  return body.choices?.[0]?.message?.content || "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Request timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds`;
  }
  return error instanceof Error ? error.message : String(error);
}

function resolveTestImage(imageDataUrl: unknown): { image: string; source: string; mode: VisionTestMode } {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.trim()) {
    return { image: DEFAULT_COLOR_TEST_IMAGE, source: "built-in color test image", mode: "color" };
  }

  const image = imageDataUrl.trim();
  if (!image.startsWith("data:image/")) {
    throw new Error("Invalid test image. Please upload a JPG, PNG, or WebP image.");
  }
  return { image, source: "uploaded fruit test image", mode: "fruit" };
}

function testQuestion(mode: VisionTestMode) {
  return mode === "fruit"
    ? "Identify the fruit shown in this image. Reply with only the fruit name in Chinese, with no explanation."
    : "Identify the dominant color in this image. Reply with only the color name in Chinese, with no explanation.";
}

type TestResult = {
  ok: boolean;
  method: "responses" | "chat/completions";
  text?: string;
  error?: string;
};

async function testResponses(baseUrl: string, apiKey: string, model: string, imageDataUrl: string, mode: VisionTestMode): Promise<TestResult> {
  const response = await fetchWithTimeout(openAIEndpoint(baseUrl, "/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: "This is a visual recognition test. Follow the user's answer format exactly.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: testQuestion(mode) },
            { type: "input_image", image_url: imageDataUrl, detail: "low" },
          ],
        },
      ],
      max_output_tokens: 32,
    }),
  });

  if (!response.ok) {
    return { ok: false, method: "responses", error: `${response.status} ${response.statusText}: ${await readError(response)}` };
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractText(payload).trim();
  return text
    ? { ok: true, method: "responses", text }
    : { ok: false, method: "responses", error: "responses returned HTTP success but no visual answer text." };
}

async function testChatCompletions(baseUrl: string, apiKey: string, model: string, imageDataUrl: string, mode: VisionTestMode): Promise<TestResult> {
  const response = await fetchWithTimeout(openAIEndpoint(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: testQuestion(mode) },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
          ],
        },
      ],
      max_tokens: 32,
    }),
  });

  if (!response.ok) {
    return { ok: false, method: "chat/completions", error: `${response.status} ${response.statusText}: ${await readError(response)}` };
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractText(payload).trim();
  return text
    ? { ok: true, method: "chat/completions", text }
    : { ok: false, method: "chat/completions", error: "chat/completions returned HTTP success but no visual answer text." };
}

export async function POST(req: NextRequest) {
  const actor = await getSessionUser(req);
  if (!isAdmin(actor)) return NextResponse.json({ error: "需要管理员权限。" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const resolved = actor ? await resolveGlobalLLMSetting(actor.id) : null;
  const baseUrl = resolved?.baseUrl?.trim() || "";
  const apiKey = resolved?.apiKey?.trim() || "";
  const model = resolved?.visionModel?.trim() || resolved?.model?.trim() || "";
  const imageDataUrl = body.imageDataUrl;

  if (!baseUrl || !apiKey || !model) {
    return NextResponse.json(
      { error: "所选用户尚未配置完整的视觉模型通道凭证。" },
      { status: 400 }
    );
  }

  const { image, source, mode } = resolveTestImage(imageDataUrl);
  const expectedCapability = mode === "fruit" ? "水果识别" : "颜色识别";
  const errors: Record<string, string> = {};

  try {
    const responsesResult = await testResponses(baseUrl, apiKey, model, image, mode);
    if (responsesResult.ok) {
      return NextResponse.json({
        ok: true,
        method: responsesResult.method,
        model,
        source,
        expectedCapability,
        answer: responsesResult.text,
        message: `${model} 已通过${expectedCapability}请求；请人工核对下方模型原始回答。`,
      });
    }
    errors.responses = responsesResult.error || "responses failed";
  } catch (error) {
    errors.responses = errorMessage(error);
  }

  try {
    const chatResult = await testChatCompletions(baseUrl, apiKey, model, image, mode);
    if (chatResult.ok) {
      return NextResponse.json({
        ok: true,
        method: chatResult.method,
        model,
        source,
        expectedCapability,
        answer: chatResult.text,
        message: `${model} 已通过${expectedCapability}请求；请人工核对下方模型原始回答。`,
        responsesError: errors.responses,
      });
    }
    errors.chat = chatResult.error || "chat/completions failed";
  } catch (error) {
    errors.chat = errorMessage(error);
  }

  return NextResponse.json(
    {
      error: `Vision test request failed for ${model}. The model can still be vision-capable; this is a connection/request-format failure.` ,
      responsesError: errors.responses,
      chatError: errors.chat,
    },
    { status: 502 }
  );
}
