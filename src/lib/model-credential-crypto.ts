import { readFileSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { storagePaths } from "@/lib/storage-root";

const CREDENTIAL_FORMAT_VERSION = "v1";

function fileMasterKey() {
  // The production service keeps the master key outside the repository. Keep
  // the file fallback server-side so a process started without an inherited
  // environment still uses the same key as the model pool.
  if (process.env.NODE_ENV === "test") return "";
  try {
    return readFileSync(storagePaths.system("model-credential-encryption.key"), "utf8").trim();
  } catch {
    return "";
  }
}

function encryptionKey(): Buffer {
  const configured = process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY?.trim() ?? "";
  const raw = configured || fileMasterKey();
  if (!raw) {
    throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY_MISSING");
  }

  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  }
  return key;
}

export function hasCredentialEncryptionKey() {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptModelCredential(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CREDENTIAL_FORMAT_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptModelCredential(value: string): string {
  const [version, ivPart, tagPart, ciphertextPart] = value.split(":");
  if (version !== CREDENTIAL_FORMAT_VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error("MODEL_CREDENTIAL_FORMAT_INVALID");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
