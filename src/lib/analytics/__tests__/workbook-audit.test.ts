import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { auditProfitWorkbook } from "@/lib/analytics/workbook-audit";

describe("workbook formula audit", () => {
  it("ignores an error from a formula prefilled below the last business row", () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["店铺", "订单号"],
      ["示例店铺", "order-1"],
    ]);
    sheet.BX100 = { t: "e", v: "#N/A", f: "VLOOKUP(A100,产品成本!A:B,2,0)" };
    sheet["!ref"] = "A1:BX100";
    XLSX.utils.book_append_sheet(workbook, sheet, "订单明细修改");

    const audit = auditProfitWorkbook(workbook, [], []);
    const orderSheet = audit.sheets.find((item) => item.sheetName === "订单明细修改");

    expect(orderSheet).toMatchObject({
      dataRowCount: 0,
      lastDataRow: 0,
      formulaErrorCount: 0,
    });
    expect(audit.formulaErrorCount).toBe(0);
  });

  it("keeps a formula error that belongs to a real business row", () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["店铺", "订单号"],
      [],
      ["示例店铺", "order-1"],
    ]);
    sheet.BX3 = { t: "e", v: "#N/A", f: "VLOOKUP(A3,产品成本!A:B,2,0)" };
    sheet["!ref"] = "A1:BX3";
    XLSX.utils.book_append_sheet(workbook, sheet, "订单明细修改");

    const audit = auditProfitWorkbook(workbook, [], []);
    const orderSheet = audit.sheets.find((item) => item.sheetName === "订单明细修改");

    expect(orderSheet).toMatchObject({ dataRowCount: 1, formulaErrorCount: 1 });
    expect(audit.formulaErrorCount).toBe(1);
  });
});
