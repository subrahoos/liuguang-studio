/**
 * 脚本生成器
 * 使用 OpenAI 兼容格式调用 LLM 生成带货短视频脚本
 * 支持自定义 LLM endpoint、流式输出、商品图片分析
 */

import OpenAI from "openai";
import {
  SYSTEM_PROMPT,
  PRODUCT_ANALYSIS_PROMPT,
  buildUserPrompt,
  buildBatchPrompt,
  type ScriptGenerationInput,
} from "./prompts";
import type { Shot } from "@/lib/db/schema";
import { auditModelApiCall, normalizeModelApiUsage, type ModelApiAuditContext } from "@/lib/model-api-audit";

const LLM_REQUEST_TIMEOUT_MS = 0;
const VISION_REQUEST_TIMEOUT_MS = 0;

// ==================== 类型定义 ====================

/** LLM 配置 */
export interface LLMConfig {
  /** API 地址（兼容 OpenAI 格式的任意 endpoint） */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 文本模型名称 */
  model: string;
  /** 视觉模型名称（用于商品图片分析，不指定则使用 model） */
  visionModel?: string;
  /** Server-only audit metadata. It is never included in an LLM request. */
  audit?: Omit<ModelApiAuditContext, "callType" | "model">;
}

/** 脚本生成输入参数 */
export interface ScriptInput extends ScriptGenerationInput {
  /** LLM 配置 */
  llmConfig: LLMConfig;
}

/** 生成的脚本结果 */
export interface GeneratedScript {
  /** 脚本标题 */
  title: string;
  /** 脚本风格 */
  styleType: string;
  /** 总时长（秒） */
  totalDuration: number;
  /** 分镜列表 */
  shots: Shot[];
}

/** 流式输出回调 */
export interface StreamCallbacks {
  /** 收到文本片段时触发 */
  onToken?: (token: string) => void;
  /** 生成完成时触发 */
  onComplete?: (scripts: GeneratedScript[]) => void;
  /** 发生错误时触发 */
  onError?: (error: Error) => void;
}

/** 商品分析结果 */
export interface ProductAnalysisResult {
  /** 商品名称 */
  productName: string;
  /** 品类 */
  category: string;
  /** 品牌 */
  brand: string;
  /** 视觉特征 */
  visualFeatures: {
    mainColor: string;
    designStyle: string;
    productForm: string;
    texture: string;
  };
  /** 卖点列表 */
  sellingPoints: string[];
  /** 目标用户 */
  targetAudience: string;
  /** 使用场景 */
  usageScenarios: string[];
  /** 痛点 */
  painPoints: string[];
  /** 视频建议 */
  videoSuggestions: {
    recommendedAngles: string[];
    keyVisuals: string[];
    suggestedStyle: string;
  };
}

// ==================== 工具函数 ====================

