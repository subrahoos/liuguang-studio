import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { resolveLLMSetting } from "@/lib/server-model-settings";
import { readFile } from "fs/promises";
import { extname } from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  createEdge,
  createNode,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  manualUpstreamNodeIds,
  startNodeExecution,
  updateBoardWorkflow,
  uniqueNodeIds,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import { auditModelApiCall } from "@/lib/model-api-audit";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
const TIMEOUT_MS = 300_000;
const TRANSCRIPT_TEXT_LIMIT = 8000;
const PRODUCT_TEXT_LIMIT = 1800;

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface VoiceoverPlan {
  transcriptChinese?: string;
  voiceoverMethodChinese?: string;
  productVoiceoverChinese?: string;
  timedVoiceover?: Array<{
    timeRange?: string;
    spokenLine?: string;
    visualSyncNote?: string;
  }>;
  speechStyleMethodChinese?: string;
  safetyNoteChinese?: string;
}

function roleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1$/i, "");
}

function endpoint(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}/v1${path.startsWith("/") ? path : `/${path}`}`;
}

function compactText(text: string, limit: number) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > limit ? normalized.slice(0, limit).trim() : normalized;
}

function nodeText(node?: BoardWorkflowNode) {
  if (!node) return "";
  return [
    node.text,
    node.promptChinese,
    node.promptEnglish,
    typeof node.meta?.rawText === "string" ? node.meta.rawText : "",
  ].filter(Boolean).join("\n\n");
}

function latestByRole(nodes: BoardWorkflowNode[], roles: string[]) {
  return nodes
    .filter((node) => roles.includes(roleOf(node)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function audioFormat(filePath: string): "mp3" | "wav" {
  return extname(filePath).toLowerCase() === ".wav" ? "wav" : "mp3";
}

function extractText(payload: unknown): string {
  const body = payload as {
    text?: string;
    output_text?: string;
    transcription?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  if (typeof body.text === "string") return body.text;
  if (typeof body.output_text === "string") return body.output_text;
  if (typeof body.transcription === "string") return body.transcription;
  if (Array.isArray(body.output)) {
    return body.output.flatMap((item) => item.content || []).map((content) => content.text || "").join("\n").trim();
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text || "").join("").trim();
  return "";
}

function extractJson(text: string): VoiceoverPlan | null {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const candidates = [cleaned, cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    try {
      return JSON.parse(candidate) as VoiceoverPlan;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let payload: unknown = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { raw };
    }
    return { ok: response.ok, status: response.status, statusText: response.statusText, raw, payload };
  } finally {
    clearTimeout(timer);
  }
}

function errorFromResponse(result: Awaited<ReturnType<typeof fetchJsonWithTimeout>>) {
  return `${result.status} ${result.statusText}: ${result.raw.slice(0, 1200)}`;
}

function buildPrompt(input: {
  workflowName: string;
  productEvidenceText: string;
  userRequirement: string;
  targetDuration: number;
  sourceTranscript?: string;
}) {
  return [
    "You are an ecommerce Mandarin voiceover director.",
    "Task: extract the reference voiceover method, then rewrite it into a usable Mandarin product voiceover for the current product.",
    "Do not clone, imitate, or identify the original speaker's real voice identity. Only preserve speech structure, pacing, pauses, tone category, sentence rhythm, selling logic, and emotional delivery.",
    "The rewritten voiceover must be about the current product, not the source product. If product facts are missing, use careful neutral ecommerce claims and mark uncertain details as generic.",
    "Keep the output compact and directly usable by the later Grok full-video director prompt.",
    "",
    "Return STRICT JSON only with this shape:",
    JSON.stringify({
      transcriptChinese: "完整中文转写，尽量保留口头语、停顿和句子顺序。",
      voiceoverMethodChinese: "口播方法拆解：钩子、痛点、卖点顺序、证明动作、转折、成交推动、语速和停顿。",
      productVoiceoverChinese: "鏀瑰啓鍚庣殑褰撳墠鍟嗗搧涓枃鍙ｆ挱鍏ㄦ枃",
      timedVoiceover: [{
        timeRange: "00:00-00:03",
        spokenLine: "这一段要说的中文原文。",
        visualSyncNote: "这句话对应的画面动作、手势或商品展示点。",
      }],
      speechStyleMethodChinese: "只描述节奏、语气、停顿、重音和口播表演，不描述声音身份。",
      safetyNoteChinese: "璇存槑鏈鍒荤湡瀹炲０闊宠韩浠斤紝鍙鍒诲彛鎾粨鏋勫拰鑺傚",
    }, null, 2),
    "",
    `Workflow: ${input.workflowName}`,
    `Target duration: ${input.targetDuration}s`,
    input.userRequirement ? `User requirement / product brief:\n${input.userRequirement}` : "",
    "Current product evidence from manually linked or current board nodes:",
    input.productEvidenceText || "No detailed product evidence text is available. Use conservative generic ecommerce wording and do not invent exact material claims.",
    input.sourceTranscript ? `Existing manually linked transcript or voiceover text:\n${input.sourceTranscript}` : "",
  ].filter(Boolean).join("\n");
}

async function runTextOnly(llm: LlmConfig, prompt: string) {
  return fetchJsonWithTimeout(endpoint(llm.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "daihuo-jianshou/1.0",
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.25,
      max_tokens: 4500,
    }),
  });
}

async function runResponsesAudio(llm: LlmConfig, prompt: string, audioBase64: string, format: "mp3" | "wav") {
  return fetchJsonWithTimeout(endpoint(llm.baseUrl, "/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "daihuo-jianshou/1.0",
    },
    body: JSON.stringify({
      model: llm.model,
      instructions: "Transcribe Mandarin ecommerce audio and rewrite it as current-product Mandarin voiceover. Return strict JSON only.",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_audio", input_audio: { data: audioBase64, format } },
        ],
      }],
      temperature: 0.25,
      max_output_tokens: 4500,
    }),
  });
}

async function runChatAudio(llm: LlmConfig, prompt: string, audioBase64: string, format: "mp3" | "wav") {
  return fetchJsonWithTimeout(endpoint(llm.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "daihuo-jianshou/1.0",
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "input_audio", input_audio: { data: audioBase64, format } },
        ],
      }],
      temperature: 0.25,
      max_tokens: 4500,
    }),
  });
}

function formatMethodText(parsed: VoiceoverPlan | null, rawText: string) {
  if (!parsed) return rawText;
  return [
    "# 口播转写与方法",
    parsed.transcriptChinese ? `## 瀹屾暣闊抽杞啓\n${parsed.transcriptChinese}` : "",
    parsed.voiceoverMethodChinese ? `## 鍙ｆ挱鏂规硶鎷嗚В\n${parsed.voiceoverMethodChinese}` : "",
    parsed.speechStyleMethodChinese ? `## 鍙ｆ挱琛ㄦ紨鏂规硶\n${parsed.speechStyleMethodChinese}` : "",
    parsed.safetyNoteChinese ? `## 瀹夊叏璇存槑\n${parsed.safetyNoteChinese}` : "",
  ].filter(Boolean).join("\n\n");
}

