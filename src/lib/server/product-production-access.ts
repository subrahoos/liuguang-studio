import "server-only";

import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { featureEntriesForUser } from "@/lib/workspace-feature-entries";
import { getProductProductionTask } from "@/lib/product-production";

export async function getProductProductionRequestUser(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return null;
  const entries = await featureEntriesForUser(user);
  if (user.role !== "admin" && entries["product-production"] !== "open") return null;
  return user;
}

export async function getOwnedProductProductionAccess(req: NextRequest, taskId: string) {
  const user = await getProductProductionRequestUser(req);
  if (!user) return null;
  const task = await getProductProductionTask(taskId, user.id);
  return task ? { user, task } : null;
}