/** 创建 OpenAI 客户端 */
function createClient(config: LLMConfig): OpenAI {
  return new OpenAI({
    baseURL: openAIBaseUrl(config.baseUrl),
    apiKey: config.apiKey,
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAIBaseUrl(baseUrl: string): string {
  const base = normalizeOpenAIBaseUrl(baseUrl);
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeOpenAIBaseUrl(baseUrl).replace(/\/v1$/i, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}/v1${path}`;
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl)
    .replace(/\/v1\/chat\/completions$/i, "/v1")
    .replace(/\/v1\/responses$/i, "/v1")
    .replace(/\/v1\/images\/edits$/i, "/v1")
    .replace(/\/v1\/images\/generations$/i, "/v1")
    .replace(/\/v1\/videos(?:\/.*)?$/i, "/v1");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function auditContext(config: LLMConfig, sourceSuffix: string, model: string): ModelApiAuditContext | undefined {
  if (!config.audit) return undefined;
  return {
    ...config.audit,
    callType: "llm",
    model,
    source: `${config.audit.source}.${sourceSuffix}`,
  };
}

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { code: "API_ERROR", statusCode: status });
}

function responseText(payload: unknown): string {
  const body = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .filter((content) => content.type === "output_text" || typeof content.text === "string")
      .map((content) => content.text || "")
      .join("\n");
  }
  return body.choices?.[0]?.message?.content || "";
}

async function requestResponses(
  config: LLMConfig,
  body: Record<string, unknown>,
  timeoutMs = LLM_REQUEST_TIMEOUT_MS,
): Promise<string> {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const execute = async () => {
      const response = await fetch(openAIEndpoint(config.baseUrl, "/responses"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      const raw = await response.text();
      let payload: unknown = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = { raw };
      }

      if (!response.ok) {
        const parsed = payload as { error?: { message?: string } | string; message?: string; raw?: string };
        const message = typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message || parsed.message || parsed.raw || raw || `HTTP ${response.status}`;
        throw httpError(message, response.status);
      }

      const text = responseText(payload);
      if (!text) throw new Error("Responses API 未返回有效文本");
      return { text, status: response.status, usage: normalizeModelApiUsage((payload as { usage?: unknown }).usage) };
    };
    const context = auditContext(config, "responses", String(body.model || config.model));
    const result = context
      ? await auditModelApiCall(context, execute, { toResult: (value) => ({ httpStatus: value.status, usage: value.usage }) })
      : await execute();
    return result.text;
  } catch (error) {
    if (timeoutMs > 0 && error instanceof Error && error.name === "AbortError") {
      throw new Error(`Responses API 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateTextWithResponses(
  config: LLMConfig,
  prompt: string,
  maxOutputTokens: number,
): Promise<string> {
  return requestResponses(config, {
    model: config.model,
    instructions: SYSTEM_PROMPT,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    max_output_tokens: maxOutputTokens,
  }, LLM_REQUEST_TIMEOUT_MS);
}

async function generateTextWithChat(
  config: LLMConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const client = createClient(config);
  const requestOptions = LLM_REQUEST_TIMEOUT_MS > 0 ? { timeout: LLM_REQUEST_TIMEOUT_MS } : undefined;
  const execute = () => client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.8,
    max_tokens: maxTokens,
  }, requestOptions);
  const context = auditContext(config, "chat", config.model);
  const response = context
    ? await auditModelApiCall(context, execute, { toResult: (value) => ({ usage: normalizeModelApiUsage(value.usage) }) })
    : await execute();
  const content = response.choices[0]?.message?.content || "";
  if (!content) throw new Error("Chat Completions 未返回有效文本");
  return content;
}

async function analyzeProductWithResponses(
  imageUrls: string[],
  config: LLMConfig,
  model: string,
  contextPrompt = PRODUCT_ANALYSIS_PROMPT,
): Promise<string> {
  return requestResponses(config, {
    model,
    instructions: "你是电商商品视觉分析助手，所有输出使用中文。",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: contextPrompt },
          ...imageUrls.map((url) => ({
            type: "input_image",
            image_url: url,
            detail: "high",
          })),
        ],
      },
    ],
    max_output_tokens: 2000,
  }, VISION_REQUEST_TIMEOUT_MS);
}

/**
 * 从 LLM 返回的文本中提取 JSON
 * 兼容直接输出 JSON 和包裹在 markdown 代码块中的情况
 */
