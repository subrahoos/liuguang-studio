import * as XLSX from "xlsx";
import type { ParsedProductMetric, ParsedStoreDaily } from "@/lib/analytics/workbook-parser";

export type WorkbookSheetAudit = {
  sheetName: string;
  sheetRole: "source" | "lookup" | "transform" | "decision" | "documentation";
  businessPurpose: string;
  joinKeys: string[];
  rowCount: number;
  dataRowCount: number;
  lastDataRow: number;
  columnCount: number;
  formulaCount: number;
  formulaPatternCount: number;
  formulaErrorCount: number;
  fixedRangeReferenceCount: number;
  fixedRangeRiskCount: number;
  referenceLimitRow: number | null;
  referenceUsage: number | null;
  hiddenRowCount: number;
  hiddenSheet: boolean;
  autoFilter: string | null;
  headers: string[];
  dependencies: string[];
  status: "pass" | "warning" | "fail";
  riskMessages: string[];
};

export type WorkbookFormulaAudit = {
  sheetName: string;
  columnRef: string;
  columnHeader: string | null;
  formulaPattern: string;
  sampleCell: string;
  sampleFormula: string;
  formulaCount: number;
  firstRow: number;
  lastRow: number;
  dependencies: string[];
  formulaKind: "mapping" | "aggregation" | "transformation" | "calculation" | "simulation";
  businessMeaning: string;
  hasFixedRangeReference: boolean;
  hasFixedRangeRisk: boolean;
  hasFormulaError: boolean;
};

export type WorkbookReconciliation = {
  checkKey: string;
  category: "structure" | "formula" | "store" | "product" | "mapping";
  status: "pass" | "warning" | "fail";
  label: string;
  expectedValue: number | null;
  actualValue: number | null;
  difference: number | null;
  tolerance: number | null;
  message: string;
};

export type WorkbookAuditResult = {
  sheets: WorkbookSheetAudit[];
  formulas: WorkbookFormulaAudit[];
  reconciliations: WorkbookReconciliation[];
  formulaCount: number;
  formulaErrorCount: number;
  fixedRangeRiskCount: number;
  reconciliationStatus: "pass" | "warning" | "fail";
  productProfitTotal: number;
  cachedProductProfitTotal: number;
};

const sheetDefinitions: Record<string, Pick<WorkbookSheetAudit, "sheetRole" | "businessPurpose" | "joinKeys">> = {
  "订单明细修改": { sheetRole: "source", businessPurpose: "订单事实与商品、成本、退款、发货状态的主数据源。", joinKeys: ["订单ID", "日期+店铺+商品ID"] },
  "产品成本": { sheetRole: "lookup", businessPurpose: "按店铺和商品ID补充单价、成本变动与供应商信息。", joinKeys: ["店铺+商品ID", "商品ID"] },
  "产品类目登记": { sheetRole: "lookup", businessPurpose: "登记商品类目、名称、售价和备用成本。", joinKeys: ["商品ID"] },
  "千川计划消耗-标准": { sheetRole: "source", businessPurpose: "标准千川账户的单日消耗、成交和ROI。", joinKeys: ["日期+账户ID"] },
  "千川计划消耗-全域": { sheetRole: "source", businessPurpose: "全域计划、商品、消耗、GMV、ROI、计划状态和赔付。", joinKeys: ["日期+计划ID", "日期+店铺+商品ID"] },
  "赔付金额": { sheetRole: "source", businessPurpose: "按计划、商品、日期登记到账赔付。", joinKeys: ["计划ID", "商品ID+计划日期"] },
  "售后工作台": { sheetRole: "source", businessPurpose: "售后申请、退款、退货物流与1H退款事实。", joinKeys: ["订单号", "商品单号"] },
  "店铺每日数据汇总": { sheetRole: "transform", businessPurpose: "按日期和店铺汇总GMV、消耗、退款、成本、赔付与店铺真实利润。", joinKeys: ["日期+店铺"] },
  "商品每日数据汇总- 提取刷单": { sheetRole: "transform", businessPurpose: "按日期和店铺商品汇总订单、刷单、退款、成本、GMV和消耗。", joinKeys: ["日期+店铺+商品ID"] },
  "数据透视表-提取刷单": { sheetRole: "decision", businessPurpose: "从商品日数据生成商品周期、每日利润、ROI、发货和签收决策指标。", joinKeys: ["店铺+商品ID", "日期+店铺+商品ID"] },
  "全域-ROI出价赔付计算": { sheetRole: "decision", businessPurpose: "人工输入场景下测算全域ROI出价、预期消耗和赔付线。", joinKeys: ["人工测算场景"] },
  "数据收集源-截图-注意事项": { sheetRole: "documentation", businessPurpose: "记录数据下载入口、截图和人工采集注意事项。", joinKeys: [] },
  "千川账户对照": { sheetRole: "lookup", businessPurpose: "把千川账户ID映射为店铺和运营归属。", joinKeys: ["千川账户ID"] },
  "利润表（签收表3.0）": { sheetRole: "decision", businessPurpose: "按发货率、签收率、成本、售价和ROI进行利润及保本情景测算。", joinKeys: ["人工测算商品"] },
  "Sheet1": { sheetRole: "documentation", businessPurpose: "运营SOP、账户清单和历史说明，不参与真实利润计算。", joinKeys: ["账户ID"] },
};

