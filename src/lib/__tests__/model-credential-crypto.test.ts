import { afterEach, describe, expect, it } from "vitest";
import {
  decryptModelCredential,
  encryptModelCredential,
  hasCredentialEncryptionKey,
} from "@/lib/model-credential-crypto";

const originalKey = process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  }
});

describe("model credential encryption", () => {
  it("encrypts credentials with authenticated encryption", () => {
    process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    const encrypted = encryptModelCredential("example-user-key");

    expect(encrypted).not.toContain("example-user-key");
    expect(decryptModelCredential(encrypted)).toBe("example-user-key");
    expect(() => decryptModelCredential(`${encrypted}x`)).toThrow();
  });

  it("rejects a missing or invalid master key", () => {
    delete process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY;
    expect(hasCredentialEncryptionKey()).toBe(false);
    expect(() => encryptModelCredential("example-user-key")).toThrow("MODEL_CREDENTIAL_ENCRYPTION_KEY_MISSING");

    process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY = "not-a-32-byte-key";
    expect(hasCredentialEncryptionKey()).toBe(false);
  });
});
