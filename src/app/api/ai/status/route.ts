import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { getAuthenticatedRequestUser } from "@/lib/server/resource-access";
import { resolveVideoChannel } from "@/lib/server-model-settings";
import { ownsModelApiTask } from "@/lib/model-api-audit";

// 查询 AI 任务状态，适用于已经提交过的生图/生视频任务。
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedRequestUser(req);
  if (!user) {
    return NextResponse.json({ error: "未登录。" }, { status: 401 });
  }
  const body = await req.json();
  const {
    provider: providerName,
    taskId,
  } = body;

  if (typeof providerName !== "string" || typeof taskId !== "string" || !taskId || taskId.length > 180) {
    return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
  }

  const channelId = typeof body.videoChannelId === "string" ? body.videoChannelId.trim() : "";
  if (!channelId) {
    return NextResponse.json({ error: "查询视频任务必须明确指定 videoChannelId，不能回退到默认通道。" }, { status: 409 });
  }
  if (!await ownsModelApiTask(user.id, channelId, providerName, taskId)) {
    return NextResponse.json({ error: "任务不存在或无权访问" }, { status: 404 });
  }
  const resolvedChannel = await resolveVideoChannel(req, undefined, channelId);
  if (resolvedChannel?.id !== channelId) {
    return NextResponse.json({ error: "原视频任务使用的通道已不可用" }, { status: 409 });
  }
  if (!resolvedChannel?.apiKey || !resolvedChannel.baseUrl) {
    return NextResponse.json({ error: "当前账户没有可用的视频模型配置。" }, { status: 400 });
  }

  try {
    const provider = createProvider({
      name: providerName,
      apiKey: resolvedChannel.apiKey,
      baseUrl: resolvedChannel.baseUrl,
      extra: {
        videoApiKey: resolvedChannel.apiKey,
        videoBaseUrl: resolvedChannel.baseUrl,
        videoStatusPath: resolvedChannel.statusPath,
        videoContentPath: resolvedChannel.contentPath,
      },
    });
    const status = await provider.getTaskStatus(taskId);
    return NextResponse.json(status);
  } catch (error) {
    console.error("查询任务状态失败", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 }
    );
  }
}