export const requiredProfitSheets = Object.keys(sheetDefinitions);

function normalizeFormula(formula: string) {
  return formula.replace(/(\$?[A-Z]{1,3}\$?)\d+/g, "$1{row}").replace(/\s+/g, "").toUpperCase();
}

function formulaDependencies(formula: string) {
  const names = new Set<string>();
  const quoted = /'((?:[^']|'')+)'!/g;
  for (const match of formula.matchAll(quoted)) names.add(match[1].replace(/''/g, "'"));
  const plain = /([\p{Script=Han}A-Za-z0-9_][\p{Script=Han}A-Za-z0-9_.\- ]*)!/gu;
  for (const match of formula.matchAll(plain)) {
    const value = match[1].trim();
    if (value && value !== "REF" && !value.endsWith("'")) names.add(value);
  }
  return [...names];
}

function formulaKind(formula: string, sheetName: string): WorkbookFormulaAudit["formulaKind"] {
  const upper = formula.toUpperCase();
  if (sheetName.includes("计算") || sheetName.includes("签收表")) return "simulation";
  if (/SUMIFS|COUNTIFS|SUBTOTAL|UNIQUE|VSTACK/.test(upper)) return "aggregation";
  if (/XLOOKUP|VLOOKUP|INDEX|MATCH/.test(upper)) return "mapping";
  if (/CLEAN|TEXT|TRIM|LEFT|RIGHT|MID/.test(upper)) return "transformation";
  return "calculation";
}

function businessMeaning(sheetName: string, formula: string, header: string | null) {
  const upper = formula.toUpperCase();
  if (sheetName === "订单明细修改" && /产品成本|产品类目登记/.test(formula)) return "按商品ID补充商品成本或类目备用值。";
  if (sheetName === "订单明细修改" && /售后工作台/.test(formula)) return "按订单号回查售后时间或1H退款标签。";
  if (sheetName.includes("千川计划消耗") && /千川账户对照/.test(formula)) return "把千川账户ID映射到店铺。";
  if (sheetName === "店铺每日数据汇总" && upper.includes("SUMIFS")) return `按日期和店铺汇总${header || "经营指标"}。`;
  if (sheetName === "商品每日数据汇总- 提取刷单" && upper.includes("COUNTIFS")) return `按日期和店铺商品统计${header || "订单指标"}。`;
  if (sheetName === "商品每日数据汇总- 提取刷单" && /UNIQUE|VSTACK/i.test(formula)) return "合并订单与全域投放键并生成唯一的日期+店铺商品清单。";
  if (sheetName === "数据透视表-提取刷单" && header?.includes("厂家退货款")) return "按实际销售额、广告费、退货货款、平台抽点和赔付计算商品真实利润。";
  if (sheetName === "数据透视表-提取刷单" && header?.toLowerCase().includes("roi")) return "计算投放成交金额与广告消耗之间的ROI。";
  if (sheetName === "数据透视表-提取刷单" && header?.includes("发货率")) return "依据剔除刷单后的订单与退款状态计算发货兑现比例。";
  if (sheetName === "数据透视表-提取刷单" && header?.includes("签收率")) return "依据已发货订单和发货后退款计算签收兑现比例。";
  if (sheetName.includes("计算") || sheetName.includes("签收表")) return `情景测算：${header || "利润/ROI参数"}，不代表已发生经营事实。`;
  if (/XLOOKUP|VLOOKUP|INDEX|MATCH/i.test(formula)) return `映射补充${header || "关联字段"}。`;
  if (/SUMIFS|COUNTIFS|SUBTOTAL/i.test(formula)) return `汇总计算${header || "指标"}。`;
  return `计算${header || "派生指标"}。`;
}

