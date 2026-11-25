import { basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import {
  boardArtifactFileName,
  boardArtifactRelativePath,
  boardFilePublicUrl,
  createEdge,
  createNode,
  updateBoardWorkflow,
} from "@/lib/board-workflows";
import { composeProductEvidenceBoard, prepareProductEvidencePanels } from "@/lib/product-evidence-board";
import { currentProductGroup } from "@/lib/board-input-assets";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const sourceNodeId = String(body.sourceNodeId || "").trim();
    const productGroupId = String(body.productGroupId || "").trim();
    const groupOwner = access.workflow.nodes.find((node) => (
      node.id === sourceNodeId && String(node.meta?.controlRole || "") === "input_assets"
    ));
    const savedGroup = currentProductGroup(groupOwner, access.workflow.nodes);
    if (!groupOwner || !productGroupId || savedGroup.groupId !== productGroupId) {
      return NextResponse.json({ error: "当前商品组不存在或已切换，请刷新后重试。" }, { status: 400 });
    }
    const rawProductIds: unknown[] = Array.isArray(body.productNodeIds) ? body.productNodeIds : [];
    const requestedIds = Array.from(new Set<string>(
      rawProductIds.filter((value): value is string => typeof value === "string"),
    )).slice(0, 4);
    if (requestedIds.length < 2) return NextResponse.json({ error: "至少选择两张商品结构图。" }, { status: 400 });
    if (requestedIds.length !== savedGroup.nodeIds.length
      || requestedIds.some((nodeId, index) => savedGroup.nodeIds[index] !== nodeId)) {
      return NextResponse.json({ error: "本次证据板图片与当前商品组不一致，请按页面展示的商品组重新生成。" }, { status: 400 });
    }

    const products = requestedIds
      .map((nodeId) => access.workflow.nodes.find((node) => node.id === nodeId))
      .filter((node) => Boolean(node && String(node.meta?.assetRole || "") === "product_image" && node.filePath));
    if (products.length !== requestedIds.length) {
      return NextResponse.json({ error: "商品多视图证据板只能使用当前画板中已保存的商品结构图。" }, { status: 400 });
    }

    const outputPath = join(
      access.workflow.localDir,
      boardArtifactRelativePath("assets", boardArtifactFileName(access.workflow, "商品多视图证据板", ".png")),
    );
    await mkdir(join(access.workflow.localDir, "assets"), { recursive: true });
    const panels = prepareProductEvidencePanels(products.map((product) => ({
      inputPath: product!.filePath as string,
      sourceNodeId: product!.id,
      title: product!.title,
      description: product!.description,
    })));
    const result = await composeProductEvidenceBoard({
      panels,
      outputPath,
    });
    const viewSummary = result.panels.map((panel, index) => `${String(index + 1).padStart(2, "0")} ${panel.label}`).join("、");
    const title = "商品多视图证据板";
    const node = createNode({
      kind: "image_asset",
      title,
      description: `商品故事板已在每个画格内标注视角：${viewSummary}。视频模型须以图内标签读取各视角；每格仅证明该视角的可见结构，禁止镜像、翻转或臆造未展示结构。`,
      filePath: outputPath,
      publicUrl: boardFilePublicUrl(id, outputPath),
      meta: {
        assetRole: "product_evidence_board",
        productGroupId,
        sourceProductNodeIds: result.panels.map((panel) => panel.sourceNodeId || "").filter(Boolean),
        sourceProductFileNames: result.panels.map((panel) => basename(panel.inputPath)),
        productEvidenceViews: result.panels.map((panel, index) => ({
          index: index + 1,
          sourceNodeId: panel.sourceNodeId,
          sourceFileName: basename(panel.inputPath),
          view: panel.view,
          label: panel.label,
        })),
      },
      x: Number(body.x || 780),
      y: Number(body.y || 120),
    });
    const workflow = await updateBoardWorkflow(id, {
      nodes: [...access.workflow.nodes, node],
      edges: [
        ...access.workflow.edges,
        ...requestedIds.map((productId) => createEdge(productId, node.id, "商品多视图合成")),
      ],
    }, access.workflow.revision ?? 0);
    return NextResponse.json({ workflow, node });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成商品多视图证据板失败" }, { status: 500 });
  }
}
