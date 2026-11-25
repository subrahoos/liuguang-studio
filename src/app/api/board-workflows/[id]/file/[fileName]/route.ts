import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { mimeFromFileName, readBoardFile } from "@/lib/board-workflows";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileName: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id, fileName } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const relativePath = decodeURIComponent(fileName);
    const bytes = await readBoardFile(id, relativePath);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": mimeFromFileName(relativePath),
        "Content-Length": String(bytes.byteLength),
        // Board files can be overwritten by a new evidence extraction while
        // retaining the same local filename. Never let a browser reuse an old
        // authenticated media response as if it were the latest evidence.
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取画板文件失败" },
      { status: 404 },
    );
  }
}
