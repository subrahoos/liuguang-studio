export const WORKSPACE_SESSION_KEY = "luma-workspace-session";

type WorkspaceSession = {
  username: string;
  accountId?: string;
  role?: "admin" | "user";
  expiresAt: number;
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function saveSessionHint(session: WorkspaceSession) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(session));
}

export async function fetchWorkspaceSession() {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (!res.ok) {
    clearWorkspaceSession();
    return null;
  }
  const data = await res.json();
  const user = data.user as { username: string; accountId: string; role: "admin" | "user" };
  const session = {
    username: user.username,
    accountId: user.accountId,
    role: user.role,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  };
  saveSessionHint(session);
  return session;
}

export async function loginWorkspace(username: string, password: string) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "登录失败");
  await fetchWorkspaceSession();
  return data;
}

export async function registerWorkspace(input: { username: string; password: string; inviteCode: string }) {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "注册失败");
  await fetchWorkspaceSession();
  return data;
}

export function getWorkspaceSession(): WorkspaceSession | null {
  if (!canUseStorage()) return null;
  const saved = window.localStorage.getItem(WORKSPACE_SESSION_KEY);
  if (!saved) return null;

  try {
    const session = JSON.parse(saved) as WorkspaceSession;
    if (!session?.username || !session?.expiresAt || session.expiresAt <= Date.now()) {
      window.localStorage.removeItem(WORKSPACE_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    window.localStorage.removeItem(WORKSPACE_SESSION_KEY);
    return null;
  }
}

export function isWorkspaceAuthenticated() {
  return Boolean(getWorkspaceSession());
}

export async function logoutWorkspace() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
  clearWorkspaceSession();
}

export function clearWorkspaceSession() {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(WORKSPACE_SESSION_KEY);
}
