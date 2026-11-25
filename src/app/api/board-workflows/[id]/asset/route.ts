import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { extname } from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  boardFilePublicUrl,
  boardArtifactFileName,
  boardArtifactRelativePath,
  createEdge,
  createNode,
  deleteBoardFiles,
  finishNodeExecution,
  saveBoardUploadedFile,
  updateBoardWorkflow,
} from "@/lib/board-workflows";
import { currentProductGroup, setCurrentProductGroup } from "@/lib/board-input-assets";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);

function readPosition(form: FormData, fallbackX: number, fallbackY: number) {
  const x = Number(form.get("x") || fallbackX);
  const y = Number(form.get("y") || fallbackY);
  return {
    x: Number.isFinite(x) ? x : fallbackX,
    y: Number.isFinite(y) ? y : fallbackY,
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let createdFilePath = "";
  let graphSaved = false;
  try {
    const { id } = await params;
    workflowId = id;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const workflow = access.workflow;

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      return NextResponse.json({ error: "璇峰厛閫夋嫨瑕佷笂浼犵殑鏈湴鏂囦欢" }, { status: 400 });
    }

    const ext = extname(file.name).toLowerCase() || ".png";
    const isImage = ALLOWED_IMAGE_EXTENSIONS.has(ext);
    const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);
    if (!isImage && !isVideo) {
      return NextResponse.json({ error: "只支持 jpg、png、webp 图片或 mp4、webm、mov 视频。" }, { status: 400 });
    }

    const role = String(form.get("role") || (isVideo ? "local_video_asset" : "reference_image"));
    const title = String(form.get("title") || file.name || (isVideo ? "本地视频素材" : "本地图片素材"));
    const description = String(form.get("description") || "");
    const sourceNodeId = String(form.get("sourceNodeId") || "");
    const productGroupId = String(form.get("productGroupId") || "").trim();
    const productGroupOwnerNodeId = String(form.get("productGroupOwnerNodeId") || "").trim();
    const productGroupOwner = productGroupOwnerNodeId
      ? workflow.nodes.find((item) => item.id === productGroupOwnerNodeId && String(item.meta?.controlRole || "") === "input_assets")
      : undefined;
    if (role === "product_image" && (!productGroupId || !productGroupOwner)) {
      return NextResponse.json({ error: "商品图必须加入当前商品组后再上传。" }, { status: 400 });
    }
    const position = readPosition(form, 40, 760);
    const reusableFilePaths = workflow.nodes
      .map((node) => node.filePath)
      .filter((filePath): filePath is string => Boolean(filePath));
    const storedFile = await saveBoardUploadedFile({
      id,
      relativeFileName: boardArtifactRelativePath("assets", boardArtifactFileName(workflow, title || role, ext, { suffix: crypto.randomUUID().slice(0, 8) })),
      stream: file.stream(),
      reusableFilePaths,
    });
    if (!storedFile.reused) createdFilePath = storedFile.filePath;

    const existingEquivalentNode = workflow.nodes.find((item) => (
      item.filePath === storedFile.filePath
      && item.kind === (isVideo ? "video_clip" : "image_asset")
      && String(item.meta?.assetRole || "") === role
    ));
    if (existingEquivalentNode) {
      if (role !== "product_image" || !productGroupOwner) {
        return NextResponse.json({ workflow, node: existingEquivalentNode, reused: true });
      }
      const currentGroup = currentProductGroup(productGroupOwner, workflow.nodes);
      if (!currentGroup.nodeIds.includes(existingEquivalentNode.id) && currentGroup.nodeIds.length >= 4) {
        return NextResponse.json({ error: "当前商品组最多保留 4 张图片，请先移除一张。" }, { status: 400 });
      }
      const groupedNodes = setCurrentProductGroup(
        workflow.nodes,
        productGroupOwner.id,
        productGroupId,
        [...currentGroup.nodeIds, existingEquivalentNode.id],
      );
      const groupedWorkflow = await updateBoardWorkflow(id, { nodes: groupedNodes }, workflow.revision ?? 0);
      graphSaved = true;
      return NextResponse.json({ workflow: groupedWorkflow, node: existingEquivalentNode, reused: true });
    }

    if (role === "product_image" && productGroupOwner) {
      const currentGroup = currentProductGroup(productGroupOwner, workflow.nodes);
      if (currentGroup.nodeIds.length >= 4) {
        return NextResponse.json({ error: "当前商品组最多保留 4 张图片，请先移除一张。" }, { status: 400 });
      }
    }

    const node = createNode({
      kind: isVideo ? "video_clip" : "image_asset",
      title,
      description,
      filePath: storedFile.filePath,
      publicUrl: boardFilePublicUrl(id, storedFile.filePath),
      meta: {
        assetRole: role,
        mediaType: isVideo ? "video" : "image",
        originalName: file.name,
        source: "user-upload",
        sourceSha256: storedFile.sha256,
        sourceBytes: storedFile.bytes,
        storageReused: storedFile.reused,
        ...(role === "product_image" ? { productGroupId } : {}),
      },
      x: position.x,
      y: position.y,
    });

    const edges = sourceNodeId ? [createEdge(sourceNodeId, node.id, "上传素材")] : [];
    const baseNodes = [...workflow.nodes, node];
    const groupedNodes = role === "product_image" && productGroupOwner
      ? setCurrentProductGroup(
        baseNodes,
        productGroupOwner.id,
        productGroupId,
        [...currentProductGroup(productGroupOwner, workflow.nodes).nodeIds, node.id],
      )
      : baseNodes;
    const next = await updateBoardWorkflow(id, {
      nodes: groupedNodes,
      edges: [...workflow.edges, ...edges],
    }, workflow.revision ?? 0);
    graphSaved = true;
    const sourceNode = sourceNodeId ? workflow.nodes.find((item) => item.id === sourceNodeId) : null;
    const outputNodeIds = Array.from(new Set([...(sourceNode?.execution?.outputNodeIds || []), node.id]));
    const finalWorkflow = sourceNodeId
      ? await finishNodeExecution(id, sourceNodeId, sourceNode?.execution?.inputNodeIds || [], outputNodeIds, "素材节点已更新") || next
      : next;

    return NextResponse.json({ workflow: finalWorkflow, node });
  } catch (error) {
    if (workflowId && createdFilePath && !graphSaved) {
      await deleteBoardFiles(workflowId, [createdFilePath]).catch(() => undefined);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "涓婁紶鐢绘澘绱犳潗澶辫触" },
      { status: 500 }
    );
  }
}
