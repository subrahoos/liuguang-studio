import { describe, expect, it } from "vitest";
import {
  isWorkspaceModuleId,
  resolveWorkspaceFeatureEntries,
  WORKSPACE_FEATURE_IDS,
} from "@/lib/workspace-navigation";

describe("workspace feature entries", () => {
  it("keeps every current workspace feature open by default", () => {
    const entries = resolveWorkspaceFeatureEntries();

    expect(Object.keys(entries)).toEqual(WORKSPACE_FEATURE_IDS);
    expect(Object.values(entries)).toEqual(WORKSPACE_FEATURE_IDS.map(() => "open"));
  });

  it("preserves a selected user's waiting state without changing other entries", () => {
    const entries = resolveWorkspaceFeatureEntries({ board: "waiting" });

    expect(entries.board).toBe("waiting");
    expect(entries.methods).toBe("open");
    expect(entries.analytics).toBe("open");
  });

  it("only accepts known workspace module ids", () => {
    expect(isWorkspaceModuleId("quick-cut")).toBe(true);
    expect(isWorkspaceModuleId("product-production")).toBe(true);
    expect(isWorkspaceModuleId("model-settings")).toBe(false);
  });
});
