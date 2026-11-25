import "server-only";

type AttemptWindow = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, AttemptWindow>();

function cleanup(now: number) {
  for (const [key, value] of attempts) {
    if (value.resetAt <= now) attempts.delete(key);
  }
}

export function loginAttemptKey(ip: string, username: string) {
  return `${ip || "unknown"}:${username.trim().toLowerCase()}`;
}

export function canAttemptLogin(key: string) {
  const now = Date.now();
  cleanup(now);
  const value = attempts.get(key);
  if (!value || value.resetAt <= now) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: value.count < MAX_ATTEMPTS,
    retryAfterSeconds: Math.max(1, Math.ceil((value.resetAt - now) / 1000)),
  };
}

export function recordFailedLogin(key: string) {
  const now = Date.now();
  const existing = attempts.get(key);
  if (!existing || existing.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  attempts.set(key, { ...existing, count: existing.count + 1 });
}

export function clearFailedLogins(key: string) {
  attempts.delete(key);
}
