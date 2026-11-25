import { NextRequest, NextResponse } from "next/server";
import {
  addGeneratedIdentityReference,
  deleteIdentityPack,
  deleteIdentityReference,
  generatedImageDir,
  getIdentityLibrary,
  getIdentityPendingResults,
  getIdentityPack,
  migrateIdentityImageFileNames,
  renameIdentityPack,
  setIdentityReferenceStatus,
} from "@/lib/identity-pack";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const packId = req.nextUrl.searchParams.get("packId");
    await migrateIdentityImageFileNames(user.id, user.username);
    const library = await getIdentityLibrary(user.id);
    const pack = await getIdentityPack(user.id, packId);
    const pendingResults = await getIdentityPendingResults(user.id, pack?.id || packId);
    return NextResponse.json({
      ...library,
      pack,
      references: pack?.references ?? [],
      packName: pack?.packName ?? "人物包",
      description: pack?.description ?? "请先创建人物包并上传主模特身份来源图。",
      identityLock: pack?.identityLock ?? "",
      identityPerformanceBaseline: pack?.identityPerformanceBaseline ?? "",
      pendingResults,
      // The folder belongs to the authenticated account. It is needed for copying
      // paths from either localhost or a trusted LAN address of the same 3100 host.
      localImageFolder: generatedImageDir(user.id),
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取人物包失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const packId = String(body.packId || "");
    const url = String(body.url || "");
    if (!packId || !url) {
      return NextResponse.json({ error: "请指定人物包和生成图片。" }, { status: 400 });
    }

    const { pack, reference } = await addGeneratedIdentityReference({
      ownerId: user.id,
      packId,
      reference: {
        id: String(body.id || `generated-${Date.now()}`),
        title: String(body.title || "补充人物参考图"),
        role: String(body.role || "由图像模型生成，等待人工验收后才能用于项目。"),
        url,
        requiredFor: Array.isArray(body.requiredFor) ? body.requiredFor.map(String) : ["人工选择后调用"],
        sourceKind: String(body.sourceKind || "custom"),
        group: body.group === "camera" || body.group === "expression" || body.group === "base" ? body.group : "base",
        aspectRatio: body.aspectRatio === "9:16" ? "9:16" : "3:4",
        status: "draft",
      },
    });

    return NextResponse.json({ pack, reference }, { status: 201 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "保存人物包补图失败" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const packId = String(body.packId || "");
    const action = String(body.action || "");

    if (action === "rename-pack") {
      const result = await renameIdentityPack(user.id, packId, String(body.packName || ""));
      return NextResponse.json(result);
    }

    if (action === "delete-pack") {
      const result = await deleteIdentityPack(user.id, packId, body.confirmed === true);
      return NextResponse.json(result);
    }

    if (action === "delete-reference") {
      const result = await deleteIdentityReference(
        user.id,
        packId,
        String(body.referenceId || ""),
        body.confirmed === true
      );
      return NextResponse.json(result);
    }

    if (action === "set-reference-status") {
      const status = String(body.status || "");
      if (status !== "draft" && status !== "approved" && status !== "archived") {
        return NextResponse.json({ error: "无效的人物参考图状态。" }, { status: 400 });
      }
      const result = await setIdentityReferenceStatus({
        ownerId: user.id,
        packId,
        referenceId: String(body.referenceId || ""),
        status,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "不支持的人物包操作。" }, { status: 400 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "更新人物包失败" },
      { status: 500 }
    );
  }
}
