import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from "crypto";

const HASH_ITERATIONS = 210_000;
const HASH_KEY_LENGTH = 32;
const HASH_DIGEST = "sha256";

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_DIGEST).toString("hex");
  return `pbkdf2$${HASH_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [method, iterations, salt, hash] = stored.split("$");
  if (method !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = pbkdf2Sync(password, salt, Number(iterations), expected.length, HASH_DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashInviteCode(code: string) {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
