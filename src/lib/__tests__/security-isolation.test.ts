import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { getDb, sqlite } from "@/lib/db";
import { authInvites, authUsers, modelChannels, projects } from "@/lib/db/schema";
import { hashInviteCode, hashToken } from "@/lib/auth-crypto";
import { AUTH_COOKIE_NAME, ADMIN_USER_ID } from "@/lib/auth-constants";
import { registerInvitedUser, getSessionUser } from "@/lib/auth";
import { consumeAuthAttempt } from "@/lib/server/login-rate-limit";
import { trustedClientIp } from "@/lib/request-security";
import { authorizeLocalVideoPath } from "@/lib/server/local-file-access";
import { storagePaths } from "@/lib/storage-root";
import { resolveOwnedStoredProjectFile, projectArchivePaths } from "@/lib/project-local-archive";
import { createBoardWorkflow, createNode, mergeBoardNodesFromClientPatch } from "@/lib/board-workflows";
import { recordModelApiCall, ownsModelApiTask } from "@/lib/model-api-audit";
import { GET as background } from "@/app/api/home-backgrounds/[...path]/route";
import { GET as boardFile } from "@/app/api/board-workflows/[id]/file/[fileName]/route";
import { GET as projectFile } from "@/app/api/files/[...path]/route";
import { POST as status } from "@/app/api/ai/status/route";
import { POST as login } from "@/app/api/auth/login/route";
import { PATCH as disable } from "@/app/api/admin/users/[id]/route";
import { POST as upload } from "@/app/api/quick-cut/tasks/[id]/assets/route";
import { requireHostDesktopAdmin } from "@/lib/server/host-desktop-access";
import { prepareImageEditReferenceUrl } from "@/lib/image-edit-reference";

// Boundary rejection must happen before importing models or writing any upload.
vi.mock("@/lib/quick-cut", () => ({
  clearQuickCutOptionalAssets: vi.fn(), storeQuickCutAssetStream: vi.fn(), toPublicQuickCutTask: vi.fn(),
}));