export function extractJSON(text: string): string {
  // 尝试移除 markdown 代码块标记
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 尝试找到第一个 { 或 [ 开头的 JSON
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  return text.trim();
}

/**
 * 验证并修正单个 Shot 数据
 * 确保所有必填字段都有合法值
 */
function validateShot(shot: Partial<Shot>, index: number): Shot {
  const validTypes: Shot["type"][] = ["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"];
  const validTransitions: Shot["transition"][] = ["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"];
  const validSources: Shot["visualSource"][] = ["ai_generate", "product_image", "user_upload"];
  const cleanPrompt = typeof shot.prompt === "string"
    ? shot.prompt.replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
  const hasUsableEnglishPrompt = /\b(keyframe|shot|camera|product|model|scene|light|single|vertical|no text)\b/i.test(cleanPrompt);

  return {
    shotId: shot.shotId || index + 1,
    type: validTypes.includes(shot.type as Shot["type"]) ? (shot.type as Shot["type"]) : "demo",
    duration: typeof shot.duration === "number" && shot.duration > 0 ? shot.duration : 3,
    description: shot.description || "",
    camera: shot.camera || "固定镜头",
    visualSource: validSources.includes(shot.visualSource as Shot["visualSource"]) ? (shot.visualSource as Shot["visualSource"]) : "ai_generate",
    transition: validTransitions.includes(shot.transition as Shot["transition"]) ? (shot.transition as Shot["transition"]) : "direct_concat",
    voiceover: shot.voiceover || "",
    prompt: hasUsableEnglishPrompt ? cleanPrompt : undefined,
  };
}

/**
 * 验证并修正完整的脚本数据
 */
function validateScript(raw: Record<string, unknown>, fallbackStyleType: string): GeneratedScript {
  const shots = Array.isArray(raw.shots)
    ? (raw.shots as Partial<Shot>[]).map((s, i) => validateShot(s, i))
    : [];

  const totalDuration = typeof raw.totalDuration === "number"
    ? raw.totalDuration
    : shots.reduce((sum, s) => sum + s.duration, 0);

  return {
    title: (raw.title as string) || "未命名脚本",
    styleType: (raw.styleType as string) || fallbackStyleType,
    totalDuration,
    shots,
  };
}

// ==================== 核心功能 ====================

/**
 * 生成带货脚本（单次调用，返回完整结果）
 * @param input - 脚本生成输入参数
 * @returns 生成的脚本数组
 */
export async function generateScript(input: ScriptInput): Promise<GeneratedScript[]> {
  const userPrompt = buildBatchPrompt(input, 1);

  // 调用 LLM 生成脚本
  let content = "";
  try {
    content = await generateTextWithChat(input.llmConfig, userPrompt, 6000);
  } catch (chatError: unknown) {
    try {
      content = await generateTextWithResponses(input.llmConfig, userPrompt, 6000);
    } catch (responsesError: unknown) {
      throw new Error(
        `LLM 请求失败（模型: ${input.llmConfig.model}，地址: ${input.llmConfig.baseUrl}）` +
        `；chat/completions: ${errorMessage(chatError)}；responses: ${errorMessage(responsesError)}`,
      );
    }
  }

  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  return parseScriptResponse(content, input.styleType);
}

/**
 * 生成单个脚本（更快的响应）
 * @param input - 脚本生成输入参数
 * @returns 单个生成的脚本
 */
export async function generateSingleScript(input: ScriptInput): Promise<GeneratedScript> {
  const userPrompt = buildUserPrompt(input);

  let content = "";
  try {
    content = await generateTextWithChat(input.llmConfig, userPrompt, 4000);
  } catch (chatError: unknown) {
    try {
      content = await generateTextWithResponses(input.llmConfig, userPrompt, 4000);
    } catch (responsesError: unknown) {
      throw new Error(
        `LLM 请求失败（模型: ${input.llmConfig.model}，地址: ${input.llmConfig.baseUrl}）` +
        `；chat/completions: ${errorMessage(chatError)}；responses: ${errorMessage(responsesError)}`,
      );
    }
  }

  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  const jsonStr = extractJSON(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON: ${jsonStr.substring(0, 200)}`);
  }
  return validateScript(parsed, input.styleType);
}

/**
 * 流式生成脚本
 * 支持实时获取生成进度，适合前端流式展示
 * @param input - 脚本生成输入参数
 * @param callbacks - 流式回调函数
 * @returns AbortController 用于取消生成
 */
export function generateScriptStream(
  input: ScriptInput,
  callbacks: StreamCallbacks,
): AbortController {
  const abortController = new AbortController();

  const run = async () => {
    const client = createClient(input.llmConfig);
    const userPrompt = buildUserPrompt(input);

    let fullContent = "";

    try {
      const stream = await client.chat.completions.create({
        model: input.llmConfig.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
        stream: true,
      }, {
        signal: abortController.signal,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          callbacks.onToken?.(delta);
        }
      }

      // 流式结束后解析完整结果
      const scripts = parseScriptResponse(fullContent, input.styleType);
      callbacks.onComplete?.(scripts);
    } catch (error) {
      // 用户主动取消不算错误
      if (abortController.signal.aborted) return;
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  run();
  return abortController;
}

/**
 * 创建流式生成的 ReadableStream
 * 用于 Next.js API Route 的流式响应
 * @param input - 脚本生成输入参数
 * @returns ReadableStream
 */
export function createScriptStream(input: ScriptInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const client = createClient(input.llmConfig);
      const userPrompt = buildUserPrompt(input);

      try {
        const stream = await client.chat.completions.create({
          model: input.llmConfig.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.8,
          stream: true,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            controller.enqueue(encoder.encode(delta));
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

// ==================== 商品图片分析 ====================

/**
 * 分析商品图片
 * 调用视觉模型提取商品信息、卖点、目标用户等
 * @param imageUrls - 商品图片 URL 列表（支持 http/https 和 base64 data URI）
 * @param config - LLM 配置
 * @returns 商品分析结果的 JSON 字符串
 */
export async function analyzeProduct(
  imageUrls: string[],
  config: LLMConfig,
  contextPrompt = PRODUCT_ANALYSIS_PROMPT,
): Promise<string> {
  const client = createClient(config);
  const model = config.visionModel?.trim() || config.model;

  // 构建带图片的消息内容
  const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = imageUrls.map(
    (url) => ({
      type: "image_url" as const,
      image_url: { url, detail: "high" as const },
    }),
  );

  try {
    const execute = () => client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: contextPrompt },
            ...imageContent,
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }, VISION_REQUEST_TIMEOUT_MS > 0 ? {
      timeout: VISION_REQUEST_TIMEOUT_MS,
    } : undefined);
    const context = auditContext(config, "vision-chat", model);
    const response = context
      ? await auditModelApiCall(context, execute, { toResult: (value) => ({ usage: normalizeModelApiUsage(value.usage) }) })
      : await execute();
    const content = response.choices[0]?.message?.content || "";
    if (!content) throw new Error("Chat Completions 未返回商品图分析内容");
    return content;
  } catch {
    return await analyzeProductWithResponses(imageUrls, config, model, contextPrompt);
  }
}

/**
 * 分析商品图片并返回结构化数据
 * @param imageUrls - 商品图片 URL 列表
 * @param config - LLM 配置
 * @returns 结构化的商品分析结果
 */
export async function analyzeProductStructured(
  imageUrls: string[],
  config: LLMConfig,
): Promise<ProductAnalysisResult> {
  const rawResult = await analyzeProduct(imageUrls, config);
  const jsonStr = extractJSON(rawResult);
  try {
    return JSON.parse(jsonStr) as ProductAnalysisResult;
  } catch {
    throw new Error(`商品分析结果不是合法 JSON: ${jsonStr.substring(0, 200)}`);
  }
}

// ==================== 解析工具 ====================

/**
 * 解析 LLM 返回的脚本内容
 * 兼容多种返回格式（单个对象、数组、嵌套对象等）
 */
export function parseScriptResponse(content: string, fallbackStyleType: string): GeneratedScript[] {
  const jsonStr = extractJSON(content);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON: ${jsonStr.substring(0, 200)}`);
  }

  // 处理不同的返回格式
  let rawScripts: Record<string, unknown>[];

  if (Array.isArray(parsed)) {
    // 直接返回数组
    rawScripts = parsed;
  } else if (parsed.scripts && Array.isArray(parsed.scripts)) {
    // { scripts: [...] } 格式
    rawScripts = parsed.scripts;
  } else if (parsed.shots && Array.isArray(parsed.shots)) {
    // 单个脚本对象
    rawScripts = [parsed];
  } else {
    throw new Error("无法解析 LLM 返回的脚本格式");
  }

  return rawScripts.map((raw) => validateScript(raw, fallbackStyleType));
}
