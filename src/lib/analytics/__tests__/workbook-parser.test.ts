import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { dateValue, numberValue, parseAnalyticsWorkbook, parseAnalyticsWorkbookWithProgress } from "@/lib/analytics/workbook-parser";

function workbookBuffer() {
  const storeHeader = [
    "日期", "店铺", "归属人", "营业额", "货款", "退款（未发货）", "订单总退款", "发货后（退款成功）退货货款",
    "发货后退款订单数", "退货快递费用*5", "服务费5%", "1H退款金额", "赔付登记", "赔付消耗（千川）", "总消耗（维护",
    "利润(赔付登记)=测试", "利润(赔付消耗）=测试", "刷单订单数", "总支付订单数", "利润率(赔付登记）", "赔付后roi",
    "整体退款率", "1H内退款率", "发货前退款率", "发货后退款率", null, null, "千川-店铺GMV差",
  ];
  const storeSheet = XLSX.utils.aoa_to_sheet([
    ["汇总"],
    storeHeader,
    ["2026/07/01", "测试店", "测试用户", 1000, 200, 100, 120, 20, 1, 5, 50, 30, 10, 0, 300, 335, 325, 2, 10, 0.335, 3.2, 0.12, 0.1, 0.03, 0.02, null, null, 0],
  ]);

  const productHeader = [
    "店铺+商品ID", "日期", "求和项:总提交订单数", "求和项:1H退款订单总数", "求和项:总支付订单", "求和项:未发货仅退款",
    "求和项:已发货（发货时间非空）", "求和项:待发货", "求和项:发货后退款", "求和项:(刷单）订单数", "求和项:(刷单）未发货仅退款",
    "求和项:(刷单）待发货", "求和项:(刷单）已发货（发货时间非空）", "求和项:(刷单）发货后退款", "最大值项:售价", "最大值项:成本",
    "求和项:（剔除刷单）订单数", "求和项:(含刷单)成交金额", "求和项:消耗", "求和项:赔付", "ROI(千川）", "ROI（抵扣赔付）",
    "利润率", "净成交roi", "厂家退货款 利润(当下签收-含赔付)", "总签收", "1h内订单退款率", "净成交发货率<90%", "整体发货率<85%", "签收率<80%",
  ];
  const productSummary = ["测试用户+测试店3810743708907864087-测试商品", null, 10, 1, 9, 2, 7, 0, 1, 2, 2, 0, 0, 0, 100, 20, 7, 900, 300, 30, 3, 3.1, 0.1, 2.8, 90, 0.7, 0.14, 0.92, 0.88, 0.82];
  const productDaily = [...productSummary];
  productDaily[1] = "2026/07/01";
  const productSheet = XLSX.utils.aoa_to_sheet([[120], productHeader, productSummary, productDaily]);
  productSheet.Y1 = { t: "n", v: 120 };

  const workbook = XLSX.utils.book_new();
  const orderSheet = XLSX.utils.aoa_to_sheet([[], []]);
  Object.assign(orderSheet, {
    A3: { t: "s", v: "测试店" },
    D3: { t: "s", v: "测试商品" },
    J3: { t: "n", v: 1000 },
    AH3: { t: "s", v: "2026-07-01 10:00:00" },
    AK3: { t: "s", v: "已发货" },
    BE3: { t: "s", v: "2026-07-01 12:00:00" },
    BW3: { t: "s", v: "3810743708907864087" },
    BY3: { t: "n", v: 200 },
    BZ3: { t: "s", v: "测试用户" },
    CC3: { t: "s", v: "测试用户+测试店3810743708907864087-测试商品" },
    CD3: { t: "s", v: "2026/07/01" },
    "!ref": "A1:CF3",
  });
  const productDailySheet = XLSX.utils.aoa_to_sheet([
    ["日期", "店铺+商品ID", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "消耗", "赔付"],
    [],
    ["2026/07/01", "测试用户+测试店3810743708907864087-测试商品", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 300, 30],
  ]);
  productDailySheet.A2 = { t: "n", v: 0, f: "UNIQUE(VSTACK(订单明细修改!CB2:CC100,'千川计划消耗-全域'!V2:W2))" };
  const categorySheet = XLSX.utils.aoa_to_sheet([
    ["产品编号", "成本", "店铺", "上架日期", "商品ID", null, "价格", "备注", "产品名称"],
    [null, 20, "测试店", null, "3810743708907864087", null, 100, null, "男装 - Q510休闲polo"],
    [null, 30, "历史别名店", null, "3810743708907864999", null, 120, null, "不应进入当前经营范围"],
  ]);
  const spendSheet = XLSX.utils.aoa_to_sheet([
    ["消耗日期", "计划名称", "计划ID", "抖音号名称", "商品ID(CTRL+E提取", "消耗", "店铺"],
    ["2026/07/01", "测试计划", "1843060997704875", "测试店", "3810743708907864087", 300, "测试店"],
  ]);
  XLSX.utils.book_append_sheet(workbook, orderSheet, "订单明细修改");
  XLSX.utils.book_append_sheet(workbook, storeSheet, "店铺每日数据汇总");
  XLSX.utils.book_append_sheet(workbook, productDailySheet, "商品每日数据汇总- 提取刷单");
  XLSX.utils.book_append_sheet(workbook, productSheet, "数据透视表-提取刷单");
  XLSX.utils.book_append_sheet(workbook, categorySheet, "产品类目登记");
  XLSX.utils.book_append_sheet(workbook, spendSheet, "千川计划消耗-全域");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("analytics workbook parser", () => {
  it("normalizes percentages and Excel dates", () => {
    expect(numberValue("12.5%")).toBeCloseTo(0.125);
    expect(dateValue("2026/7/1")).toBe("2026-07-01");
    expect(dateValue(46200)).toBe("2026-06-27");
    expect(dateValue(0)).toBeNull();
  });

  it("reads store facts and the product's semantically labeled actual-profit field", () => {
    const parsed = parseAnalyticsWorkbook(workbookBuffer());
    expect(parsed.storeCount).toBe(1);
    expect(parsed.productCount).toBe(1);
    expect(parsed.registeredProductCount).toBe(1);
    expect(parsed.productRegistry).toEqual([expect.objectContaining({
      storeName: "测试店",
      productId: "3810743708907864087",
      productName: "男装-Q510休闲polo",
      planId: "1843060997704875",
    })]);
    expect(parsed.periodStart).toBe("2026-07-01");
    expect(parsed.periodEnd).toBe("2026-07-01");
    expect(parsed.productPeriodStart).toBe("2026-07-01");
    expect(parsed.productPeriodEnd).toBe("2026-07-01");
    expect(parsed.sourceOrderRows).toBe(1);
    expect(parsed.sourceOrderLastRow).toBe(3);
    expect(parsed.sourceSpendRows).toBe(1);
    expect(parsed.sourceSpendLastRow).toBe(2);
    expect(parsed.productProfitTotal).toBe(90);
    expect(parsed.cachedProductProfitTotal).toBe(120);
    expect(parsed.reconciliationStatus).toBe("fail");
    expect(parsed.reconciliations.find((item) => item.checkKey === "source_product_rebuild")).toMatchObject({
      status: "warning",
      expectedValue: 1,
      actualValue: null,
    });
    expect(parsed.stores[0]).toMatchObject({ storeName: "测试店", actualProfit: 335, adSpend: 300 });
    expect(parsed.products.find((item) => item.isSummary)).toMatchObject({
      productId: "3810743708907864087",
      planId: "1843060997704875",
      categoryName: "男装-Q510休闲polo",
      actualProfit: 90,
      pendingOrders: 0,
      signRate: 0.82,
    });
    expect(parsed.sheetAudits.find((item) => item.sheetName === "订单明细修改")).toMatchObject({
      rowCount: 3,
      dataRowCount: 1,
      lastDataRow: 3,
      referenceLimitRow: 100,
      status: "pass",
    });
    expect(parsed.sheetAudits.find((item) => item.sheetName === "千川计划消耗-全域")).toMatchObject({
      dataRowCount: 1,
      lastDataRow: 2,
      referenceLimitRow: 2,
      referenceUsage: 1,
      status: "warning",
    });
  });

  it("reports real, ordered stages while parsing asynchronously", async () => {
    const progress: Array<{ progress: number; stage: string }> = [];
    const parsed = await parseAnalyticsWorkbookWithProgress(workbookBuffer(), async (step) => { progress.push(step); });

    expect(progress.length).toBeGreaterThan(5);
    expect(progress.map((step) => step.progress)).toEqual([...progress.map((step) => step.progress)].sort((left, right) => left - right));
    expect(progress.at(-1)).toMatchObject({ progress: 86, stage: "正在整理预检结果" });
    expect(progress.some((step) => step.stage.includes("店铺日数据"))).toBe(true);
    expect(parsed.storeCount).toBe(1);
    expect(parsed.productCount).toBe(1);
  });
});
