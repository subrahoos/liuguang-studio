import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { copyProjectVersionFolder, deleteProjectVersionFolder } from "@/lib/project-local-archive";
import {
  createProjectVersion,
  deleteProjectVersionRecords,
  listProjectVersions,
  renameProjectVersion,
  setDefaultProjectVersion,
  type CreateProjectVersionMode,
} from "@/lib/project-versions";
import type { ProjectVersionType } from "@/lib/db/schema";

function versionType(value: unknown): ProjectVersionType | undefined {
  return value === "normal" || value === "clone" ? value : undefined;
}

function createMode(value: unknown): CreateProjectVersionMode {
  if (value === "copy_script" || value === "copy_full") return "copy_full";
  return "blank";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  try {
    const versions = await listProjectVersions(id);
    return NextResponse.json({ versions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取版本失败" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const mode = createMode(body.mode);

  try {
    const version = await createProjectVersion(id, {
      versionType: versionType(body.versionType),
      mode,
      sourceVersionId: typeof body.sourceVersionId === "string" ? body.sourceVersionId : null,
      name: typeof body.name === "string" ? body.name : null,
    });
    if (mode === "copy_full" && typeof body.sourceVersionId === "string") {
      await copyProjectVersionFolder(id, body.sourceVersionId, version.id);
    }
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建版本失败" },
      { status: 400 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!versionId) return NextResponse.json({ error: "缺少 versionId" }, { status: 400 });

  try {
    const version = body.action === "set_default"
      ? await setDefaultProjectVersion(id, versionId)
      : await renameProjectVersion(id, versionId, String(body.name || ""));
    if (!version) return NextResponse.json({ error: "版本不存在" }, { status: 404 });
    return NextResponse.json({ version });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "版本更新失败" },
      { status: 400 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!versionId) return NextResponse.json({ error: "缺少 versionId" }, { status: 400 });

  try {
    const deleted = await deleteProjectVersionRecords(id, versionId);
    await deleteProjectVersionFolder(id, versionId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "版本删除失败" },
      { status: 400 }
    );
  }
}
