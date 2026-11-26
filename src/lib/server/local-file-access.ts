import "server-only";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AuthUser } from "@/lib/auth";

/** A browser path is not proof of filesystem access. Resolve links before checking ownership. */
export async function authorizeLocalVideoPath(value: string, user: Pick<AuthUser, "role">, ownedRoot: string) {
  const cleaned = value.trim().replace(/^"|"$/g, "");
  if (!isAbsolute(cleaned) || /^\\\\|^\/\//.test(cleaned) || cleaned.includes("\0")) {
    throw new Error("不允许网络、设备或相对路径，请上传视频文件。");
  }
  if (![".mp4", ".webm", ".mov", ".m4v"].includes(extname(cleaned).toLowerCase())) {
    throw new Error("只支持 mp4、webm、mov、m4v 视频。");
  }
  const inside = (target: string, root: string) => {
    const part = relative(root, target);
    return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  if (user.role !== "admin" && !inside(resolve(cleaned), resolve(ownedRoot))) {
    throw new Error("无权读取该本地路径，请通过上传选择自己的视频。");
  }
  const unreadable = () => { throw new Error("文件不存在或无权读取，请重新上传。"); };
  const target = await realpath(cleaned).catch(unreadable);
  if (user.role !== "admin" && !inside(target, await realpath(ownedRoot).catch(unreadable))) {
    throw new Error("无权读取该本地路径，请通过上传选择自己的视频。");
  }
  if (!(await stat(target).catch(unreadable)).isFile()) throw new Error("请选择视频文件。");
  return target;
}
