import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";

/** The server desktop is shared OS state, never a normal user's browser desktop. */
export async function requireHostDesktopAdmin(req: NextRequest) {
  const user = await requireUser(req);
  if (user.role !== "admin") throw new Error("HOST_DESKTOP_REQUIRED");
  return user;
}
