import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { isSensitivePath, trustedRequestOrigin, unsafeRequestReason } from "@/lib/request-security";

const PROTECTED_PAGE_PREFIXES = [
  "/workspace",
  "/settings",
  "/project",
  "/products",
  "/clone-methods",
  "/identity-pack",
  "/board-workflows",
  "/batch",
];

const PUBLIC_APIS = new Set(["/api/auth/login", "/api/auth/register", "/api/auth/me", "/api/auth/logout"]);

const LEGACY_WORKSPACE_MODULES: Record<string, string> = {
  "/products": "products",
  "/clone-methods": "methods",
  "/identity-pack": "identity",
  "/project/new": "new",
  "/project/clone": "clone",
  "/board-workflows": "board",
};

function withSecurityHeaders(response: NextResponse, req: NextRequest) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (trustedRequestOrigin(req)?.startsWith("https://")) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (req.nextUrl.pathname.startsWith("/api/")) {
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("Pragma", "no-cache");
    response.headers.append("Vary", "Cookie");
    // Uploaded SVG/HTML must never execute same-origin scripts when opened.
    response.headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }
  return response;
}

function noIndex(response: NextResponse) {
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isSensitivePath(pathname)) return withSecurityHeaders(new NextResponse(null, { status: 404 }), req);
  const unsafe = unsafeRequestReason(req);
  if (unsafe) return withSecurityHeaders(NextResponse.json({ error: unsafe }, { status: 403 }), req);
  let hasSession = Boolean(req.cookies.get(AUTH_COOKIE_NAME)?.value);
  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (isProtectedPage) {
    if (hasSession) {
      const { getSessionUser } = await import("@/lib/auth");
      hasSession = Boolean(await getSessionUser(req));
    }
    if (!hasSession) {
      const url = req.nextUrl.clone();
      const requestedPath = `${pathname}${req.nextUrl.search}`;
      url.pathname = pathname === "/settings" ? "/" : "/login";
      url.search = "";
      url.searchParams.set("from", requestedPath);
      return noIndex(withSecurityHeaders(NextResponse.redirect(url), req));
    }
  }

  if (hasSession) {
    const featureId = LEGACY_WORKSPACE_MODULES[pathname];
    if (featureId) {
      const url = req.nextUrl.clone();
      url.pathname = "/workspace";
      url.search = "";
      url.searchParams.set("module", featureId);
      return noIndex(withSecurityHeaders(NextResponse.redirect(url), req));
    }

    if (pathname.startsWith("/board-workflows/")) {
      const workflowId = pathname.slice("/board-workflows/".length).split("/")[0];
      if (workflowId) {
        const url = req.nextUrl.clone();
        url.pathname = "/workspace";
        url.search = "";
        url.searchParams.set("module", "board");
        url.searchParams.set("boardId", workflowId);
        return noIndex(withSecurityHeaders(NextResponse.redirect(url), req));
      }
    }
  }

  if (pathname.startsWith("/api/") && !PUBLIC_APIS.has(pathname)) {
    if (!hasSession) {
      const response = NextResponse.json({ error: "未登录" }, { status: 401 });
      response.headers.set("Cache-Control", "no-store, max-age=0");
      response.headers.set("Pragma", "no-cache");
      return withSecurityHeaders(response, req);
    }
  }

  const requestHeaders = new Headers(req.headers);
  const origin = new URL(trustedRequestOrigin(req)!);
  requestHeaders.set("x-forwarded-host", origin.host);
  requestHeaders.set("x-forwarded-proto", origin.protocol.slice(0, -1));
  if (process.env.LUMA_TRUST_PROXY !== "1") {
    requestHeaders.delete("x-forwarded-for");
    requestHeaders.delete("x-real-ip");
    requestHeaders.delete("forwarded");
  }
  const response = withSecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), req);
  if (isProtectedPage) {
    noIndex(response);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }
  return response;
}

export const config = {
  // Large quick-cut streams enforce the same origin/auth checks in the handler;
  // excluding only this exact route avoids buffering multi-GB videos in Proxy.
  matcher: ["/((?!api/quick-cut/tasks/[^/]+/assets/?$).*)"],
};
