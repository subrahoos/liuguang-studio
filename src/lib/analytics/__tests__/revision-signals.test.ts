import { describe, expect, it } from "vitest";
import { buildRevisionSignals, buildVersionComparison } from "@/lib/analytics/service";

type MetricRow = Parameters<typeof buildRevisionSignals>[0][number];
type ImportRow = Parameters<typeof buildRevisionSignals>[1][number];

function completedImport(id: string, snapshotDate: string, committedAt: string): ImportRow {
  return {
    id,
    ownerId: "owner-1",
    status: "completed",
    snapshotDate,
    createdAt: new Date(committedAt),
    committedAt: new Date(committedAt),
  } as ImportRow;
}

function metric(input: {
  importId: string;
  productId: string;
  metricDate?: string;
  roi?: number;
  netDealRoi?: number;
  paidOrders?: number;
  overallShippingRate?: number;
  netShippingRate?: number;
  signRate?: number;
  profitMargin?: number;
  actualProfit?: number;
  gmv?: number;
  adSpend?: number;
  oneHourRefundRate?: number;
}): MetricRow {
  return {
    id: `${input.importId}:${input.productId}:${input.metricDate ?? "2026-07-10"}`,
    importId: input.importId,
    ownerId: "owner-1",
    isSummary: false,
    storeName: "店铺A",
    productId: input.productId,
    planId: "plan-1",
    categoryName: "测试类目",
    productName: "测试商品",
    metricDate: input.metricDate ?? "2026-07-10",
    roi: input.roi ?? 3,
    netDealRoi: input.netDealRoi ?? 2.7,
    paidOrders: input.paidOrders ?? 10,
    overallShippingRate: input.overallShippingRate ?? 0.92,
    netShippingRate: input.netShippingRate ?? 0.9,
    signRate: input.signRate ?? 0.8,
    profitMargin: input.profitMargin ?? 0.2,
    actualProfit: input.actualProfit ?? 100,
    gmv: input.gmv ?? 1_000,
    adSpend: input.adSpend ?? 300,
    oneHourRefundRate: input.oneHourRefundRate ?? 0.1,
  } as MetricRow;
}

