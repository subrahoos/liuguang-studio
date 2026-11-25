import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import {
  createEdge,
  createNode,
  finishNodeExecution,
  updateBoardWorkflow,
} from "@/lib/board-workflows";
import { getIdentityPack } from "@/lib/identity-pack";
import { isIdentityPackFileUrl, resolveIdentityImageFile } from "@/lib/identity-pack";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

function absoluteUrl(req: NextRequest, url?: string) {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  if (url.startsWith("/")) return `${req.nextUrl.origin}${url}`;
  return url;
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const workflow = access.workflow;

    const body = await req.json();
    const referenceId = String(body.referenceId || "");
    const auxiliaryAssetId = String(body.auxiliaryAssetId || "");
    const packId = String(body.packId || "");
    const sourceNodeId = String(body.sourceNodeId || "");
    const x = Number(body.x || 40);
    const y = Number(body.y || 1060);
    const pack = await getIdentityPack(access.user.id, packId);
    const reference = pack?.references.find((item) => item.id === referenceId && item.status === "approved");
    const auxiliaryAsset = pack?.auxiliaryAssets.find((item) => item.id === auxiliaryAssetId);
    if (!pack || (referenceId && auxiliaryAssetId) || (!reference?.url && !auxiliaryAsset?.url)) {
      return NextResponse.json({ error: "请选择一张已通过验收的人物图，或一个人物辅助资产。" }, { status: 400 });
    }

    const imported = reference
      ? {
          id: reference.id,
          title: reference.title,
          role: reference.role,
          url: reference.url,
          kind: "reference" as const,
        }
      : {
          id: auxiliaryAsset!.id,
          title: auxiliaryAsset!.title,
          role: auxiliaryAsset!.role,
          url: auxiliaryAsset!.url,
          kind: "auxiliary" as const,
        };
    // 人物包文件必须保留相对 URL，才能走带账户归属校验的本地文件读取。
    // 若先转成绝对 URL，会退回到无登录态的 HTTP 请求并被文件接口拒绝。
    const sourceUrl = isIdentityPackFileUrl(imported.url)
      ? imported.url
      : absoluteUrl(req, imported.url) || imported.url;
    const filePath = isIdentityPackFileUrl(sourceUrl)
      ? resolveIdentityImageFile(access.user.id, sourceUrl) || undefined
      : undefined;
    if (isIdentityPackFileUrl(sourceUrl) && !filePath) {
      return NextResponse.json({ error: "人物包图片不存在或不属于当前账户。" }, { status: 404 });
    }
    const panelSummary = auxiliaryAsset?.panels
      .sort((a, b) => a.order - b.order)
      .map((panel) => panel.label)
      .join("；");
    const node = createNode({
      kind: "image_asset",
      title: reference ? `人物身份参考 · 人物包：${imported.title}` : `人物辅助参考 · 人物包：${imported.title}`,
      description: reference
        ? `${imported.role}。这是从当前账户人物包引用到画板的人物身份参考。`
        : `${imported.role}${panelSummary ? ` 面板顺序：${panelSummary}。` : ""} 这是从当前账户人物包手动导入到画板的可预览节点。`,
      filePath,
      publicUrl: sourceUrl,
      meta: {
        assetRole: reference ? "identity_image" : "identity_auxiliary_asset",
        mediaType: "image",
        source: "identity-pack",
        identityPackId: pack.id,
        identityLock: pack.identityLock,
        identityPerformanceBaseline: pack.identityPerformanceBaseline,
        ...(reference
          ? {
              identityReferenceId: reference.id,
              identityReferenceSourceKind: reference.sourceKind || "custom",
              identityReferenceGroup: reference.group,
              identityReferenceRole: reference.role,
              identityReferenceAspectRatio: reference.aspectRatio,
              requiredFor: reference.requiredFor,
            }
          : {
              identityAuxiliaryAssetId: auxiliaryAsset!.id,
              identityAuxiliaryKind: auxiliaryAsset!.kind,
              identityAuxiliaryLayout: auxiliaryAsset!.layout,
              identityAuxiliaryPanels: auxiliaryAsset!.panels,
            }),
      },
      x: Number.isFinite(x) ? x : 40,
      y: Number.isFinite(y) ? y : 1060,
    });

    const edges = sourceNodeId ? [createEdge(sourceNodeId, node.id, "身份包导入")] : [];
    const next = await updateBoardWorkflow(id, {
      nodes: [...workflow.nodes, node],
      edges: [...workflow.edges, ...edges],
    }, workflow.revision ?? 0);
    const sourceNode = sourceNodeId ? workflow.nodes.find((item) => item.id === sourceNodeId) : null;
    const outputNodeIds = Array.from(new Set([...(sourceNode?.execution?.outputNodeIds || []), node.id]));
    const finalWorkflow = sourceNodeId
      ? await finishNodeExecution(id, sourceNodeId, sourceNode?.execution?.inputNodeIds || [], outputNodeIds, "身份包导入完成") || next
      : next;

    return NextResponse.json({ workflow: finalWorkflow, node });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "身份包导入画板失败" },
      { status: 500 }
    );
  }
}
