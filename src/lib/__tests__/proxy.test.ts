import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

describe("protected API proxy", () => {
  it("keeps an unauthenticated API denial out of caches", async () => {
    const response = proxy(new NextRequest("http://localhost/api/admin/model-api-calls"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });
});