describe("buildRevisionSignals", () => {
  it("只返回同一业务记录发生实际变化的修订", () => {
    const previous = completedImport("previous", "2026-07-10", "2026-07-10T08:00:00Z");
    const current = completedImport("current", "2026-07-11", "2026-07-11T08:00:00Z");
    const signals = buildRevisionSignals([
      metric({ importId: previous.id, productId: "changed", actualProfit: 100, roi: 3, netDealRoi: 2.8, paidOrders: 10, overallShippingRate: 0.92, netShippingRate: 0.9, signRate: 0.8, profitMargin: 0.2, gmv: 1_000, adSpend: 300, oneHourRefundRate: 0.1 }),
      metric({ importId: current.id, productId: "changed", actualProfit: 80, roi: 2.5, netDealRoi: 2.4, paidOrders: 9, overallShippingRate: 0.86, netShippingRate: 0.85, signRate: 0.75, profitMargin: 0.16, gmv: 900, adSpend: 320, oneHourRefundRate: 0.12 }),
      metric({ importId: previous.id, productId: "unchanged" }),
      metric({ importId: current.id, productId: "unchanged" }),
    ], [previous, current], {});

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      productId: "changed",
      previousSnapshotDate: "2026-07-10",
      currentSnapshotDate: "2026-07-11",
      actualProfitChange: -20,
      roiChange: -0.5,
      previousNetDealRoi: 2.8,
      currentNetDealRoi: 2.4,
      paidOrdersChange: -1,
      gmvChange: -100,
      adSpendChange: 20,
      profitDeclined: true,
      shippingDeclined: true,
      signDeclined: true,
      refundIncreased: true,
    });
    expect(signals[0]?.netShippingRateChange).toBeCloseTo(-0.05, 8);
    expect(signals[0]?.netDealRoiChange).toBeCloseTo(-0.4, 8);
    expect(signals[0]?.overallShippingRateChange).toBeCloseTo(-0.06, 8);
    expect(signals[0]?.signRateChange).toBeCloseTo(-0.05, 8);
    expect(signals[0]?.profitMarginChange).toBeCloseTo(-0.04, 8);
    expect(signals[0]?.oneHourRefundRateChange).toBeCloseTo(0.02, 8);
  });

  it("只与紧邻的上一份正式导入比较", () => {
    const oldest = completedImport("oldest", "2026-07-09", "2026-07-09T08:00:00Z");
    const previous = completedImport("previous", "2026-07-10", "2026-07-10T08:00:00Z");
    const current = completedImport("current", "2026-07-11", "2026-07-11T08:00:00Z");
    const signals = buildRevisionSignals([
      metric({ importId: oldest.id, productId: "product-1", actualProfit: 140, netShippingRate: 0.95 }),
      metric({ importId: previous.id, productId: "product-1", actualProfit: 110, netShippingRate: 0.85 }),
      metric({ importId: current.id, productId: "product-1", actualProfit: 90, netShippingRate: 0.75 }),
    ], [oldest, previous, current], {});

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      previousSnapshotDate: "2026-07-10",
      currentSnapshotDate: "2026-07-11",
      previousActualProfit: 110,
      currentActualProfit: 90,
      actualProfitChange: -20,
      previousNetShippingRate: 0.85,
      currentNetShippingRate: 0.75,
    });
  });

  it("separates historical revisions, new business data, and records missing from the target version", () => {
    const previous = completedImport("previous", "2026-07-10", "2026-07-10T08:00:00Z");
    const current = completedImport("current", "2026-07-13", "2026-07-13T08:00:00Z");
    const result = buildVersionComparison([
      metric({ importId: previous.id, productId: "changed", actualProfit: 100 }),
      metric({ importId: current.id, productId: "changed", actualProfit: 80 }),
      metric({ importId: previous.id, productId: "unchanged", actualProfit: 100 }),
      metric({ importId: current.id, productId: "unchanged", actualProfit: 100 }),
      metric({ importId: previous.id, productId: "missing", actualProfit: 60 }),
      metric({ importId: current.id, productId: "new-date", metricDate: "2026-07-11", actualProfit: 40, gmv: 500, adSpend: 120 }),
    ], [{ ownerId: "owner-1", baseline: previous, target: current }], "custom", {});

    expect(result.comparison).toMatchObject({
      available: true,
      mode: "custom",
      baseline: { id: "previous" },
      target: { id: "current" },
      summary: {
        overlapRows: 2,
        changedRows: 1,
        unchangedRows: 1,
        addedRows: 1,
        missingRows: 1,
        addedBusinessDates: ["2026-07-11"],
        previousActualProfit: 200,
        currentActualProfit: 180,
        addedActualProfit: 40,
      },
    });
    expect(result.revisionSignals).toHaveLength(1);
    expect(result.revisionSignals[0]).toMatchObject({ productId: "changed", actualProfitChange: -20 });
  });

  it("counts a net deal ROI-only adjustment as a historical revision", () => {
    const previous = completedImport("previous", "2026-07-10", "2026-07-10T08:00:00Z");
    const current = completedImport("current", "2026-07-11", "2026-07-11T08:00:00Z");
    const result = buildVersionComparison([
      metric({ importId: previous.id, productId: "net-deal-roi-only", netDealRoi: 2.8 }),
      metric({ importId: current.id, productId: "net-deal-roi-only", netDealRoi: 2.4 }),
    ], [{ ownerId: "owner-1", baseline: previous, target: current }], "adjacent", {});

    expect(result.comparison.summary).toMatchObject({
      overlapRows: 1,
      changedRows: 1,
      unchangedRows: 0,
    });
    expect(result.revisionSignals[0]?.netDealRoiChange).toBeCloseTo(-0.4, 8);
  });
});
