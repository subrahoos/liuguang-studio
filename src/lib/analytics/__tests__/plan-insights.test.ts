import { describe, expect, it } from "vitest";
import { allocatePlanQuota, buildPlanChangeInsights, buildPlanInsights } from "@/lib/analytics/plan-insights";

function plan(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-1",
    metricDate: "2026-10-25",
    buildDate: "2026-10-25",
    planId: "plan-1",
    accountId: "account-1",
    accountShortName: "店铺A",
    accountName: "店铺A投放账户",
    productName: "女装-蕾丝",
    productId: "product-1",
    price: 99,
    spend: 20,
    netOrders: 0,
    netAmount: 0,
    effectiveOrders: 0,
    roiHit: false,
    lowOrderStop: false,
    ...overrides,
  } as never;
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-1",
    isSummary: false,
    metricDate: "2026-10-25",
    categoryName: "女装-蕾丝",
    productName: "女装-蕾丝",
    storeName: "店铺A",
    productId: "product-1",
    price: 99,
    paidOrders: 10,
    fakeOrders: 2,
    shippedOrders: 7,
    pendingOrders: 1,
    postShipRefundOrders: 1,
    actualProfit: 500,
    ...overrides,
  } as never;
}

describe("buildPlanInsights", () => {
  it("merges catalog-name variants across accounts, product IDs, and prices", () => {
    const result = buildPlanInsights([
      plan({ spend: 0.7, planId: "ignored" }),
      plan({ planId: "plan-a", accountId: "account-a", spend: 20, effectiveOrders: 1, netOrders: 1, netAmount: 99 }),
      plan({ planId: "plan-b", accountId: "account-b", accountShortName: "店铺B", productName: "蕾丝B18", productId: "product-2", price: 129, spend: 30 }),
      plan({ planId: "plan-c", accountId: "account-b", productName: "蕾丝J23", productId: "product-3", price: 129, spend: 15, netAmount: 129, effectiveOrders: 1, netOrders: 1 }),
    ], [
      product(),
      product({ categoryName: "蕾丝B18", productName: "蕾丝B18", productId: "product-2", price: 129, actualProfit: 250 }),
      product({ categoryName: "女装-蕾丝J23", productName: "女装-蕾丝J23", productId: "product-3", price: 129, actualProfit: 100 }),
    ], [{ ownerId: "owner-1", snapshotDate: "2026-11-05" }]);

    expect(result.analysisStart).toBe("2026-10-25");
    expect(result.eligiblePlans).toBe(3);
    expect(result.convertedPlans).toBe(2);
    expect(result.products).toHaveLength(1);
    const lace = result.products[0];
    expect(lace.productName).toBe("蕾丝");
    expect(lace.price).toBeNull();
    expect(lace.priceLabel).toBe("多价格 · ¥99 / ¥129");
    expect(lace.productCount).toBe(3);
    expect(lace.accounts).toBe(2);
    expect(lace.totalSpend).toBe(65);
    expect(lace.netRoi).toBeCloseTo(228 / 65);
    expect(lace.matureProfit).toBe(850);
    expect(result.accounts.find((item) => item.accountId === "account-b")?.totalSpend).toBe(45);
    expect(result.accounts.find((item) => item.accountId === "account-a")?.recommendedPlans).toBeNull();
  });

  it("uses registered product names to merge naming-format variants across accounts", () => {
    const result = buildPlanInsights([
      plan({ accountId: "account-a", productName: "男装-商务撞色长袖假两件", spend: 24, netOrders: 1, netAmount: 299, effectiveOrders: 1 }),
      plan({ accountId: "account-b", productName: "商务撞色长袖假两件B33", productId: "product-2", price: 319, spend: 26, netOrders: 1, netAmount: 319, effectiveOrders: 1 }),
    ], [
      product({ categoryName: "男装-商务撞色长袖假两件", productName: "男装-商务撞色长袖假两件" }),
      product({ categoryName: "商务撞色长袖假两件", productName: "商务撞色长袖假两件", productId: "product-2", price: 319 }),
    ], [{ ownerId: "owner-1", snapshotDate: "2026-11-12" }]);

    expect(result.products).toHaveLength(1);
    expect(result.products[0].productName).toBe("商务撞色长袖假两件");
    expect(result.products[0].accountBreakdown).toHaveLength(2);
    expect(result.products[0].totalSpend).toBe(50);
    expect(result.products[0].priceLabel).toBe("多价格 · ¥99 / ¥319");
  });

  it("uses store and product ID before aliases when names share an ambiguous suffix", () => {
    const result = buildPlanInsights([
      plan({ accountId: "account-a", productId: "product-a", productName: "Alpha-围巾", spend: 20 }),
      plan({ accountId: "account-b", productId: "product-b", productName: "Beta-围巾", spend: 30 }),
    ], [
      product({ productId: "product-a", productName: "Alpha-围巾", categoryName: "Alpha-围巾" }),
      product({ productId: "product-b", productName: "Beta-围巾", categoryName: "Beta-围巾" }),
    ], [{ ownerId: "owner-1", snapshotDate: "2026-11-12" }]);

    expect(result.products).toHaveLength(2);
    expect(result.products.map((item) => item.productName).sort()).toEqual(["Alpha-围巾", "Beta-围巾"]);
    expect(result.products.reduce((sum, item) => sum + item.totalSpend, 0)).toBe(50);
    expect(result.products.every((item) => item.productCount === 1 && item.accounts === 1)).toBe(true);
  });

  it("excludes the last five days from mature profit and ignores tiny net amounts as effective orders", () => {
    const result = buildPlanInsights([
      plan({ planId: "plan-a", spend: 20, effectiveOrders: 0, netOrders: 1, netAmount: 4 }),
    ], [product({ metricDate: "2026-11-03", actualProfit: 1000 })], [{ ownerId: "owner-1", snapshotDate: "2026-11-05" }]);

    expect(result.effectiveOrders).toBe(0);
    expect(result.netOrders).toBe(0);
    expect(result.netAmount).toBe(0);
    expect(result.products[0].netRoi).toBe(0);
    expect(result.products[0].matureProfit).toBeNull();
    expect(result.products[0].matureThrough).toBe("2026-10-31");
  });

  it("does not expose mature profit when the source Excel profit is unavailable", () => {
    const result = buildPlanInsights([
      plan({ planId: "mature", storeName: "店铺A", spend: 20, effectiveOrders: 1, netOrders: 1, netAmount: 99 }),
    ], [product({ metricDate: "2026-10-25", actualProfit: 0, profitAvailable: false })], [{ ownerId: "owner-1", snapshotDate: "2026-11-12" }]);

    expect(result.products[0].matureProfit).toBeNull();
    expect(result.products[0].matureProfitPerOrder).toBeNull();
    expect(result.accounts[0].estimatedProfit).toBeNull();
    expect(result.accounts[0].estimatedKnownProfit).toBe(0);
    expect(result.accounts[0].profitKnownRows).toBe(0);
    expect(result.accounts[0].profitTotalRows).toBe(1);
  });

  it("keeps full catalog matching while limiting mature metrics to the selected rows", () => {
    const selected = product({ metricDate: "2026-10-25", productId: "product-1", actualProfit: 120, profitAvailable: true });
    const outside = product({ metricDate: "2026-10-26", productId: "product-2", categoryName: "女装-蕾丝", actualProfit: 900, profitAvailable: true });
    const result = buildPlanInsights([
      plan({ productId: "product-2", productName: "蕾丝B18", spend: 20, effectiveOrders: 1, netOrders: 1, netAmount: 99 }),
    ], [selected], [{ ownerId: "owner-1", snapshotDate: "2026-11-05" }], [selected, outside]);

    expect(result.products[0].productName).toBe("蕾丝");
    expect(result.products[0].matureProfit).toBe(120);
    expect(result.products[0].matureProfitTotalRows).toBe(1);
  });

  it("treats low average-value multi-order compensation rows as non-effective", () => {
    const result = buildPlanInsights([
      plan({ planId: "compensation", spend: 69.88, effectiveOrders: 10, netOrders: 10, netAmount: 5.26 }),
    ], [product()], [{ ownerId: "owner-1", snapshotDate: "2026-11-05" }]);

    expect(result.effectiveOrders).toBe(0);
    expect(result.netOrders).toBe(0);
    expect(result.netAmount).toBe(0);
    expect(result.products[0].convertedPlans).toBe(0);
    expect(result.products[0].netRoi).toBe(0);
  });

  it("exposes retained product and plan IDs", () => {
    const result = buildPlanInsights([
      plan({ planId: "converted", productId: "product-best", spend: 20, effectiveOrders: 1, netOrders: 1, netAmount: 99 }),
      plan({ planId: "idle", productId: "product-idle", spend: 20 }),
    ], [product()], [{ ownerId: "owner-1", snapshotDate: "2026-11-12" }]);
    expect(result.accounts[0].retainItems[0]).toMatchObject({ planId: "converted", productIds: ["product-best"] });
  });

  it("allocates an exact plan quota and keeps account coverage when possible", () => {
    const allocations = allocatePlanQuota([
      { key: "a", suggestedNewPlans: 2, conversionRate: 0.2, estimatedProfit: 100, netRoi: 2 },
      { key: "b", suggestedNewPlans: 0, conversionRate: 0.05, estimatedProfit: -20, netRoi: 0.8 },
      { key: "c", suggestedNewPlans: 1, conversionRate: 0.1, estimatedProfit: 50, netRoi: 1.5 },
    ], 1000);
    expect([...allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(1000);
    expect([...allocations.values()].every((value) => value >= 1)).toBe(true);
  });

  it("returns explicit account actions and daily planning replay fields", () => {
    const rows = Array.from({ length: 10 }, (_, index) => plan({
      planId: `mature-${index}`,
      buildDate: "2026-10-25",
      metricDate: index < 5 ? "2026-10-25" : "2026-11-10",
      spend: 20,
      effectiveOrders: index < 5 ? 1 : 0,
      netOrders: index < 5 ? 1 : 0,
      netAmount: index < 5 ? 99 : 0,
    }));
    const result = buildPlanInsights(rows, [product()], [{ ownerId: "owner-1", snapshotDate: "2026-11-12" }]);
    const account = result.accounts[0];
    expect(account.matureCohortPlans).toBe(10);
    expect(account.recommendedPlans).not.toBeNull();
    expect(account.recommendedAction).toBe("压缩");
    expect(account.suggestedPausePlans).toBeGreaterThan(0);
    const latestDay = result.daily.find((item) => item.date === "2026-11-10");
    expect(latestDay?.recommendationStatus).toBe("历史回放");
    expect(latestDay?.suggestedRetainPlans).toBe(0);
    expect(latestDay?.suggestedPausePlans).toBe(5);
  });

  it("compares complete snapshots without treating missing plans as zero spend", () => {
    const previous = [plan({ planId: "kept", spend: 40, effectiveOrders: 0 }), plan({ planId: "removed", spend: 35, effectiveOrders: 1, netOrders: 1, netAmount: 99 })];
    const current = [plan({ planId: "kept", spend: 55, effectiveOrders: 1, netOrders: 1, netAmount: 99 }), plan({ planId: "added", spend: 20, effectiveOrders: 1, netOrders: 1, netAmount: 99 })];
    const changes = buildPlanChangeInsights({
      currentRows: current,
      previousRows: previous,
      currentSnapshotDate: "2026-11-12",
      previousSnapshotDate: "2026-11-11",
      currentImportId: "current",
      previousImportId: "previous",
    });
    expect(changes.available).toBe(true);
    expect(changes.addedPlans).toBe(1);
    expect(changes.removedPlans).toBe(1);
    expect(changes.changedPlans).toBe(1);
    expect(changes.newConvertedPlans).toBe(1);
    expect(changes.removedPlans).toBe(1);
  });
});
