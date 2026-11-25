import { describe, expect, it } from "vitest";
import {
  IDENTITY_PERFORMANCE_BASELINE_VERSION,
  identityAuxiliaryPanelText,
  identityPerformanceBaselineText,
} from "@/lib/identity-performance";

describe("identity performance prompt assets", () => {
  it("keeps the shared baseline subordinate to current-shot performance evidence rather than a fixed gaze", () => {
    expect(IDENTITY_PERFORMANCE_BASELINE_VERSION).toBe("2026-07-23.1");
    expect(identityPerformanceBaselineText).toContain("not the neutral expression");
    expect(identityPerformanceBaselineText).toContain("Do not force a catchlight");
    expect(identityPerformanceBaselineText).toContain("Observable current-shot performance evidence overrides");
    expect(identityPerformanceBaselineText).toContain("avoid vacant or glassy eyes");
  });

  it("turns expression-board source kinds into textual directions for downstream models", () => {
    expect(identityAuxiliaryPanelText([
      { order: 2, sourceKind: "expression_bright_smile", label: "ignored legacy label" },
      { order: 1, sourceKind: "expression_neutral", label: "friendly opening" },
    ])).toBe(
      "Panel 01: friendly opening with a gentle closed-mouth smile. Panel 02: focused explanation with steady gaze and lightly engaged brows."
    );
  });
});
