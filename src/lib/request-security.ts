import type { NextRequest } from "next/server";

/** Public origins must be configured explicitly before exposing this local app. */
export function trustedRequestOrigin(req: NextRequest): string | null {
  const host = (req.headers.get("host") || req.nextUrl.host).toLowerCase();
  if (!host || /[\s/\\,@#?]/.test(host)) return null;
  const configured = (process.env.LUMA_PUBLIC_ORIGINS || "").split(",");
  for (const value of configured) {
    try {
      const url = new URL(value.trim());
      if (url.host.toLowerCase() === host && /^https?:$/.test(url.protocol)
        && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url.origin;
    } catch { /* Ignore invalid entries; never trust forwarded host headers. */ }
  }
  try {
    const url = new URL(`http://${host}`);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && (url.port === (process.env.PORT || "3100") || (!url.port && process.env.NODE_ENV === "test"))) return url.origin;
  } catch { /* Invalid Host. */ }
  return null;
}

/** Never send session cookies to a host/port supplied by a browser. */
export function internalAppOrigin() {
  const port = Number(process.env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid application port");
  return `http://127.0.0.1:${port}`;
}

export function unsafeRequestReason(req: NextRequest): string | null {
  const target = trustedRequestOrigin(req);
  if (!target) return "访问地址未被允许，请配置可信访问域名";
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin === target) return null;
    } catch { /* Opaque and malformed origins are rejected. */ }
    return "已阻止跨站写入请求";
  }
  if (["cross-site", "same-site"].includes(req.headers.get("sec-fetch-site") || "")) return "已阻止跨站写入请求";
  // CLI and internal server requests do not send Origin or Fetch Metadata.
  return null;
}

export function trustedClientIp(req: NextRequest): string {
  // Safe only with a loopback listener and a proxy that OVERWRITES this header.
  if (process.env.LUMA_TRUST_PROXY !== "1") return "local";
  const value = req.headers.get("x-real-ip")?.trim() || "";
  return /^[a-fA-F0-9:.]{1,64}$/.test(value) ? value : "unknown";
}

export function isSensitivePath(pathname: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname).replace(/\\/g, "/"); } catch { return true; }
  return /(?:^|\/)\.(?!well-known(?:\/|$))[^/]+/i.test(decoded)
    || /\.(?:map|key|db|sqlite|sqlite3|bak|ps1|py|env)(?:\/|$)/i.test(decoded)
    || /^\/(?:src|scripts|deployment|node_modules|data|logs|AGENTS\.md|package(?:-lock)?\.json|pnpm-lock\.yaml|tsconfig\.json|next\.config\.[^/]+)(?:\/|$)/i.test(decoded);
}