function hasFixedRangeRisk(formula: string) {
  return /(?:!|\$)[A-Z]{1,3}\$?\d+:[A-Z]{1,3}\$?\d+/i.test(formula) || /\$[A-Z]{1,3}\$\d+:\$[A-Z]{1,3}\$\d+/i.test(formula);
}

function hasValue(cell: XLSX.CellObject | undefined) {
  return cell?.v !== null && cell?.v !== undefined && String(cell.v).trim() !== "";
}

function looksLikeDate(cell: XLSX.CellObject | undefined) {
  if (!hasValue(cell)) return false;
  if (cell?.v instanceof Date || typeof cell?.v === "number") return true;
  return /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(String(cell?.v).trim());
}

function sheetDataProfile(sheetName: string, sheet: XLSX.WorkSheet, range: XLSX.Range) {
  let dataRowCount = 0;
  let lastDataRow = 0;
  const headerColumn = (predicate: (header: string) => boolean, fallback: string) => {
    for (let row = 1; row <= Math.min(8, range.e.r + 1); row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const ref = XLSX.utils.encode_col(column);
        const header = String(sheet[`${ref}${row}`]?.v ?? "").replace(/\s+/g, "").toLowerCase();
        if (predicate(header)) return ref;
      }
    }
    return fallback;
  };
  const spendDateColumn = sheetName === "千川计划消耗-全域" ? headerColumn((header) => header === "消耗日期", "A") : "A";
  const spendPlanColumn = sheetName === "千川计划消耗-全域" ? headerColumn((header) => header === "计划id", "C") : "C";
  const spendProductColumn = sheetName === "千川计划消耗-全域" ? headerColumn((header) => header.includes("商品id"), "K") : "K";
  const genericDataRows = new Set<number>();
  if (!["订单明细修改", "千川计划消耗-全域", "产品类目登记", "店铺每日数据汇总", "数据透视表-提取刷单", "商品每日数据汇总- 提取刷单"].includes(sheetName)) {
    for (const [address, rawCell] of Object.entries(sheet)) {
      if (address.startsWith("!")) continue;
      const cell = rawCell as XLSX.CellObject;
      if (!cell.f && hasValue(cell)) genericDataRows.add(XLSX.utils.decode_cell(address).r + 1);
    }
  }
  const rowMatches = (row: number) => {
    if (sheetName === "订单明细修改") return row >= 3 && (hasValue(sheet[`B${row}`]) || hasValue(sheet[`AH${row}`]));
    if (sheetName === "千川计划消耗-全域") return row >= 2 && hasValue(sheet[`${spendDateColumn}${row}`]) && hasValue(sheet[`${spendPlanColumn}${row}`]) && hasValue(sheet[`${spendProductColumn}${row}`]);
    if (sheetName === "产品类目登记") return row >= 2 && hasValue(sheet[`C${row}`]) && hasValue(sheet[`E${row}`]);
    if (sheetName === "店铺每日数据汇总") return row >= 3 && looksLikeDate(sheet[`A${row}`]) && hasValue(sheet[`B${row}`]);
    if (sheetName === "数据透视表-提取刷单") {
      const key = String(sheet[`A${row}`]?.v ?? "").trim();
      return row >= 3 && Boolean(key) && !/总计|合计/.test(key);
    }
    if (sheetName === "商品每日数据汇总- 提取刷单") return row >= 3 && looksLikeDate(sheet[`A${row}`]) && hasValue(sheet[`B${row}`]);
    return row >= 2 && genericDataRows.has(row);
  };

  for (let row = range.s.r + 1; row <= range.e.r + 1; row += 1) {
    if (!rowMatches(row)) continue;
    dataRowCount += 1;
    lastDataRow = row;
  }
  return { dataRowCount, lastDataRow, isDataRow: rowMatches };
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixedRangeReferences(formula: string, sheetNames: string[]) {
  const references: Array<{ sheetName: string; startRow: number; endRow: number }> = [];
  for (const sheetName of sheetNames) {
    const escapedName = escapedRegExp(sheetName);
    const pattern = new RegExp(`(?:'${escapedName.replace(/'/g, "''")}'|${escapedName})!\\$?[A-Z]{1,3}\\$?(\\d+):\\$?[A-Z]{1,3}\\$?(\\d+)`, "gi");
    for (const match of formula.matchAll(pattern)) {
      references.push({ sheetName, startRow: Number(match[1]), endRow: Number(match[2]) });
    }
  }
  return references;
}

