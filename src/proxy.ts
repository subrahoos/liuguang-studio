import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";

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

const PUBLIC_API_PREFIXES = [
  "/api/auth",
  "/api/home-backgrounds",
];

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
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (req.nextUrl.protocol === "https:" || forwardedProto === "https") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
}

function noIndex(response: NextResponse) {
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(AUTH_COOKIE_NAME)?.value);
  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (isProtectedPage) {
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

  if (pathname.startsWith("/api/") && !PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (!hasSession) {
      const response = NextResponse.json({ error: "未登录" }, { status: 401 });
      response.headers.set("Cache-Control", "no-store, max-age=0");
      response.headers.set("Pragma", "no-cache");
      return withSecurityHeaders(response, req);
    }
  }

  const response = withSecurityHeaders(NextResponse.next(), req);
  if (isProtectedPage) noIndex(response);
  return response;
}

export const config = {
  matcher: ["/((?!api/quick-cut/tasks/[^/]+/assets(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)"],
};
