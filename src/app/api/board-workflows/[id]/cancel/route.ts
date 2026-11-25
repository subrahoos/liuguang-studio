import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { cancelNodeExecution, updateNodeExecution } from "@/lib/board-workflows";
import { markBoardTaskCancelled } from "@/lib/board-task-cancellations";
import {
  cleanupCloudinaryVideoReferences,
  unverifiedCloudinaryVideoReferenceCleanup,
} from "@/lib/cloudinary-video-reference-hosting";
import { resolveVideoChannel, resolveVideoReferenceHosting } from "@/lib/server-model-settings";
import { cancelRjmusGrokVideo } from "@/lib/rjmus-grok-video";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const nodeId = String(body.nodeId || "");
    const clientTaskId = String(body.clientTaskId || "");
    if (!nodeId && !clientTaskId) return NextResponse.json({ error: "缺少要取消的任务" }, { status: 400 });

    const videoJob = access.workflow.nodes.find((node) => node.id === nodeId)?.execution?.videoJob;
    markBoardTaskCancelled(id, clientTaskId);
    let workflow = nodeId ? await cancelNodeExecution(id, nodeId) : null;
    if (nodeId && videoJob?.taskId) {
      workflow = await updateNodeExecution(id, nodeId, {
        status: "cancelled",
        summary: "用户取消，远端任务不再写回画板",
        error: "",
        videoJob: {
          ...videoJob,
          status: "cancelled",
          lastPolledAt: new Date().toISOString(),
        },
      }, "pending") || workflow;
      const channel = await resolveVideoChannel(req, undefined, videoJob.channelId, "full_video");
      if (channel?.id === videoJob.channelId && channel.model === videoJob.model) {
        // Cancellation is best effort: the user-visible board cancellation must
        // not be blocked if the upstream has already finished or expired.
        await cancelRjmusGrokVideo({
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
          model: channel.model,
          videoProtocol: channel.videoProtocol,
          submitPath: channel.submitPath,
          statusPath: channel.statusPath,
          contentPath: channel.contentPath,
          durationOptions: channel.durationOptions,
          maxReferenceImages: channel.maxReferenceImages,
          maxReferenceVideos: channel.maxReferenceVideos,
          maxReferenceAudios: channel.maxReferenceAudios,
          taskId: videoJob.taskId,
        }).catch(() => undefined);
      }
      if (videoJob.referenceTransport === "lingganya_file_id") {
        const expiresAt = videoJob.referenceExpiresAt && Number.isFinite(Date.parse(videoJob.referenceExpiresAt))
          ? new Date(videoJob.referenceExpiresAt).toLocaleString("zh-CN", { hour12: false })
          : "上传成功后24小时";
        const temporarySummary = videoJob.referenceUploadCount
          ? `灵感鸭临时参考共 ${videoJob.referenceUploadCount} 个，将于 ${expiresAt} 自动失效。`
          : "灵感鸭临时参考将在上传成功后24小时自动失效。";
        workflow = await updateNodeExecution(id, nodeId, {
          status: "cancelled",
          summary: `用户取消，远端任务不再写回画板。${temporarySummary}`,
          error: "",
          videoJob: {
            ...videoJob,
            status: "cancelled",
            lastPolledAt: new Date().toISOString(),
          },
        }, "pending") || workflow;
      } else if (videoJob.hostedReferences.length > 0) {
        const setting = await resolveVideoReferenceHosting(req).catch(() => null);
        const cleanup = setting
          ? await cleanupCloudinaryVideoReferences(setting, videoJob.hostedReferences).catch((error) =>
            unverifiedCloudinaryVideoReferenceCleanup(
              videoJob.hostedReferences,
              error instanceof Error ? error.message : String(error),
            ))
          : unverifiedCloudinaryVideoReferenceCleanup(
            videoJob.hostedReferences,
            "未能读取 Cloudinary 配置，未能核实临时参考文件是否已清理。",
          );
        const cleanupSummary = cleanup.status === "confirmed"
          ? `Cloudinary 临时参考已确认不存在：删除 ${cleanup.deleted} 个，原本不存在 ${cleanup.alreadyAbsent} 个。`
          : cleanup.status === "partial_failure"
            ? `Cloudinary 临时参考清理未完成：删除 ${cleanup.deleted} 个，已不存在 ${cleanup.alreadyAbsent} 个，失败 ${cleanup.failed} 个。`
            : "Cloudinary 临时参考未能核实是否已清理。";
        workflow = await updateNodeExecution(id, nodeId, {
          status: "cancelled",
          summary: `用户取消，远端任务不再写回画板。${cleanupSummary}`,
          error: "",
          referenceCleanup: cleanup,
          videoJob: {
            ...videoJob,
            status: "cancelled",
            lastPolledAt: new Date().toISOString(),
            referenceCleanup: cleanup,
          },
        }, "pending") || workflow;
      }
    }
    return NextResponse.json({ workflow, cancelled: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取消任务失败" },
      { status: 500 }
    );
  }
}
