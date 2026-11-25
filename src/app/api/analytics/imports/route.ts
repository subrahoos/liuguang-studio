import { after, NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, isAdmin, requireUser } from "@/lib/auth";
import { createAnalyticsImportPreview, processAnalyticsImport, resolveAnalyticsOwnerIds } from "@/lib/analytics/service";

export const runtime = "nodejs";

const MAX_WORKBOOK_BYTES = 80 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择利润表文件" }, { status: 400 });
    if (!/\.xlsx?$/i.test(file.name)) return NextResponse.json({ error: "仅支持 XLSX 或 XLS 利润表" }, { status: 400 });
    if (file.size <= 0 || file.size > MAX_WORKBOOK_BYTES) return NextResponse.json({ error: "利润表大小必须在 80MB 以内" }, { status: 400 });

    const requestedOwnerId = String(form.get("ownerId") || "").trim();
    let ownerId = user.id;
    if (requestedOwnerId && requestedOwnerId !== user.id) {
      if (!isAdmin(user)) return NextResponse.json({ error: "无权替其他用户导入利润表" }, { status: 403 });
      if (requestedOwnerId === "all") return NextResponse.json({ error: "请先选择一个具体用户再导入" }, { status: 400 });
      ownerId = (await resolveAnalyticsOwnerIds(user, requestedOwnerId))[0];
    }

    const result = await createAnalyticsImportPreview({ ownerId, actorId: user.id, fileName: file.name, buffer: Buffer.from(await file.arrayBuffer()), snapshotDate: String(form.get("snapshotDate") || "") });
    after(async () => {
      await processAnalyticsImport(result.importId).catch(() => undefined);
    });
    return NextResponse.json({
      import: { id: result.importId, status: "queued", stage: "等待后台解析", progress: 0 },
      message: "文件已进入后台预检，完成后需要确认才会成为正式经营数据。",
    }, { status: 202 });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "利润表导入失败" }, { status: 422 });
  }
}
