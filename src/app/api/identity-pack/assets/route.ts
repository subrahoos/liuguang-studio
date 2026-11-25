import { NextRequest, NextResponse } from "next/server";
import { composeIdentityAuxiliaryAsset } from "@/lib/identity-auxiliary-assets";
import { deleteIdentityAuxiliaryAsset, type IdentityAuxiliaryAssetKind } from "@/lib/identity-pack";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

const validKinds = new Set<IdentityAuxiliaryAssetKind>([
  "expression_sheet",
  "base_multiview_sheet",
  "camera_pose_sheet",
  "custom_sheet",
]);

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const kind = String(body.kind || "") as IdentityAuxiliaryAssetKind;
    const referenceIds = Array.isArray(body.referenceIds) ? body.referenceIds.map(String) : [];
    if (!validKinds.has(kind)) return NextResponse.json({ error: "无效的辅助资产类型。" }, { status: 400 });
    const result = await composeIdentityAuxiliaryAsset({
      ownerId: user.id,
      ownerName: user.username,
      packId: String(body.packId || ""),
      kind,
      title: String(body.title || ""),
      referenceIds,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "本地合成辅助资产失败。" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const packId = req.nextUrl.searchParams.get("packId") || "";
    const assetId = req.nextUrl.searchParams.get("assetId") || "";
    const confirmed = req.nextUrl.searchParams.get("confirmed") === "true";
    const result = await deleteIdentityAuxiliaryAsset(user.id, packId, assetId, confirmed);
    return NextResponse.json(result);
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "删除辅助资产失败。" },
      { status: 500 }
    );
  }
}
