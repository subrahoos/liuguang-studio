import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authUsers, userFeatureEntries } from "@/lib/db/schema";
import {
  isWorkspaceModuleId,
  resolveWorkspaceFeatureEntries,
  type WorkspaceFeatureEntries,
  type WorkspaceFeatureEntryState,
  type WorkspaceModuleId,
} from "@/lib/workspace-navigation";

type FeatureEntryUser = {
  id: string;
  role: "admin" | "user";
};

export type UserFeatureEntry = {
  featureKey: WorkspaceModuleId;
  entryState: WorkspaceFeatureEntryState;
  updatedAt: Date | null;
};

async function assertNormalUser(userId: string) {
  const db = getDb();
  const [user] = await db
    .select({ role: authUsers.role, disabled: authUsers.disabled })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);

  if (!user || user.disabled || user.role !== "user") throw new Error("FEATURE_ENTRY_USER_NOT_FOUND");
}

export async function featureEntriesForUser(user: FeatureEntryUser): Promise<WorkspaceFeatureEntries> {
  if (user.role === "admin") return resolveWorkspaceFeatureEntries();

  const db = getDb();
  const rows = await db
    .select({ featureKey: userFeatureEntries.featureKey, entryState: userFeatureEntries.entryState })
    .from(userFeatureEntries)
    .where(eq(userFeatureEntries.userId, user.id));

  const overrides: Partial<Record<WorkspaceModuleId, WorkspaceFeatureEntryState>> = {};
  for (const row of rows) {
    if (!isWorkspaceModuleId(row.featureKey)) continue;
    if (row.entryState === "open" || row.entryState === "waiting") {
      overrides[row.featureKey] = row.entryState;
    }
  }
  return resolveWorkspaceFeatureEntries(overrides);
}

export async function listUserFeatureEntries(userId: string): Promise<UserFeatureEntry[]> {
  await assertNormalUser(userId);
  const db = getDb();
  const rows = await db
    .select({
      featureKey: userFeatureEntries.featureKey,
      entryState: userFeatureEntries.entryState,
      updatedAt: userFeatureEntries.updatedAt,
    })
    .from(userFeatureEntries)
    .where(eq(userFeatureEntries.userId, userId));
  const saved = new Map(rows.map((row) => [row.featureKey, row]));
  const states = resolveWorkspaceFeatureEntries(Object.fromEntries(
    rows
      .filter((row) => isWorkspaceModuleId(row.featureKey) && (row.entryState === "open" || row.entryState === "waiting"))
      .map((row) => [row.featureKey, row.entryState]),
  ) as Partial<Record<WorkspaceModuleId, WorkspaceFeatureEntryState>>);

  return Object.entries(states).map(([featureKey, entryState]) => ({
    featureKey: featureKey as WorkspaceModuleId,
    entryState,
    updatedAt: saved.get(featureKey)?.updatedAt ?? null,
  }));
}

export async function setUserFeatureEntry(
  userId: string,
  featureKey: WorkspaceModuleId,
  entryState: WorkspaceFeatureEntryState,
) {
  await assertNormalUser(userId);
  const db = getDb();
  await db
    .insert(userFeatureEntries)
    .values({ userId, featureKey, entryState, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userFeatureEntries.userId, userFeatureEntries.featureKey],
      set: { entryState, updatedAt: new Date() },
    });

  return listUserFeatureEntries(userId);
}
