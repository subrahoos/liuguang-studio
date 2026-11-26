import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

describe("protected API proxy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("keeps an unauthenticated API denial out of caches", async () => {
    const response = await proxy(new NextRequest("http://localhost/api/admin/model-api-calls"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });

  it("rejects cross-site writes and DNS rebinding without trusting forwarded headers", async () => {
    for (const origin of ["https://attacker.example", "null", "http://localhost:9999"]) {
      const response = await proxy(new NextRequest("http://localhost:3100/api/auth/login", {
        method: "POST", headers: { origin, "x-forwarded-host": "attacker.example" },
      }));
      expect(response.status).toBe(403);
    }
    expect((await proxy(new NextRequest("http://attacker.example:3100/api/auth/login", { method: "POST" }))).status).toBe(403);
  });

  it("allows local writes and explicitly configured HTTPS origins", async () => {
    expect((await proxy(new NextRequest("http://localhost:3100/api/auth/login", {
      method: "POST", headers: { origin: "http://localhost:3100" },
    }))).status).toBe(200);
    vi.stubEnv("LUMA_PUBLIC_ORIGINS", "https://studio.example.com");
    const response = await proxy(new NextRequest("http://localhost:3100/api/auth/login", {
      method: "POST", headers: { host: "studio.example.com", origin: "https://studio.example.com" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("x-middleware-request-x-forwarded-host")).toBe("studio.example.com");
  });

  it("protects image suffix API paths, private caches, and active uploaded content", async () => {
    const url = "http://localhost/api/home-backgrounds/luma-admin/photo.png";
    expect((await proxy(new NextRequest(url))).status).toBe(401);
    const response = await proxy(new NextRequest(url, { headers: { cookie: "luma_session=unverified" } }));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("blocks source, configuration, database and source map requests", async () => {
    for (const path of ["/.git/config", "/.env", "/.runtime/tools/python.exe", "/src/proxy.ts", "/deployment/release.json", "/_next/static/chunks/private.js.map", "/data/system/sqlite.db"]) {
      expect((await proxy(new NextRequest(`http://localhost${path}`))).status).toBe(404);
    }
    expect((await proxy(new NextRequest("http://localhost/api/authentication-fake"))).status).toBe(401);
  });

  it("does not accept a forged session cookie as a page login", async () => {
    const response = await proxy(new NextRequest("http://localhost/workspace", { headers: { cookie: "luma_session=forged" } }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login?");
  });
});
