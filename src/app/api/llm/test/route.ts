import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAdmin } from "@/lib/auth";
import { resolveGlobalLLMSetting } from "@/lib/model-pool";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1\/images\/edits$/i, "")
    .replace(/\/v1\/images\/generations$/i, "")
    .replace(/\/v1\/videos(?:\/.*)?$/i, "")
    .replace(/\/v1$/i, "");
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizeBaseUrl(baseUrl)}/v1${path}`;
}

function createProbe() {
  const token = randomBytes(6).toString("hex").toUpperCase();
  const prompt = `Reply exactly with OK:${token}. No extra words.`;
  return { token, prompt };
}

async function readResponseText(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).slice(0, 2000);
}

function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";

  return choices
    .map((choice) => {
      const message = (choice as { message?: { content?: unknown } }).message;
      const content = message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const item = part as { text?: unknown; content?: unknown };
            return typeof item.text === "string"
              ? item.text
              : typeof item.content === "string"
                ? item.content
                : "";
          })
          .join("");
      }
      return "";
    })
    .join("\n")
    .trim();
}

async function realChatProbe(baseUrl: string, apiKey: string, model: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const probe = createProbe();

  try {
    const response = await fetch(openAIEndpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "daihuo-jianshou/1.0",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: probe.prompt }],
        max_tokens: 24,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const rawText = await readResponseText(response);
    let payload: unknown = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = { raw: rawText };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        probe,
        error: rawText || `${response.status} ${response.statusText}`,
      };
    }

    const reply = extractChatText(payload);
    if (!reply) {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        probe,
        error: `chat/completions returned no assistant text: ${rawText.slice(0, 800)}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      probe,
      reply,
      tokenMatched: reply.includes(probe.token),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "request_failed",
      probe,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(await getSessionUser(req))) return NextResponse.json({ error: "需要管理员权限。" }, { status: 403 });
  await req.json().catch(() => ({}));
  const actor = await getSessionUser(req);
  const resolved = actor ? await resolveGlobalLLMSetting(actor.id) : null;
  const { baseUrl, apiKey, model } = resolved ?? {};

  if (!baseUrl || !apiKey || !model) {
    return NextResponse.json(
      { ok: false, error: "请填写 baseUrl、API Key 和模型名" },
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  const result = await realChatProbe(baseUrl, apiKey, model);
  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        message: "真实随机小流量验证失败：chat/completions 未返回可用回复",
        method: "chat/completions",
        model,
        durationMs,
        probePrompt: result.probe.prompt,
        probeToken: result.probe.token,
        error: result.error,
        status: result.status,
        statusText: result.statusText,
      },
      { status: result.status && result.status >= 400 ? result.status : 502 }
    );
  }

  const reply = typeof result.reply === "string" ? result.reply : "";
  if (!reply) {
    return NextResponse.json(
      {
        ok: false,
        message: "真实随机小流量验证失败：chat/completions 未返回可用回复",
        method: "chat/completions",
        model,
        durationMs,
        probePrompt: result.probe.prompt,
        probeToken: result.probe.token,
        error: "empty assistant reply",
      },
      { status: 502 }
    );
  }

  if (!result.tokenMatched) {
    return NextResponse.json(
      {
        ok: false,
        message: `真实随机小流量验证失败：模型回复未带回本次随机口令。回复：${reply.slice(0, 120)}`,
        method: "chat/completions",
        model,
        durationMs,
        probePrompt: result.probe.prompt,
        probeToken: result.probe.token,
        reply,
        tokenMatched: false,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: `真实随机小流量验证通过：模型已按本次随机口令回复「${reply.slice(0, 120)}」`,
    method: "chat/completions",
    model,
    durationMs,
    probePrompt: result.probe.prompt,
    probeToken: result.probe.token,
    reply,
    tokenMatched: true,
  });
}
