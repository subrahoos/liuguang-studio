import "server-only";
import { createHash } from "node:crypto";
import { sqlite } from "@/lib/db";

const WINDOW_MS = 15 * 60 * 1000;
sqlite.exec(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
)`);

function accountKey(scope: string, identity: string) {
  return `${scope}:account:${createHash("sha256").update(identity.trim().toLowerCase()).digest("hex")}`;
}

/** Reserve before password work; persistent counters survive a process restart. */
export function consumeAuthAttempt(scope: "login" | "register", ip: string, identity: string) {
  const now = Date.now();
  const limits: Array<[string, number]> = [
    [accountKey(scope, identity), 8],
    [`${scope}:source:${ip}`, scope === "login" ? 100 : 30],
    [`${scope}:global`, scope === "login" ? 400 : 100],
  ];
  return sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM auth_rate_limits WHERE reset_at <= ?").run(now);
    const get = sqlite.prepare("SELECT count, reset_at FROM auth_rate_limits WHERE key = ?");
    for (const [key, maximum] of limits) {
      const row = get.get(key) as { count: number; reset_at: number } | undefined;
      if (row && row.count >= maximum) return {
        allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.reset_at - now) / 1000)),
      };
    }
    const insert = sqlite.prepare(`INSERT INTO auth_rate_limits (key, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1`);
    for (const [key] of limits) insert.run(key, now + WINDOW_MS);
    return { allowed: true, retryAfterSeconds: 0 };
  }).immediate();
}

export function clearSuccessfulLogin(identity: string) {
  sqlite.prepare("DELETE FROM auth_rate_limits WHERE key = ?").run(accountKey("login", identity));
}
