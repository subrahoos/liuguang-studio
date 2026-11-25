import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAdmin } from "@/lib/auth";
import { resolveGlobalLLMSetting } from "@/lib/model-pool";

export const runtime = "nodejs";

const TIMEOUT_MS = 300_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

type TestResult = {
  ok: boolean;
  method: "responses-audio" | "chat-audio";
  text?: string;
  error?: string;
};

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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Request timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function extractText(payload: unknown): string {
  const body = payload as {
    text?: string;
    output_text?: string;
    transcription?: string;
    data?: { text?: string };
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof body.text === "string") return body.text;
  if (typeof body.output_text === "string") return body.output_text;
  if (typeof body.transcription === "string") return body.transcription;
  if (typeof body.data?.text === "string") return body.data.text;
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("\n");
  }
  return body.choices?.[0]?.message?.content || "";
}

function inferAudioFormat(file: File): "wav" | "mp3" | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (type.includes("wav") || name.endsWith(".wav")) return "wav";
  if (type.includes("mpeg") || type.includes("mp3") || name.endsWith(".mp3")) return "mp3";
  return null;
}

async function audioData(file: File): Promise<{ data: string; format: "wav" | "mp3" } | { error: string }> {
  const format = inferAudioFormat(file);
  if (!format) {
    return {
      error: "当前音频能力测试只接收 WAV 或 MP3；请转换后重新上传。",
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return { data: buffer.toString("base64"), format };
}

const TRANSCRIPTION_INSTRUCTION = "Transcribe the spoken audio faithfully. Return only the spoken words in the original language, with no label, summary, or explanation.";
const AUDIO_NOT_RECEIVED_PATTERNS = [
  /please\s+(?:upload|provide|attach|send)\s+(?:(?:an?|the)\s+)?audio(?:\s+(?:file|clip|recording))?/i,
  /(?:i\s+)?(?:can(?:not|'t)|cannot|unable to)\s+(?:process|transcribe|hear|access).{0,48}audio/i,
  /(?:no|without)\s+audio(?:\s+(?:file|input|attachment|content))?.{0,48}(?:provided|received|attached)/i,
  /请.{0,12}(?:上传|提供|附上).{0,12}音频/,
  /(?:未|没有).{0,12}(?:收到|检测到).{0,12}音频/,
  /无法.{0,16}(?:处理|转写|识别).{0,16}音频/,
];

function rejectMissingAudioReply(text: string, method: TestResult["method"]): TestResult | null {
  if (!AUDIO_NOT_RECEIVED_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return {
    ok: false,
    method,
    error: `The model returned a non-transcription reply, so the audio input was not accepted: ${text.slice(0, 240)}`,
  };
}

async function testResponsesAudio(baseUrl: string, apiKey: string, model: string, file: File): Promise<TestResult> {
  const audio = await audioData(file);
  if ("error" in audio) return { ok: false, method: "responses-audio", error: audio.error };

  const response = await fetchWithTimeout(openAIEndpoint(baseUrl, "/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: TRANSCRIPTION_INSTRUCTION,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: TRANSCRIPTION_INSTRUCTION },
            { type: "input_audio", input_audio: { data: audio.data, format: audio.format } },
          ],
        },
      ],
      max_output_tokens: 300,
    }),
  });

  if (!response.ok) {
    return { ok: false, method: "responses-audio", error: `${response.status} ${response.statusText}: ${await readError(response)}` };
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractText(payload).trim();
  const rejected = rejectMissingAudioReply(text, "responses-audio");
  if (rejected) return rejected;
  return text
    ? { ok: true, method: "responses-audio", text }
    : { ok: false, method: "responses-audio", error: "responses returned HTTP success but no transcription text." };
}

async function testChatAudio(baseUrl: string, apiKey: string, model: string, file: File): Promise<TestResult> {
  const audio = await audioData(file);
  if ("error" in audio) return { ok: false, method: "chat-audio", error: audio.error };

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
            { type: "text", text: TRANSCRIPTION_INSTRUCTION },
            { type: "input_audio", input_audio: { data: audio.data, format: audio.format } },
          ],
        },
      ],
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    return { ok: false, method: "chat-audio", error: `${response.status} ${response.statusText}: ${await readError(response)}` };
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractText(payload).trim();
  const rejected = rejectMissingAudioReply(text, "chat-audio");
  if (rejected) return rejected;
  return text
    ? { ok: true, method: "chat-audio", text }
    : { ok: false, method: "chat-audio", error: "chat/completions returned HTTP success but no transcription text." };
}

async function runSafely(method: TestResult["method"], run: () => Promise<TestResult>): Promise<TestResult> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, method, error: errorMessage(error) };
  }
}

export async function POST(req: NextRequest) {
  const actor = await getSessionUser(req);
  if (!isAdmin(actor)) return NextResponse.json({ error: "需要管理员权限。" }, { status: 403 });
  try {
    const form = await req.formData();
    const resolved = actor ? await resolveGlobalLLMSetting(actor.id) : null;
    const baseUrl = resolved?.baseUrl?.trim() || "";
    const apiKey = resolved?.apiKey?.trim() || "";
    const model = resolved?.model?.trim() || "";
    const file = form.get("file");

    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json(
        { error: "所选用户尚未配置完整的 LLM 通道凭证。" },
        { status: 400 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Please upload an audio or short video test file." },
        { status: 400 }
      );
    }

    if (!file.type.startsWith("audio/")) {
      return NextResponse.json(
        { error: "The test file must be an MP3 or WAV audio file." },
        { status: 400 }
      );
    }

    if (file.size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "The test file cannot exceed 50MB." },
        { status: 400 }
      );
    }

    const errors: Record<string, string> = {};
    const tests: Array<() => Promise<TestResult>> = [
      () => runSafely("responses-audio", () => testResponsesAudio(baseUrl, apiKey, model, file)),
      () => runSafely("chat-audio", () => testChatAudio(baseUrl, apiKey, model, file)),
    ];

    for (const run of tests) {
      const result = await run();
      if (result.ok) {
        return NextResponse.json({
          ok: true,
          model,
          method: result.method,
          message: `${model} 已通过音频转写请求；请人工核对下方模型原始转写。`,
          transcription: result.text,
        });
      }
      errors[result.method] = result.error || "failed";
    }

    return NextResponse.json(
      {
        error: `Audio input test failed for ${model}. This means the current GPT-compatible endpoint did not accept audio through responses or chat/completions.`,
        responsesAudioError: errors["responses-audio"],
        chatAudioError: errors["chat-audio"],
      },
      { status: 502 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 }
    );
  }
}
