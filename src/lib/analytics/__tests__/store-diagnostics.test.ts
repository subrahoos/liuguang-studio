import { describe, expect, it } from "vitest";
import {
  classifyStoreDiagnostic,
  isStoreGmvVariance,
  storeGmvGapRate,
  topStoreGmvVarianceDays,
} from "@/lib/analytics/store-diagnostics";

describe("store diagnostics", () => {
  it("treats a material GMV gap as a metric variance instead of a data failure", () => {
    expect(isStoreGmvVariance(36_189.19, -6_367.62)).toBe(true);
    expect(storeGmvGapRate(36_189.19, -6_367.62)).toBeCloseTo(0.17595, 4);
    expect(classifyStoreDiagnostic({
      gmv: 36_189.19,
      gmvGap: -6_367.62,
      actualProfit: 3_242.93,
      hasDataIssue: false,
    })).toBe("gmv_variance");
  });

  it("keeps verified mapping or formula failures above a GMV variance", () => {
    expect(classifyStoreDiagnostic({
      gmv: 36_189.19,
      gmvGap: -6_367.62,
      actualProfit: 3_242.93,
      hasDataIssue: true,
    })).toBe("data_issue");
  });

  it("returns the largest daily variances with both GMV sides", () => {
    const result = topStoreGmvVarianceDays([
      { metricDate: "2026-11-05", gmv: 5_075.82, gmvGap: -1_302.82 },
      { metricDate: "2026-11-09", gmv: 5_426.9, gmvGap: -1_661.9 },
      { metricDate: "2026-11-01", gmv: 2_599.9, gmvGap: 0.1 },
    ], 2);

    expect(result.map((item) => item.date)).toEqual(["2026-11-09", "2026-11-05"]);
    expect(result[0]).toMatchObject({ storeGmv: 5_426.9, qianchuanGmv: 3_765, gap: -1_661.9 });
    expect(result[0].gapRate).toBeCloseTo(1_661.9 / 5_426.9);
    expect(result[1]).toMatchObject({ storeGmv: 5_075.82, qianchuanGmv: 3_773, gap: -1_302.82 });
  });
});
