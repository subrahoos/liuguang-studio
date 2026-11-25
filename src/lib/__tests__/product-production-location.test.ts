import { describe, expect, it } from "vitest";
import { productionLocationUrl, readProductionLocation } from "@/lib/product-production-location";

describe("production URL position", () => {
  it("restores task, view and step without overwriting workspace parameters", () => {
    const base = "http://localhost:3100/workspace?module=product-production&taskId=other#anchor";
    const location = { id: "task-a", view: "results" as const, step: "production" as const };
    const next = productionLocationUrl(base, location);
    expect(readProductionLocation("http://localhost:3100" + next)).toEqual(location);
    expect(next).toContain("module=product-production");
    expect(next).toContain("taskId=other");
    expect(next).toContain("#anchor");
    expect(productionLocationUrl("http://localhost:3100" + next, null)).toBe("/workspace?module=product-production&taskId=other#anchor");
  });
  it("validates task IDs and unknown positions", () => {
    expect(readProductionLocation("http://localhost/workspace?productionTaskId=../bad")).toBeNull();
    expect(readProductionLocation("http://localhost/workspace")).toBeNull();
    expect(readProductionLocation("http://localhost/workspace?productionTaskId=valid&productionView=bad&productionStep=bad")).toEqual({ id: "valid", view: "setup", step: "product" });
  });
});
