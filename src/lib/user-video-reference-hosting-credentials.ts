import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authUsers, userVideoReferenceHostingCredentials } from "@/lib/db/schema";
import { decryptModelCredential, encryptModelCredential } from "@/lib/model-credential-crypto";

export type HostingCredentialField = "apiKey" | "apiSecret";

export type UserVideoReferenceHostingCredentialState = {
  configured: boolean;
  updatedAt: Date | null;
};

async function assertManagedUser(userId: string) {
  const db = getDb();
  const [user] = await db
    .select({ id: authUsers.id, role: authUsers.role, disabled: authUsers.disabled })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  if (!user || user.role !== "user" || user.disabled) {
    throw new Error("HOSTING_CREDENTIAL_USER_NOT_FOUND");
  }
}

export async function getUserVideoReferenceHostingCredentialState(
  userId: string,
): Promise<UserVideoReferenceHostingCredentialState> {
  await assertManagedUser(userId);
  const db = getDb();
  const [credential] = await db
    .select({ updatedAt: userVideoReferenceHostingCredentials.updatedAt })
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, userId))
    .limit(1);
  return {
    configured: Boolean(credential),
    updatedAt: credential?.updatedAt ?? null,
  };
}

export async function revealUserVideoReferenceHostingCredential(
  userId: string,
  field: HostingCredentialField,
): Promise<string> {
  await assertManagedUser(userId);
  const db = getDb();
  const [credential] = await db
    .select()
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, userId))
    .limit(1);
  if (!credential) return "";
  return decryptModelCredential(field === "apiKey" ? credential.encryptedApiKey : credential.encryptedApiSecret);
}

export async function replaceUserVideoReferenceHostingCredentials(
  userId: string,
  input: Partial<Record<HostingCredentialField, string>>,
): Promise<UserVideoReferenceHostingCredentialState> {
  await assertManagedUser(userId);
  const apiKey = input.apiKey?.trim();
  const apiSecret = input.apiSecret?.trim();
  if (!apiKey && !apiSecret) throw new Error("HOSTING_CREDENTIAL_VALUE_REQUIRED");

  const db = getDb();
  const [existing] = await db
    .select()
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, userId))
    .limit(1);
  const encryptedApiKey = apiKey ? encryptModelCredential(apiKey) : existing?.encryptedApiKey;
  const encryptedApiSecret = apiSecret ? encryptModelCredential(apiSecret) : existing?.encryptedApiSecret;
  if (!encryptedApiKey || !encryptedApiSecret) {
    throw new Error("HOSTING_CREDENTIAL_PAIR_REQUIRED");
  }

  const now = new Date();
  await db
    .insert(userVideoReferenceHostingCredentials)
    .values({
      userId,
      encryptedApiKey,
      encryptedApiSecret,
      keyVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userVideoReferenceHostingCredentials.userId,
      set: {
        encryptedApiKey,
        encryptedApiSecret,
        keyVersion: 1,
        updatedAt: now,
      },
    });
  return { configured: true, updatedAt: now };
}

export async function clearUserVideoReferenceHostingCredentials(userId: string) {
  await assertManagedUser(userId);
  const db = getDb();
  await db
    .delete(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, userId));
}

export async function resolveUserVideoReferenceHostingCredentials(userId: string) {
  const db = getDb();
  const [credential] = await db
    .select()
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, userId))
    .limit(1);
  if (!credential) return null;
  return {
    apiKey: decryptModelCredential(credential.encryptedApiKey),
    apiSecret: decryptModelCredential(credential.encryptedApiSecret),
  };
}