function sheetHeaders(sheet: XLSX.WorkSheet) {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false, range: 0 }).slice(0, 8);
  const best = rows.reduce((current, row) => {
    const score = row.filter((cell) => typeof cell === "string" && cell.trim()).length;
    return score > current.score ? { row, score } : current;
  }, { row: [] as unknown[], score: -1 });
  return best.row.map((cell) => String(cell ?? "").replace(/\s+/g, " ").trim()).slice(0, 80);
}

function inspectSheet(workbook: XLSX.WorkBook, sheetName: string, index: number) {
  const sheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
  const dataProfile = sheetDataProfile(sheetName, sheet, range);
  const headers = sheetHeaders(sheet);
  const patterns = new Map<string, WorkbookFormulaAudit>();
  const dependencies = new Set<string>();
  let formulaCount = 0;
  let formulaErrorCount = 0;
  let fixedRangeReferenceCount = 0;

  for (const [address, rawCell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    const cell = rawCell as XLSX.CellObject;
    if (!cell.f) continue;
    formulaCount += 1;
    const decoded = XLSX.utils.decode_cell(address);
    const isDataRow = dataProfile.isDataRow(decoded.r + 1);
    const columnRef = XLSX.utils.encode_col(decoded.c);
    const pattern = normalizeFormula(cell.f);
    const key = `${columnRef}:${pattern}`;
    const deps = formulaDependencies(cell.f).filter((name) => name !== sheetName);
    deps.forEach((name) => dependencies.add(name));
    const fixedReference = hasFixedRangeRisk(cell.f);
    // Pre-filled formulas commonly return #N/A below the last real row. They are
    // not current business-data errors, but a literal #REF! is always actionable.
    const formulaError = cell.f.includes("#REF!") || (isDataRow && cell.t === "e");
    if (fixedReference) fixedRangeReferenceCount += 1;
    if (formulaError) formulaErrorCount += 1;
    const current = patterns.get(key);
    if (current) {
      current.formulaCount += 1;
      current.lastRow = Math.max(current.lastRow, decoded.r + 1);
      current.firstRow = Math.min(current.firstRow, decoded.r + 1);
      current.hasFixedRangeReference ||= fixedReference;
      current.hasFormulaError ||= formulaError;
      for (const dependency of deps) if (!current.dependencies.includes(dependency)) current.dependencies.push(dependency);
      continue;
    }
    const header = headers[decoded.c] || null;
    patterns.set(key, {
      sheetName,
      columnRef,
      columnHeader: header,
      formulaPattern: pattern,
      sampleCell: address,
      sampleFormula: cell.f,
      formulaCount: 1,
      firstRow: decoded.r + 1,
      lastRow: decoded.r + 1,
      dependencies: deps,
      formulaKind: formulaKind(cell.f, sheetName),
      businessMeaning: businessMeaning(sheetName, cell.f, header),
      hasFixedRangeReference: fixedReference,
      hasFixedRangeRisk: false,
      hasFormulaError: formulaError,
    });
  }

  const definition = sheetDefinitions[sheetName] || { sheetRole: "source" as const, businessPurpose: "未登记的工作表。", joinKeys: [] };
  const hiddenRowCount = (sheet["!rows"] || []).filter((row) => row?.hidden).length;
  const riskMessages: string[] = [];
  if (formulaErrorCount) riskMessages.push(`${formulaErrorCount} 个公式错误或 #REF!。`);
  if (hiddenRowCount) riskMessages.push(`${hiddenRowCount} 行被筛选或隐藏，顶部 SUBTOTAL 只代表当前可见范围。`);
  const status: WorkbookSheetAudit["status"] = formulaErrorCount || hiddenRowCount ? "warning" : "pass";
  const audit: WorkbookSheetAudit = {
    sheetName,
    ...definition,
    rowCount: range.e.r - range.s.r + 1,
    dataRowCount: dataProfile.dataRowCount,
    lastDataRow: dataProfile.lastDataRow,
    columnCount: range.e.c - range.s.c + 1,
    formulaCount,
    formulaPatternCount: patterns.size,
    formulaErrorCount,
    fixedRangeReferenceCount,
    fixedRangeRiskCount: 0,
    referenceLimitRow: null,
    referenceUsage: null,
    hiddenRowCount,
    hiddenSheet: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
    autoFilter: sheet["!autofilter"]?.ref || null,
    headers,
    dependencies: [...dependencies],
    status,
    riskMessages,
  };
  return { audit, formulas: [...patterns.values()] };
}

function amountSum(values: number[]) {
  return values.reduce((total, value) => total + Math.round((value || 0) * 1_000_000), 0) / 1_000_000;
}

export function auditProfitWorkbook(workbook: XLSX.WorkBook, stores: ParsedStoreDaily[], products: ParsedProductMetric[]): WorkbookAuditResult {
  const inspected = workbook.SheetNames.map((name, index) => inspectSheet(workbook, name, index));
  const sheets = inspected.map((item) => item.audit);
  const formulas = inspected.flatMap((item) => item.formulas);
  const referenceLimits = new Map<string, number>();
  for (const formula of formulas) {
    for (const reference of fixedRangeReferences(formula.sampleFormula, workbook.SheetNames)) {
      referenceLimits.set(reference.sheetName, Math.max(referenceLimits.get(reference.sheetName) ?? 0, reference.endRow));
    }
  }
  for (const sheet of sheets) {
    const referenceLimitRow = referenceLimits.get(sheet.sheetName) ?? null;
    sheet.referenceLimitRow = referenceLimitRow;
    sheet.referenceUsage = referenceLimitRow && sheet.lastDataRow ? sheet.lastDataRow / referenceLimitRow : null;
    if (sheet.referenceUsage === null) continue;
    const remainingRows = referenceLimitRow! - sheet.lastDataRow;
    if (sheet.referenceUsage > 1) {
      sheet.status = "fail";
      sheet.riskMessages.push(`实际数据末行 ${sheet.lastDataRow.toLocaleString("zh-CN")} 已超过公式引用上限 ${referenceLimitRow!.toLocaleString("zh-CN")}，超出 ${Math.abs(remainingRows).toLocaleString("zh-CN")} 行。`);
    } else if (sheet.referenceUsage >= 0.9) {
      if (sheet.status !== "fail") sheet.status = "warning";
      sheet.riskMessages.push(`实际数据末行 ${sheet.lastDataRow.toLocaleString("zh-CN")}，公式引用至 ${referenceLimitRow!.toLocaleString("zh-CN")}，剩余 ${remainingRows.toLocaleString("zh-CN")} 行。`);
    }
  }
  for (const formula of formulas) {
    const references = fixedRangeReferences(formula.sampleFormula, workbook.SheetNames);
    formula.hasFixedRangeRisk = references.some((reference) => {
      const target = sheets.find((sheet) => sheet.sheetName === reference.sheetName);
      return Boolean(target?.referenceUsage && target.referenceUsage >= 0.9);
    });
  }
  for (const sheet of sheets) {
    sheet.fixedRangeRiskCount = formulas.filter((formula) => formula.sheetName === sheet.sheetName && formula.hasFixedRangeRisk).length;
    if (sheet.fixedRangeRiskCount) {
      if (sheet.status !== "fail") sheet.status = "warning";
      sheet.riskMessages.push(`${sheet.fixedRangeRiskCount} 种公式模式引用的上游固定范围已达到 90% 使用率。`);
    }
  }
  const reconciliations: WorkbookReconciliation[] = [];
  const missingSheets = requiredProfitSheets.filter((name) => !workbook.SheetNames.includes(name));
  reconciliations.push({
    checkKey: "required_sheets",
    category: "structure",
    status: missingSheets.length ? "fail" : "pass",
    label: "必需工作表",
    expectedValue: requiredProfitSheets.length,
    actualValue: requiredProfitSheets.length - missingSheets.length,
    difference: missingSheets.length,
    tolerance: 0,
    message: missingSheets.length ? `缺少：${missingSheets.join("、")}` : `${requiredProfitSheets.length} 张业务工作表齐全。`,
  });

  const formulaErrorCount = sheets.reduce((total, sheet) => total + sheet.formulaErrorCount, 0);
  reconciliations.push({
    checkKey: "formula_errors",
    category: "formula",
    status: formulaErrorCount ? "warning" : "pass",
    label: "公式错误",
    expectedValue: 0,
    actualValue: formulaErrorCount,
    difference: formulaErrorCount,
    tolerance: 0,
    message: formulaErrorCount ? `发现 ${formulaErrorCount} 个错误公式或 #REF!；错误字段单独禁用，核心利润字段继续按列级校验。` : "未发现错误公式。",
  });

  const fixedRangeRiskCount = sheets.reduce((total, sheet) => total + sheet.fixedRangeRiskCount, 0);
  const hasExceededRange = sheets.some((sheet) => (sheet.referenceUsage ?? 0) > 1);
  reconciliations.push({
    checkKey: "fixed_formula_ranges",
    category: "formula",
    status: hasExceededRange ? "fail" : fixedRangeRiskCount ? "warning" : "pass",
    label: "公式范围覆盖",
    expectedValue: 0,
    actualValue: fixedRangeRiskCount,
    difference: fixedRangeRiskCount,
    tolerance: 0,
    message: hasExceededRange
      ? "存在源表实际数据超过公式引用上限，超出部分会漏算。"
      : fixedRangeRiskCount
        ? `${fixedRangeRiskCount} 种公式模式引用的源表已使用至少 90% 固定范围，请预留扩容。`
        : "固定引用范围均有充足余量，当前不会漏算。",
  });

  for (const sheetName of ["订单明细修改", "千川计划消耗-全域"]) {
    const sheet = sheets.find((item) => item.sheetName === sheetName);
    if (!sheet?.referenceLimitRow || !sheet.lastDataRow) continue;
    const remainingRows = sheet.referenceLimitRow - sheet.lastDataRow;
    const status: WorkbookReconciliation["status"] = sheet.referenceUsage! > 1 ? "fail" : sheet.referenceUsage! >= 0.9 ? "warning" : "pass";
    reconciliations.push({
      checkKey: sheetName === "订单明细修改" ? "order_formula_coverage" : "qianchuan_formula_coverage",
      category: "formula",
      status,
      label: sheetName === "订单明细修改" ? "订单公式覆盖" : "千川公式覆盖",
      expectedValue: sheet.referenceLimitRow,
      actualValue: sheet.lastDataRow,
      difference: remainingRows,
      tolerance: Math.floor(sheet.referenceLimitRow * 0.1),
      message: `${sheetName}有效数据 ${sheet.dataRowCount.toLocaleString("zh-CN")} 行，实际末行 ${sheet.lastDataRow.toLocaleString("zh-CN")}；公式引用至 ${sheet.referenceLimitRow.toLocaleString("zh-CN")}，${remainingRows >= 0 ? `剩余 ${remainingRows.toLocaleString("zh-CN")} 行` : `已超出 ${Math.abs(remainingRows).toLocaleString("zh-CN")} 行`}（使用率 ${(sheet.referenceUsage! * 100).toFixed(1)}%）。`,
    });
  }

  const storeKeyCounts = new Map<string, number>();
  for (const row of stores) storeKeyCounts.set(`${row.metricDate}:${row.storeName}`, (storeKeyCounts.get(`${row.metricDate}:${row.storeName}`) || 0) + 1);
  const duplicateStores = [...storeKeyCounts.values()].filter((count) => count > 1).length;
  reconciliations.push({
    checkKey: "store_daily_keys",
    category: "store",
    status: duplicateStores ? "fail" : "pass",
    label: "店铺日主键",
    expectedValue: 0,
    actualValue: duplicateStores,
    difference: duplicateStores,
    tolerance: 0,
    message: duplicateStores ? `${duplicateStores} 个“日期+店铺”出现重复。` : "日期+店铺主键没有重复。",
  });

  const summaryProducts = products.filter((product) => product.isSummary);
  const productProfitTotal = amountSum(summaryProducts.map((product) => product.actualProfit));
  const pivotSheetName = workbook.SheetNames.find((name) => name.replace(/\s+/g, "").includes("数据透视表-提取刷单"));
  const pivotSheet = pivotSheetName ? workbook.Sheets[pivotSheetName] : undefined;
  const pivotRows = pivotSheet ? XLSX.utils.sheet_to_json<unknown[]>(pivotSheet, { header: 1, defval: null, raw: true }) : [];
  const profitHeaderRow = pivotRows.findIndex((row) => row.some((cell) => {
    const header = String(cell ?? "").replace(/\s+/g, "").replace(/[（]/g, "(").replace(/[）]/g, ")");
    return header.includes("厂家退货款") && header.includes("利润");
  }));
  const profitColumn = profitHeaderRow >= 0
    ? pivotRows[profitHeaderRow].findIndex((cell) => {
      const header = String(cell ?? "").replace(/\s+/g, "").replace(/[（]/g, "(").replace(/[）]/g, ")");
      return header.includes("厂家退货款") && header.includes("利润");
    })
    : -1;
  const profitTotalAddress = profitColumn >= 0 && profitHeaderRow > 0
    ? XLSX.utils.encode_cell({ r: profitHeaderRow - 1, c: profitColumn })
    : "";
  const cachedProductProfitTotal = Number((profitTotalAddress && pivotSheet?.[profitTotalAddress]?.v) || 0);
  const profitDifference = amountSum([cachedProductProfitTotal, -productProfitTotal]);
  const grandTotalRow = (() => {
    if (!pivotSheet?.["!ref"]) return null;
    const range = XLSX.utils.decode_range(pivotSheet["!ref"]);
    for (let row = range.s.r; row <= range.e.r; row += 1) if (String(pivotSheet[`A${row + 1}`]?.v || "").trim() === "总计") return row + 1;
    return null;
  })();
  reconciliations.push({
    checkKey: "product_profit_subtotal",
    category: "product",
    status: Math.abs(profitDifference) <= 0.01 ? "pass" : "warning",
    label: "商品利润总计",
    expectedValue: productProfitTotal,
    actualValue: cachedProductProfitTotal,
    difference: profitDifference,
    tolerance: 0.01,
    message: Math.abs(profitDifference) <= 0.01
      ? "利润表头对应单元格与逐商品周期小计一致。"
      : `利润表头对应汇总单元格与逐商品周期小计不一致${grandTotalRow ? `（第 ${grandTotalRow} 行含“总计”）` : ""}；正式商品利润改用逐商品汇总。`,
  });

  const costCoverage = summaryProducts.length ? summaryProducts.filter((product) => product.cost !== null && product.cost > 0).length / summaryProducts.length : 0;
  reconciliations.push({
    checkKey: "product_cost_coverage",
    category: "mapping",
    status: costCoverage >= 0.99 ? "pass" : "warning",
    label: "商品成本覆盖率",
    expectedValue: 1,
    actualValue: costCoverage,
    difference: 1 - costCoverage,
    tolerance: 0.01,
    message: `商品周期小计成本覆盖率为 ${(costCoverage * 100).toFixed(2)}%；缺成本商品单独标记，不影响其他商品使用 Excel 原表数据。`,
  });

  const formulaCount = sheets.reduce((total, sheet) => total + sheet.formulaCount, 0);
  const reconciliationStatus: WorkbookAuditResult["reconciliationStatus"] = reconciliations.some((item) => item.status === "fail") ? "fail" : reconciliations.some((item) => item.status === "warning") ? "warning" : "pass";
  return { sheets, formulas, reconciliations, formulaCount, formulaErrorCount, fixedRangeRiskCount, reconciliationStatus, productProfitTotal, cachedProductProfitTotal };
}