function session(id: string) {
  const token = crypto.randomUUID();
  sqlite.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)")
    .run(crypto.randomUUID(), id, hashToken(token), Math.floor(Date.now() / 1000) + 3600);
  return `${AUTH_COOKIE_NAME}=${token}`;
}
function request(path: string, cookie?: string, body?: unknown) {
  return new NextRequest(`http://localhost:3100${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function user() {
  const id = crypto.randomUUID();
  await getDb().insert(authUsers).values({ id, accountId: id, username: id, passwordHash: "test", role: "user" });
  return { id, cookie: session(id) };
}

describe("security boundaries against two real users", () => {
  beforeEach(() => sqlite.exec("DELETE FROM auth_rate_limits"));
  afterEach(() => vi.unstubAllEnvs());

  it("blocks foreign project and board files while serving their owners", async () => {
    const a = await user(); const b = await user();
    const workflow = await createBoardWorkflow({ name: "security-test", ownerId: a.id });
    await writeFile(join(workflow.localDir, "private.png"), "A-private");
    const params = { params: Promise.resolve({ id: workflow.id, fileName: "private.png" }) };
    expect((await boardFile(request("/api/board-workflows/file", b.cookie), params)).status).toBe(404);
    expect(await (await boardFile(request("/api/board-workflows/file", a.cookie), params)).text()).toBe("A-private");
    const id = crypto.randomUUID();
    await getDb().insert(projects).values({ id, ownerId: a.id, name: "private-project" });
    const fileParams = { params: Promise.resolve({ path: [id, "private.png"] }) };
    expect((await projectFile(request("/api/files/test", b.cookie), fileParams)).status).toBe(404);
  });

  it("never resolves another account's name-only legacy archive", async () => {
    const a = await user();
    const name = `shared-name-${crypto.randomUUID()}`;
    const legacyRoot = storagePaths.projects(name);
    await mkdir(legacyRoot, { recursive: true });
    const legacyFile = join(legacyRoot, "private.png"); await writeFile(legacyFile, "admin-private");
    const id = crypto.randomUUID();
    await getDb().insert(projects).values({ id, ownerId: a.id, name, productName: name });
    const found = await resolveOwnedStoredProjectFile(a.id, id, "assets", "private.png");
    expect(found).not.toBe(legacyFile);
    expect(found).toContain(projectArchivePaths({ id, ownerId: a.id, name }).root);
    expect(await resolveOwnedStoredProjectFile("other-user", id, "assets", "private.png")).toBeNull();
  });

  it("keeps all uploaded backgrounds private including administrator uploads", async () => {
    const a = await user(); const b = await user();
    for (const owner of [a.id, ADMIN_USER_ID]) {
      await mkdir(storagePaths.backgrounds(owner), { recursive: true });
      await writeFile(storagePaths.backgrounds(owner, "private.png"), "private");
      const params = { params: Promise.resolve({ path: [owner, "private.png"] }) };
      expect((await background(request("/api/home-backgrounds/test"), params)).status).toBe(404);
      expect((await background(request("/api/home-backgrounds/test", b.cookie), params)).status).toBe(404);
      const response = await background(request("/api/home-backgrounds/test", owner === a.id ? a.cookie : session(ADMIN_USER_ID)), params);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("does not trust forged forwarding headers for brute force throttling", async () => {
    const name = `unknown-${crypto.randomUUID()}`;
    for (let i = 0; i < 9; i++) {
      const req = request("/api/auth/login", undefined, { username: name, password: "incorrect" });
      req.headers.set("x-forwarded-for", `198.51.100.${i}`); req.headers.set("x-real-ip", `198.51.100.${i}`);
      expect(trustedClientIp(req)).toBe("local");
      expect((await login(req)).status).toBe(i < 8 ? 401 : 429);
    }
    expect(consumeAuthAttempt("login", "other-ip", name).allowed).toBe(false);
    expect(sqlite.prepare("SELECT count(*) AS n FROM auth_rate_limits").get()).toMatchObject({ n: 3 });
    expect((await login(request("/api/auth/login", undefined, { username: "admin", password: "x".repeat(257) }))).status).toBe(400);
  });

  it("consumes a one-use invitation atomically under concurrent registration", async () => {
    const code = crypto.randomUUID();
    await getDb().insert(authInvites).values({ id: crypto.randomUUID(), codeHash: hashInviteCode(code), expiresAt: new Date(Date.now() + 60000) });
    const results = await Promise.allSettled([1, 2, 3].map((i) => registerInvitedUser({ username: `secure_${crypto.randomUUID().slice(0, 8)}_${i}`, password: "long-test-password", inviteCode: code })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });

  it("revokes sessions on disable so re-enabling cannot revive old cookies", async () => {
    const a = await user();
    const admin = session(ADMIN_USER_ID);
    const params = { params: Promise.resolve({ id: a.id }) };
    expect((await disable(request("/api/admin/users/test", admin, { disabled: true }), params)).status).toBe(200);
    await disable(request("/api/admin/users/test", admin, { disabled: false }), params);
    expect(await getSessionUser(request("/api/auth/me", a.cookie))).toBeNull();
  });

  it("requires task owner, channel and provider before polling any upstream", async () => {
    const a = await user(); const b = await user(); const taskId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    await getDb().insert(modelChannels).values({ id: channelId, name: "security-test", kind: "video", providerKey: "fal-ai" });
    await recordModelApiCall({ userId: a.id, callType: "video", channelId, providerKey: "fal-ai", source: "test", status: "success", remoteTaskId: taskId, durationMs: 1 });
    expect(await ownsModelApiTask(a.id, channelId, "fal-ai", taskId)).toBe(true);
    expect(await ownsModelApiTask(b.id, channelId, "fal-ai", taskId)).toBe(false);
    expect(await ownsModelApiTask(a.id, "video-b", "fal-ai", taskId)).toBe(false);
    expect((await status(request("/api/ai/status", b.cookie, { provider: "fal-ai", taskId, videoChannelId: channelId }))).status).toBe(404);
  });

  it("rejects CSRF on the large upload route that bypasses Proxy buffering", async () => {
    const req = request("/api/quick-cut/tasks/test/assets", undefined, {});
    req.headers.set("origin", "https://attacker.example");
    expect((await upload(req, { params: Promise.resolve({ id: "test" }) })).status).toBe(403);
  });

  it("prevents ordinary accounts from driving the server desktop", async () => {
    const a = await user();
    await expect(requireHostDesktopAdmin(request("/api/quick-cut", a.cookie))).rejects.toThrow("HOST_DESKTOP_REQUIRED");
    await expect(requireHostDesktopAdmin(request("/api/quick-cut", session(ADMIN_USER_ID)))).resolves.toMatchObject({ role: "admin" });
  });

  it("does not let a generation helper bypass legacy identity HTTP authorization", async () => {
    await expect(prepareImageEditReferenceUrl("/api/model-identity/main-model-v2.png", { ownerId: "other-user" }))
      .rejects.toThrow("无权");
  });

  it("rejects arbitrary local paths, sibling prefixes and junction escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "luma-security-"));
    const own = join(root, "a"); const other = join(root, "ab");
    await mkdir(own); await mkdir(other);
    await writeFile(join(own, "a.mp4"), "own"); await writeFile(join(other, "b.mp4"), "other");
    expect(await authorizeLocalVideoPath(join(own, "a.mp4"), { role: "user" }, own)).toBe(await realpath(join(own, "a.mp4")));
    await expect(authorizeLocalVideoPath(join(other, "b.mp4"), { role: "user" }, own)).rejects.toThrow("无权");
    await symlink(other, join(own, "escape"), "junction");
    await expect(authorizeLocalVideoPath(join(own, "escape", "b.mp4"), { role: "user" }, own)).rejects.toThrow("无权");
    await expect(authorizeLocalVideoPath("\\\\server\\share\\x.mp4", { role: "admin" }, own)).rejects.toThrow("网络");
  });

  it("cannot inject remote task handles through visual board PATCH", () => {
    const original = createNode({ kind: "control", title: "video", x: 0, y: 0 });
    const forged = { ...original, execution: { status: "running" as const, videoJob: { taskId: "foreign-task" } } };
    const result = mergeBoardNodesFromClientPatch([original], [forged as typeof original], new Set());
    expect(result?.[0].execution).toBeUndefined();
    expect(mergeBoardNodesFromClientPatch([], [forged as typeof original], new Set())?.[0].execution).toBeUndefined();
    const imported = { ...original, filePath: "D:\\private-identity-pack\\owner-image.png" };
    expect(mergeBoardNodesFromClientPatch([imported], [imported], new Set(), "D:\\board")?.[0].filePath).toBe(imported.filePath);
  });
});
