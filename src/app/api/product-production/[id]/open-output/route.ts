import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { productProductionOutputDirectory } from "@/lib/product-production";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });

  try {
    const directory = productProductionOutputDirectory(access.user.id, id);
    await mkdir(directory, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const explorer = spawn("explorer.exe", [directory], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      explorer.once("spawn", () => {
        explorer.unref();
        resolve();
      });
      explorer.once("error", () => reject(new Error("Windows 资源管理器启动失败。")));
    });
    return NextResponse.json({ opened: true, directory });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "打开输出目录失败。" }, { status: 500 });
  }
}