function formatVoiceoverPrompt(parsed: VoiceoverPlan | null, rawText: string) {
  if (!parsed) return rawText;
  const timing = (parsed.timedVoiceover || [])
    .map((item) => `- ${item.timeRange || ""} ${item.spokenLine || ""}${item.visualSyncNote ? `（画面同步：${item.visualSyncNote}）` : ""}`)
    .join("\n");
  return [
    "# 商品口播方法",
    parsed.productVoiceoverChinese || "",
    timing ? `\n## 鍒嗘鍙ｆ挱涓庣敾闈㈠悓姝n${timing}` : "",
  ].filter(Boolean).join("\n").trim();
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let inputNodeIds: string[] = [];
  let clientTaskId = "";
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const user = access.user;
    workflowId = id;
    const workflow = access.workflow;


    const body = await req.json();
    clientTaskId = String(body.clientTaskId || "");
    executorNodeId = String(body.executorNodeId || "");
    const llm = await resolveLLMSetting(req);
    const userRequirement = String(body.userRequirement || "");
    const targetDuration = Number(body.targetDuration || 20);

    if (!llm?.baseUrl || !llm.apiKey || !llm.model) {
      return NextResponse.json({ error: "请先配置可用的 LLM。" }, { status: 400 });
    }

    const upstreamIds = executorNodeId ? manualUpstreamNodeIds(workflow, [executorNodeId]) : [];
    const upstreamNodes = upstreamIds
      .map((nodeId) => workflow.nodes.find((node) => node.id === nodeId))
      .filter((node): node is BoardWorkflowNode => Boolean(node));
    const sourceNodes = executorNodeId ? upstreamNodes : workflow.nodes;
    const audioNode = sourceNodes
      .filter((node) => (roleOf(node) === "audio_evidence" || node.kind === "audio") && node.filePath)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const sourceTextNode = latestByRole(sourceNodes, ["voiceover_method", "product_voiceover_script", "voiceover_transcript"]);
    const sourceTranscript = compactText(nodeText(sourceTextNode), TRANSCRIPT_TEXT_LIMIT);

    if (!audioNode?.filePath && !sourceTranscript) {
      return NextResponse.json({
        error: executorNodeId
          ? "请先把音频或口播文本节点连接到当前 GPT 节点。"
          : "请先准备参考音频或口播文本，再生成商品口播。",
      }, { status: 400 });
    }

    const productNodes = [
      ...sourceNodes.filter((node) => roleOf(node) === "product_image"),
      ...workflow.nodes.filter((node) => roleOf(node) === "product_image"),
    ].filter((node, index, list) => list.findIndex((item) => item.id === node.id) === index).slice(0, 3);
    const productEvidenceText = compactText(productNodes
      .map((node, index) => `${index + 1}. ${node.title}: ${node.description || ""}`)
      .join("\n"), PRODUCT_TEXT_LIMIT);

    inputNodeIds = uniqueNodeIds([...upstreamIds, audioNode?.id || "", sourceTextNode?.id || "", ...productNodes.map((node) => node.id)]);
    if (executorNodeId) await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);

    const prompt = buildPrompt({
      workflowName: workflow.name,
      productEvidenceText,
      userRequirement,
      targetDuration,
      sourceTranscript,
    });

    let result;
    if (audioNode?.filePath) {
      const audioBase64 = (await readFile(audioNode.filePath)).toString("base64");
      const format = audioFormat(audioNode.filePath);
      result = await auditModelApiCall({
        userId: user.id,
        callType: "llm",
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        model: llm.visionModel?.trim() || llm.model,
        source: "board.voiceover.responses-audio",
        boardWorkflowId: id,
        boardNodeId: executorNodeId,
      }, () => runResponsesAudio(llm, prompt, audioBase64, format), {
        toResult: (value) => ({ httpStatus: value.status }),
        toError: (value) => value.ok ? undefined : { errorCode: "API_ERROR" },
      });
      if (!result.ok) {
        const firstError = errorFromResponse(result);
        result = await auditModelApiCall({
          userId: user.id,
          callType: "llm",
          providerKey: "openai-compatible",
          channelId: "llm-default",
          channelName: "LLM",
          model: llm.visionModel?.trim() || llm.model,
          source: "board.voiceover.chat-audio",
          boardWorkflowId: id,
          boardNodeId: executorNodeId,
        }, () => runChatAudio(llm, prompt, audioBase64, format), {
          toResult: (value) => ({ httpStatus: value.status }),
          toError: (value) => value.ok ? undefined : { errorCode: "API_ERROR" },
        });
        if (!result.ok) throw new Error(`闊抽鍙ｆ挱璇嗗埆澶辫触銆俁esponses: ${firstError}\nChat: ${errorFromResponse(result)}`);
      }
    } else {
      result = await auditModelApiCall({
        userId: user.id,
        callType: "llm",
        providerKey: "openai-compatible",
        channelId: "llm-default",
        channelName: "LLM",
        model: llm.model,
        source: "board.voiceover.text",
        boardWorkflowId: id,
        boardNodeId: executorNodeId,
      }, () => runTextOnly(llm, prompt), {
        toResult: (value) => ({ httpStatus: value.status }),
        toError: (value) => value.ok ? undefined : { errorCode: "API_ERROR" },
      });
      if (!result.ok) throw new Error(`鍙ｆ挱閲嶅啓澶辫触锛?{errorFromResponse(result)}`);
    }

    const rawText = extractText(result.payload).trim();
    if (!rawText) throw new Error("LLM 没有返回口播结果。");
    const parsed = extractJson(rawText);
    const latestWorkflow = await getBoardWorkflow(id, user.id) || workflow;
    if (
      isBoardTaskCancelled(id, clientTaskId) ||
      (executorNodeId && isNodeExecutionCancelled(latestWorkflow, executorNodeId))
    ) {
      return NextResponse.json({ workflow: latestWorkflow, cancelled: true });
    }

    const methodNode = createNode({
      kind: "analysis",
      title: "口播表达方法",
      description: "从参考音频或文本中提炼节奏、停顿、重音和表达方式。",
      text: formatMethodText(parsed, rawText),
      meta: {
        assetRole: "voiceover_method",
        rawText,
        parsed,
        sourceAudioNodeId: audioNode?.id || "",
        sourceTextNodeId: sourceTextNode?.id || "",
      },
      x: 520,
      y: 1180,
    });
    const voiceoverNode = createNode({
      kind: "prompt",
      title: "当前商品口播",
      description: "结合商品证据和表达方法改写的中文口播，可继续连接导演节点。",
      promptChinese: formatVoiceoverPrompt(parsed, rawText),
      meta: {
        assetRole: "product_voiceover_script",
        rawText,
        parsed,
        methodNodeId: methodNode.id,
        sourceAudioNodeId: audioNode?.id || "",
        sourceTextNodeId: sourceTextNode?.id || "",
      },
      x: 760,
      y: 1180,
    });
    const newEdges = [
      ...(audioNode ? [createEdge(audioNode.id, methodNode.id, "参考音频")] : []),
      ...(sourceTextNode ? [createEdge(sourceTextNode.id, methodNode.id, "参考口播")] : []),
      createEdge(methodNode.id, voiceoverNode.id, "鏀瑰啓鍟嗗搧鍙ｆ挱"),
      ...(executorNodeId ? [createEdge(executorNodeId, methodNode.id, "鑺傜偣鎵ц杈撳嚭"), createEdge(executorNodeId, voiceoverNode.id, "鑺傜偣鎵ц杈撳嚭")] : []),
    ];

    const next = await updateBoardWorkflow(id, {
      status: "analyzed",
      nodes: [...latestWorkflow.nodes, methodNode, voiceoverNode],
      edges: [...latestWorkflow.edges, ...newEdges],
    }, latestWorkflow.revision ?? 0);
    const finalWorkflow = executorNodeId
      ? await finishNodeExecution(id, executorNodeId, inputNodeIds, [methodNode.id, voiceoverNode.id], "商品口播已生成") || next
      : next;
    clearBoardTaskCancellation(id, clientTaskId);

    return NextResponse.json({ workflow: finalWorkflow, parsed });
  } catch (error) {
    console.error("board voiceover failed:", error);
    if (workflowId && executorNodeId) {
      await failNodeExecution(workflowId, executorNodeId, inputNodeIds, error instanceof Error ? error.message : "鍟嗗搧鍙ｆ挱鐢熸垚澶辫触").catch(() => null);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "鍟嗗搧鍙ｆ挱鐢熸垚澶辫触" },
      { status: 500 }
    );
  }
}
