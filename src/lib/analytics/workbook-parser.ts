import * as XLSX from "xlsx";
import { auditProfitWorkbook, type WorkbookFormulaAudit, type WorkbookReconciliation, type WorkbookSheetAudit } from "@/lib/analytics/workbook-audit";

export type ParsedStoreDaily = {
  metricDate: string;
  storeName: string;
  businessOwner: string | null;
  gmv: number;
  productCost: number;
  preShipRefundAmount: number;
  totalRefundAmount: number;
  postShipRefundAmount: number;
  postShipRefundOrders: number;
  returnShippingCost: number;
  serviceFee: number;
  oneHourRefundAmount: number;
  compensationRegistered: number;
  compensationSpend: number;
  adSpend: number;
  actualProfit: number;
  compensationProfit: number;
  fakeOrders: number;
  paidOrders: number;
  profitMargin: number;
  compensationRoi: number;
  overallRefundRate: number;
  oneHourRefundRate: number;
  preShipRefundRate: number;
  postShipRefundRate: number;
  gmvGap: number;
};

export type ParsedProductMetric = {
  storeProductKey: string;
  metricDate: string | null;
  isSummary: boolean;
  businessOwner: string | null;
  storeName: string;
  productId: string;
  planId: string | null;
  productName: string;
  categoryName: string;
  submittedOrders: number;
  oneHourRefundOrders: number;
  paidOrders: number;
  preShipRefundOrders: number;
  shippedOrders: number;
  pendingOrders: number;
  postShipRefundOrders: number;
  fakeOrders: number;
  price: number | null;
  cost: number | null;
  nonFakeOrders: number;
  gmv: number;
  adSpend: number;
  compensation: number;
  roi: number;
  compensationRoi: number;
  profitMargin: number;
  netDealRoi: number;
  actualProfit: number;
  profitAvailable: boolean;
  oneHourRefundRate: number;
  netShippingRate: number;
  overallShippingRate: number;
  signRate: number;
};

export type ParsedProductRegistry = {
  storeProductKey: string;
  storeName: string;
  productId: string;
  productName: string;
  categoryName: string;
  planId: string | null;
};

export type ParsedPlanDaily = {
  metricDate: string;
  buildDate: string | null;
  planId: string;
  planName: string;
  accountId: string;
  accountShortName: string;
  accountName: string;
  storeName: string;
  productId: string;
  productName: string;
  price: number | null;
  targetRoi: number;
  spend: number;
  netOrders: number;
  netAmount: number;
  netRoi: number;
  compensation: number;
  latestStatus: string;
  effectiveOrders: number;
  brushLike: boolean;
  roiHit: boolean;
  lowOrderStop: boolean;
};

export type ParsedPlanAnalysis = {
  rows: ParsedPlanDaily[];
  accounts: Array<{ accountId: string; accountShortName: string; accountName: string }>;
  periodStart: string | null;
  periodEnd: string | null;
  accountCount: number;
  planCount: number;
};

export type ParsedAnalyticsIssue = {
  severity: "info" | "warning" | "critical";
  issueType: string;
  scope: "import" | "store" | "product";
  entityKey: string | null;
  message: string;
};

export type ParsedAnalyticsWorkbook = {
  periodStart: string | null;
  periodEnd: string | null;
  productPeriodStart: string | null;
  productPeriodEnd: string | null;
  productProfitTotal: number;
  cachedProductProfitTotal: number;
  reconciliationStatus: "pass" | "warning" | "fail";
  formulaCount: number;
  formulaErrorCount: number;
  fixedRangeRiskCount: number;
  stores: ParsedStoreDaily[];
  products: ParsedProductMetric[];
  productRegistry: ParsedProductRegistry[];
  planAnalysis: ParsedPlanAnalysis;
  sourceRebuild: {
    available: boolean;
    verified: boolean;
    authoritative: boolean;
    summaryCount: number;
    pivotSummaryCount: number;
    mismatchCount: number;
    samples: Array<{ storeName: string; productId: string; fields: string[] }>;
    acceptedVariances: Array<{ storeName: string; productId: string; fields: string[] }>;
    unmatchedPivotProducts: Array<{ storeName: string; productId: string; productName: string }>;
    ignoredUnregisteredSourceRows: number;
  };
  issues: ParsedAnalyticsIssue[];
  sheetAudits: WorkbookSheetAudit[];
  formulaAudits: WorkbookFormulaAudit[];
  reconciliations: WorkbookReconciliation[];
  sourceOrderRows: number;
  sourceOrderLastRow: number;
  sourceSpendRows: number;
  sourceSpendLastRow: number;
  storeCount: number;
  productCount: number;
  registeredProductCount: number;
};

type Row = unknown[];

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
    .toLowerCase();
}

function findHeaderRow(rows: Row[], required: string[]) {
  return rows.findIndex((row) => {
    const cells = row.map(normalizeHeader);
    return required.every((needle) => cells.some((cell) => cell.includes(normalizeHeader(needle))));
  });
}

function findColumn(headers: Row, predicate: (header: string) => boolean, fallback = -1) {
  const index = headers.map(normalizeHeader).findIndex(predicate);
  return index >= 0 ? index : fallback;
}

function rawAt(row: Row, index: number) {
  return index >= 0 ? row[index] : null;
}

export function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/,/g, "").trim();
  if (!clean) return fallback;
  if (clean.endsWith("%")) {
    const percent = Number(clean.slice(0, -1));
    return Number.isFinite(percent) ? percent / 100 : fallback;
  }
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = numberValue(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeCategoryName(value: unknown) {
  const normalized = textValue(value)
    .replace(/[－—–]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "未登记类目";
}

type ProductMappings = {
  categories: Map<string, string>;
  plans: Map<string, string>;
  registry: Map<string, ParsedProductRegistry>;
  productNames: Map<string, string>;
  productPrices: Map<string, number | null>;
  storeProductPrices: Map<string, number | null>;
  accounts: Map<string, { shortName: string; accountName: string }>;
};

function mappingKey(storeName: string, productId: string) {
  return `${storeName.trim()}::${productId.trim()}`;
}

function buildProductMappings(
  workbook: XLSX.WorkBook,
  storeNames: string[],
  productPeriodStart: string | null,
  productPeriodEnd: string | null,
): ProductMappings {
  const categories = new Map<string, string>();
  const plans = new Map<string, string>();
  const registry = new Map<string, ParsedProductRegistry>();
  const productNames = new Map<string, string>();
  const productPrices = new Map<string, number | null>();
  const storeProductPrices = new Map<string, number | null>();
  const accounts = new Map<string, { shortName: string; accountName: string }>();
  const currentStoreNames = new Set(storeNames);
  const planCandidates = new Map<string, Array<{ planId: string; metricDate: string | null; rowIndex: number }>>();
  const categorySheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("产品类目登记"));
  if (categorySheetName) {
    const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[categorySheetName], { header: 1, defval: null, raw: true });
    const headerRow = findHeaderRow(rows, ["店铺", "商品ID", "产品名称"]);
    if (headerRow >= 0) {
      const headers = rows[headerRow];
      const storeColumn = findColumn(headers, (header) => header === normalizeHeader("店铺"));
      const productColumn = findColumn(headers, (header) => header === normalizeHeader("商品ID"));
      const nameColumn = findColumn(headers, (header) => header === normalizeHeader("产品名称"));
      const priceColumn = findColumn(headers, (header) => header === normalizeHeader("价格"));
      for (const row of rows.slice(headerRow + 1)) {
        const storeName = textValue(rawAt(row, storeColumn));
        const productId = textValue(rawAt(row, productColumn));
        if (!storeName || !productId || !currentStoreNames.has(storeName)) continue;
        const key = mappingKey(storeName, productId);
        const productName = normalizeCategoryName(rawAt(row, nameColumn));
        const price = nullableNumber(rawAt(row, priceColumn));
        categories.set(key, productName);
        productNames.set(productId, productNames.get(productId) ?? productName);
        productPrices.set(productId, price);
        storeProductPrices.set(key, price);
        registry.set(key, {
          storeProductKey: key,
          storeName,
          productId,
          productName,
          categoryName: productName,
          planId: null,
        });
      }
    }
  }

  const accountSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("千川账户对照"));
  if (accountSheetName) {
    const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[accountSheetName], { header: 1, defval: null, raw: true });
    const headerRow = findHeaderRow(rows, ["账户ID", "店铺", "账户名称"]);
    if (headerRow >= 0) {
      const headers = rows[headerRow];
      const accountIdColumn = findColumn(headers, (header) => header === normalizeHeader("账户ID"));
      const shortNameColumn = findColumn(headers, (header) => header === normalizeHeader("店铺"));
      const accountNameColumn = findColumn(headers, (header) => header === normalizeHeader("账户名称"));
      for (const row of rows.slice(headerRow + 1)) {
        const accountId = textValue(rawAt(row, accountIdColumn));
        if (!accountId) continue;
        accounts.set(accountId, { shortName: textValue(rawAt(row, shortNameColumn)), accountName: textValue(rawAt(row, accountNameColumn)) });
      }
    }
  }

  const spendSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("千川计划消耗-全域"));
  if (spendSheetName) {
    const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[spendSheetName], { header: 1, defval: null, raw: true });
    const headerRow = findHeaderRow(rows, ["计划ID", "商品ID", "店铺"]);
    if (headerRow >= 0) {
      const headers = rows[headerRow];
      const planColumn = findColumn(headers, (header) => header === normalizeHeader("计划ID"));
      const productColumn = findColumn(headers, (header) => header.includes(normalizeHeader("商品ID")));
      const storeColumn = findColumn(headers, (header) => header === normalizeHeader("店铺"), 17);
      const dateColumn = findColumn(headers, (header) => header === normalizeHeader("消耗日期"), 0);
      for (const [offset, row] of rows.slice(headerRow + 1).entries()) {
        const storeName = textValue(rawAt(row, storeColumn));
        const productId = textValue(rawAt(row, productColumn));
        const planId = textValue(rawAt(row, planColumn));
        if (!storeName || !productId || !planId || !currentStoreNames.has(storeName)) continue;
        const key = mappingKey(storeName, productId);
        planCandidates.set(key, [...(planCandidates.get(key) ?? []), { planId, metricDate: dateValue(rawAt(row, dateColumn)), rowIndex: headerRow + 1 + offset }]);
      }
    }
  }
  for (const [key, candidates] of planCandidates) {
    const inProductPeriod = candidates.filter((candidate) => candidate.metricDate
      && (!productPeriodStart || candidate.metricDate >= productPeriodStart)
      && (!productPeriodEnd || candidate.metricDate <= productPeriodEnd));
    const preferred = (inProductPeriod.length ? inProductPeriod : candidates)
      .sort((left, right) => (right.metricDate ?? "").localeCompare(left.metricDate ?? "") || right.rowIndex - left.rowIndex)[0];
    if (preferred) {
      plans.set(key, preferred.planId);
      const registered = registry.get(key);
      if (registered) registered.planId = preferred.planId;
    }
  }

  const productDailySheetName = workbook.SheetNames.find((name) => normalizeHeader(name).includes(normalizeHeader("商品每日数据汇总- 提取刷单")));
  if (productDailySheetName) {
    const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[productDailySheetName], { header: 1, defval: null, raw: true });
    const headerRow = findHeaderRow(rows, ["日期", "店铺+商品ID", "售价"]);
    if (headerRow >= 0) {
      const headers = rows[headerRow];
      const keyColumn = findColumn(headers, (header) => header === normalizeHeader("店铺+商品ID"));
      const priceColumn = findColumn(headers, (header) => header === normalizeHeader("售价"));
      const dateColumn = findColumn(headers, (header) => header === normalizeHeader("日期"));
      const prices = new Map<string, { date: string; price: number }>();
      for (const row of rows.slice(headerRow + 1)) {
        const date = dateValue(rawAt(row, dateColumn));
        const key = textValue(rawAt(row, keyColumn));
        const price = nullableNumber(rawAt(row, priceColumn));
        if (!date || !key || price === null || price <= 0) continue;
        const identity = splitStoreProductKey(key, storeNames);
        if (!identity.productId) continue;
        const storeProduct = mappingKey(identity.storeName, identity.productId);
        const current = prices.get(storeProduct);
        if (!current || date >= current.date) prices.set(storeProduct, { date, price });
      }
      for (const [key, value] of prices) {
        if (storeProductPrices.get(key) === null || storeProductPrices.get(key) === undefined) storeProductPrices.set(key, value.price);
      }
    }
  }
  return { categories, plans, registry, productNames, productPrices, storeProductPrices, accounts };
}

function planBuildDate(planName: string) {
  const match = planName.match(/(20\d{2})[-_/](\d{1,2})[-_/](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parsePlanAnalysis(workbook: XLSX.WorkBook, mappings: ProductMappings): ParsedPlanAnalysis {
  const sheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("千川计划消耗-全域"));
  if (!sheetName) return { rows: [], accounts: [...mappings.accounts].map(([accountId, account]) => ({ accountId, accountShortName: account.shortName, accountName: account.accountName })), periodStart: null, periodEnd: null, accountCount: 0, planCount: 0 };
  const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const headerRow = findHeaderRow(rows, ["消耗日期", "计划ID", "账户ID", "消耗"]);
  if (headerRow < 0) return { rows: [], accounts: [...mappings.accounts].map(([accountId, account]) => ({ accountId, accountShortName: account.shortName, accountName: account.accountName })), periodStart: null, periodEnd: null, accountCount: 0, planCount: 0 };
  const headers = rows[headerRow];
  const col = {
    metricDate: findColumn(headers, (header) => header === normalizeHeader("消耗日期")),
    planName: findColumn(headers, (header) => header === normalizeHeader("计划名称")),
    planId: findColumn(headers, (header) => header === normalizeHeader("计划ID")),
    accountId: findColumn(headers, (header) => header === normalizeHeader("账户ID")),
    accountName: findColumn(headers, (header) => header === normalizeHeader("账户")),
    storeName: findColumn(headers, (header) => header === normalizeHeader("店铺")),
    productId: findColumn(headers, (header) => header.includes(normalizeHeader("商品ID"))),
    targetRoi: findColumn(headers, (header) => header === normalizeHeader("整体支付ROI目标")),
    spend: findColumn(headers, (header) => header === normalizeHeader("消耗")),
    netOrders: findColumn(headers, (header) => header === normalizeHeader("净成交订单数")),
    netAmount: findColumn(headers, (header) => header === normalizeHeader("净成交金额")),
    netRoi: findColumn(headers, (header) => header === normalizeHeader("净成交ROI")),
    latestStatus: findColumn(headers, (header) => header === normalizeHeader("计划最新状态")),
    compensation: findColumn(headers, (header) => header === normalizeHeader("赔付金额")),
  };
  const parsed: ParsedPlanDaily[] = [];
  for (const row of rows.slice(headerRow + 1)) {
    const planId = textValue(rawAt(row, col.planId));
    const metricDate = dateValue(rawAt(row, col.metricDate));
    if (!planId || !metricDate) continue;
    const planName = textValue(rawAt(row, col.planName));
    const accountId = textValue(rawAt(row, col.accountId));
    const account = mappings.accounts.get(accountId);
    const productId = textValue(rawAt(row, col.productId));
    const storeName = textValue(rawAt(row, col.storeName));
    const targetRoi = numberValue(rawAt(row, col.targetRoi));
    const spend = numberValue(rawAt(row, col.spend));
    const netOrders = numberValue(rawAt(row, col.netOrders));
    const netAmount = numberValue(rawAt(row, col.netAmount));
    const averageNetAmount = netOrders > 0 ? netAmount / netOrders : 0;
    const effectiveOrders = netAmount > 5 && averageNetAmount > 5 ? netOrders : 0;
    parsed.push({
      metricDate,
      buildDate: planBuildDate(planName),
      planId,
      planName,
      accountId,
      accountShortName: account?.shortName ?? textValue(rawAt(row, col.accountName)),
      accountName: account?.accountName ?? textValue(rawAt(row, col.accountName)),
      storeName,
      productId,
      productName: mappings.categories.get(mappingKey(storeName, productId)) ?? mappings.productNames.get(productId) ?? (productId || "未识别商品"),
      price: mappings.storeProductPrices.get(mappingKey(storeName, productId)) ?? mappings.productPrices.get(productId) ?? null,
      targetRoi,
      spend,
      netOrders,
      netAmount,
      netRoi: numberValue(rawAt(row, col.netRoi)),
      compensation: numberValue(rawAt(row, col.compensation)),
      latestStatus: textValue(rawAt(row, col.latestStatus)),
      effectiveOrders,
      brushLike: netOrders > 0 && (netAmount <= 5 || averageNetAmount <= 5),
      roiHit: targetRoi > 0 && effectiveOrders > 0 && numberValue(rawAt(row, col.netRoi)) >= targetRoi,
      lowOrderStop: spend >= 150 && spend <= 300 && effectiveOrders < 2,
    });
  }
  const dates = parsed.map((row) => row.metricDate).sort();
  return {
    rows: parsed,
    accounts: [...mappings.accounts].map(([accountId, account]) => ({ accountId, accountShortName: account.shortName, accountName: account.accountName })),
    periodStart: dates[0] ?? null,
    periodEnd: dates.at(-1) ?? null,
    accountCount: new Set(parsed.map((row) => row.accountId).filter(Boolean)).size,
    planCount: new Set(parsed.map((row) => row.planId)).size,
  };
}

export function dateValue(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed && parsed.y >= 1900 && parsed.m >= 1 && parsed.d >= 1) return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function parseStoreRows(rows: Row[]) {
  const headerRow = findHeaderRow(rows, ["日期", "店铺", "营业额", "总消耗"]);
  if (headerRow < 0) throw new Error("店铺每日数据汇总缺少日期、店铺、营业额或总消耗字段");
  const headers = rows[headerRow];
  const exact = (name: string) => findColumn(headers, (header) => header === normalizeHeader(name));
  const includes = (name: string) => findColumn(headers, (header) => header.includes(normalizeHeader(name)));
  const firstProfit = findColumn(headers, (header) => header.includes("利润") && header.includes("赔付登记"));
  const compensationProfit = findColumn(headers, (header) => header.includes("利润") && header.includes("赔付消耗"));
  const firstProfitMargin = findColumn(headers, (header) => header.includes("利润率") && header.includes("赔付登记"));
  const columns = {
    date: findColumn(headers, (header) => header === normalizeHeader("日期") || header.includes(normalizeHeader("日期"))),
    store: findColumn(headers, (header) => header === normalizeHeader("店铺") || header.includes(normalizeHeader("店铺"))),
    owner: exact("归属人"),
    gmv: findColumn(headers, (header) => header === normalizeHeader("营业额") || header.includes(normalizeHeader("营业额"))),
    productCost: exact("货款"),
    preShipRefund: includes("退款(未发货)"),
    totalRefund: includes("订单总退款"),
    postShipRefund: findColumn(headers, (header) => header.includes("发货后") && header.includes("退款成功") && header.includes("退货货款")),
    postShipRefundOrders: includes("发货后退款订单数"),
    returnShipping: includes("退货快递费用"),
    serviceFee: includes("服务费5%"),
    oneHourRefund: includes("1h退款金额"),
    compensationRegistered: exact("赔付登记"),
    compensationSpend: includes("赔付消耗"),
    adSpend: includes("总消耗(维护"),
    actualProfit: firstProfit,
    compensationProfit,
    fakeOrders: includes("刷单订单数"),
    paidOrders: includes("总支付订单数"),
    profitMargin: firstProfitMargin,
    compensationRoi: includes("赔付后roi"),
    overallRefundRate: includes("整体退款率"),
    oneHourRefundRate: includes("1h内退款率"),
    preShipRefundRate: includes("发货前退款率"),
    postShipRefundRate: includes("发货后退款率"),
    gmvGap: includes("千川-店铺gmv差"),
  };
  if (Object.entries(columns).some(([key, value]) => ["date", "store", "gmv", "adSpend", "actualProfit"].includes(key) && value < 0)) {
    const missing = Object.entries(columns).filter(([key, value]) => ["date", "store", "gmv", "adSpend", "actualProfit"].includes(key) && value < 0).map(([key]) => key);
    throw new Error(`店铺每日数据汇总缺少关键经营字段：${missing.join("、")}（表头行 ${headerRow + 1}）`);
  }

  return rows.slice(headerRow + 1).flatMap<ParsedStoreDaily>((row) => {
    const metricDate = dateValue(rawAt(row, columns.date));
    const storeName = String(rawAt(row, columns.store) ?? "").trim();
    if (!metricDate || !storeName || /总计|合计/.test(storeName)) return [];
    return [{
      metricDate,
      storeName,
      businessOwner: String(rawAt(row, columns.owner) ?? "").trim() || null,
      gmv: numberValue(rawAt(row, columns.gmv)),
      productCost: numberValue(rawAt(row, columns.productCost)),
      preShipRefundAmount: numberValue(rawAt(row, columns.preShipRefund)),
      totalRefundAmount: numberValue(rawAt(row, columns.totalRefund)),
      postShipRefundAmount: numberValue(rawAt(row, columns.postShipRefund)),
      postShipRefundOrders: numberValue(rawAt(row, columns.postShipRefundOrders)),
      returnShippingCost: numberValue(rawAt(row, columns.returnShipping)),
      serviceFee: numberValue(rawAt(row, columns.serviceFee)),
      oneHourRefundAmount: numberValue(rawAt(row, columns.oneHourRefund)),
      compensationRegistered: numberValue(rawAt(row, columns.compensationRegistered)),
      compensationSpend: numberValue(rawAt(row, columns.compensationSpend)),
      adSpend: numberValue(rawAt(row, columns.adSpend)),
      actualProfit: nullableNumber(rawAt(row, columns.actualProfit)) ?? 0,
      compensationProfit: numberValue(rawAt(row, columns.compensationProfit)),
      fakeOrders: numberValue(rawAt(row, columns.fakeOrders)),
      paidOrders: numberValue(rawAt(row, columns.paidOrders)),
      profitMargin: numberValue(rawAt(row, columns.profitMargin)),
      compensationRoi: numberValue(rawAt(row, columns.compensationRoi)),
      overallRefundRate: numberValue(rawAt(row, columns.overallRefundRate)),
      oneHourRefundRate: numberValue(rawAt(row, columns.oneHourRefundRate)),
      preShipRefundRate: numberValue(rawAt(row, columns.preShipRefundRate)),
      postShipRefundRate: numberValue(rawAt(row, columns.postShipRefundRate)),
      gmvGap: numberValue(rawAt(row, columns.gmvGap)),
    }];
  });
}

function splitStoreProductKey(key: string, storeNames: string[]) {
  const plusIndex = key.indexOf("+");
  const businessOwner = plusIndex >= 0 ? key.slice(0, plusIndex).trim() || null : null;
  const body = plusIndex >= 0 ? key.slice(plusIndex + 1) : key;
  const productIdMatch = body.match(/(\d{12,})/);
  const productId = productIdMatch?.[1] ?? "";
  const productIndex = productIdMatch?.index ?? body.length;
  const beforeId = body.slice(0, productIndex).trim();
  const storeName = ([...storeNames].sort((a, b) => b.length - a.length).find((name) => beforeId.includes(name)) ?? beforeId) || "未识别店铺";
  const productName = productId ? body.slice(productIndex + productId.length).replace(/^[-_\s]+/, "").trim() : "";
  return { businessOwner, storeName, productId, productName: productName || productId || "未识别商品" };
}

function parseProductRows(rows: Row[], storeNames: string[], mappings: ProductMappings) {
  const headerRow = findHeaderRow(rows, ["店铺+商品ID", "厂家退货款", "净成交roi"]);
  if (headerRow < 0) throw new Error("数据透视表-提取刷单缺少商品主键、商品真实利润或净成交 ROI 字段");
  const headers = rows[headerRow];
  const find = (needle: string, reject?: string) => findColumn(headers, (header) => header.includes(normalizeHeader(needle)) && (!reject || !header.includes(normalizeHeader(reject))));
  const exact = (needle: string) => findColumn(headers, (header) => header === normalizeHeader(needle));
  const columns = {
    key: exact("店铺+商品ID"),
    date: exact("日期"),
    submittedOrders: find("总提交订单数"),
    oneHourRefundOrders: find("1h退款订单总数"),
    paidOrders: find("总支付订单"),
    preShipRefundOrders: find("未发货仅退款", "刷单"),
    shippedOrders: find("已发货(发货时间非空)", "刷单"),
    pendingOrders: find("待发货", "刷单"),
    postShipRefundOrders: find("发货后退款", "刷单"),
    fakeOrders: find("(刷单)订单数"),
    price: find("售价"),
    cost: find("成本"),
    nonFakeOrders: find("剔除刷单)订单数"),
    gmv: find("(含刷单)成交金额"),
    adSpend: exact("求和项:消耗"),
    compensation: exact("求和项:赔付"),
    roi: find("roi(千川)"),
    compensationRoi: find("roi(抵扣赔付)"),
    profitMargin: exact("利润率"),
    netDealRoi: find("净成交roi"),
    actualProfit: find("厂家退货款利润(当下签收-含赔付)"),
    oneHourRefundRate: find("1h内订单退款率"),
    netShippingRate: find("净成交发货率"),
    overallShippingRate: find("整体发货率"),
    signRate: find("签收率"),
  };
  if (columns.key < 0 || columns.actualProfit < 0) {
    throw new Error("商品真实利润列校验失败：未找到“厂家退货款利润（当下签收-含赔付）”字段");
  }

  return rows.slice(headerRow + 1).flatMap<ParsedProductMetric>((row) => {
    const storeProductKey = String(rawAt(row, columns.key) ?? "").trim();
    if (!storeProductKey || /总计|合计/.test(storeProductKey)) return [];
    const identity = splitStoreProductKey(storeProductKey, storeNames);
    if (!identity.productId) return [];
    const key = mappingKey(identity.storeName, identity.productId);
    const categoryName = mappings.categories.get(key) ?? normalizeCategoryName(identity.productName);
    const metricDate = dateValue(rawAt(row, columns.date));
    const parsedProfit = nullableNumber(rawAt(row, columns.actualProfit));
    return [{
      storeProductKey,
      metricDate,
      isSummary: !metricDate,
      businessOwner: identity.businessOwner,
      storeName: identity.storeName,
      productId: identity.productId,
      planId: mappings.plans.get(key) ?? null,
      productName: categoryName,
      categoryName,
      submittedOrders: numberValue(rawAt(row, columns.submittedOrders)),
      oneHourRefundOrders: numberValue(rawAt(row, columns.oneHourRefundOrders)),
      paidOrders: numberValue(rawAt(row, columns.paidOrders)),
      preShipRefundOrders: numberValue(rawAt(row, columns.preShipRefundOrders)),
      shippedOrders: numberValue(rawAt(row, columns.shippedOrders)),
      pendingOrders: numberValue(rawAt(row, columns.pendingOrders)),
      postShipRefundOrders: numberValue(rawAt(row, columns.postShipRefundOrders)),
      fakeOrders: numberValue(rawAt(row, columns.fakeOrders)),
      price: nullableNumber(rawAt(row, columns.price)),
      cost: nullableNumber(rawAt(row, columns.cost)),
      nonFakeOrders: numberValue(rawAt(row, columns.nonFakeOrders)),
      gmv: numberValue(rawAt(row, columns.gmv)),
      adSpend: numberValue(rawAt(row, columns.adSpend)),
      compensation: numberValue(rawAt(row, columns.compensation)),
      roi: numberValue(rawAt(row, columns.roi)),
      compensationRoi: numberValue(rawAt(row, columns.compensationRoi)),
      profitMargin: numberValue(rawAt(row, columns.profitMargin)),
      netDealRoi: numberValue(rawAt(row, columns.netDealRoi)),
      actualProfit: parsedProfit ?? 0,
      profitAvailable: parsedProfit !== null,
      oneHourRefundRate: numberValue(rawAt(row, columns.oneHourRefundRate)),
      netShippingRate: numberValue(rawAt(row, columns.netShippingRate)),
      overallShippingRate: numberValue(rawAt(row, columns.overallShippingRate)),
      signRate: numberValue(rawAt(row, columns.signRate)),
    }];
  });
}

function productDateRange(rows: Row[]) {
  const headerRow = findHeaderRow(rows, ["店铺+商品ID", "日期"]);
  if (headerRow < 0) return { start: null, end: null };
  const dateColumn = findColumn(rows[headerRow], (header) => header === normalizeHeader("日期"));
  const dates = rows.slice(headerRow + 1).flatMap((row) => {
    const parsed = dateValue(rawAt(row, dateColumn));
    return parsed ? [parsed] : [];
  }).sort();
  return { start: dates[0] ?? null, end: dates.at(-1) ?? null };
}

type SourceProductFact = {
  metricDate: string;
  storeName: string;
  productId: string;
  planId: string | null;
  submittedOrders: number;
  oneHourRefundOrders: number;
  paidOrders: number;
  preShipRefundOrders: number;
  shippedOrders: number;
  pendingOrders: number;
  postShipRefundOrders: number;
  fakeOrders: number;
  price: number | null;
  cost: number | null;
  gmv: number;
  adSpend: number;
  compensation: number;
};

function normalizedId(value: unknown) {
  return textValue(value).replace(/^['\t]+/, "").replace(/\.0$/, "");
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string) {
  const sheet = workbook.Sheets[sheetName];
  return sheet ? XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, defval: null, raw: true }) : [];
}

function sourceColumn(headers: Row, name: string, fallback = -1) {
  return findColumn(headers, (header) => header === normalizeHeader(name), fallback);
}

function calculateMetric(input: SourceProductFact, businessOwner: string | null, categoryName: string): ParsedProductMetric {
  const nonFakeOrders = Math.max(0, input.paidOrders - input.fakeOrders);
  const averageOrderAmount = input.paidOrders > 0 ? input.gmv / input.paidOrders : 0;
  const effectiveGmv = nonFakeOrders > 0 && input.gmv > 5 && averageOrderAmount > 5
    ? input.gmv * (nonFakeOrders / input.paidOrders)
    : 0;
  // 刷单按已确认规则统一视为未发货退款，其他刷单状态恒为零。
  const fakePreShipRefundOrders = input.fakeOrders;
  const oneHourRefundRate = nonFakeOrders > 0 ? input.oneHourRefundOrders / nonFakeOrders : 0;
  const netShippingRate = nonFakeOrders > input.oneHourRefundOrders
    ? (input.paidOrders - input.preShipRefundOrders) / (nonFakeOrders - input.oneHourRefundOrders)
    : 0;
  const overallShippingRate = nonFakeOrders > 0
    ? 1 - (input.preShipRefundOrders - fakePreShipRefundOrders) / nonFakeOrders
    : 0;
  const signRateDenominator = input.shippedOrders + input.pendingOrders;
  const signRate = signRateDenominator > 0 ? 1 - input.postShipRefundOrders / signRateDenominator : 0;
  const totalSignedRate = overallShippingRate * signRate;
  const actualSales = input.gmv * totalSignedRate;
  const platformFee = actualSales * 0.05;
  const productCost = input.cost === null ? 0 : (input.shippedOrders - input.postShipRefundOrders + input.pendingOrders) * input.cost + input.postShipRefundOrders * 5;
  const actualProfit = input.cost === null ? 0 : actualSales - input.adSpend - productCost - platformFee + input.compensation;
  return {
    storeProductKey: `${businessOwner ? `${businessOwner}+` : ""}${input.storeName}${input.productId}-${categoryName}`,
    metricDate: input.metricDate,
    isSummary: false,
    businessOwner,
    storeName: input.storeName,
    productId: input.productId,
    planId: input.planId,
    productName: categoryName,
    categoryName,
    submittedOrders: input.submittedOrders,
    oneHourRefundOrders: input.oneHourRefundOrders,
    paidOrders: input.paidOrders,
    preShipRefundOrders: input.preShipRefundOrders,
    shippedOrders: input.shippedOrders,
    pendingOrders: input.pendingOrders,
    postShipRefundOrders: input.postShipRefundOrders,
    fakeOrders: input.fakeOrders,
    price: input.price,
    cost: input.cost,
    nonFakeOrders,
    gmv: input.gmv,
    adSpend: input.adSpend,
    compensation: input.compensation,
    roi: input.adSpend > 0 ? input.gmv / input.adSpend : 0,
    compensationRoi: input.adSpend > input.compensation ? input.gmv / (input.adSpend - input.compensation) : 0,
    profitMargin: input.cost === null ? 0 : input.gmv > 0 ? actualProfit / input.gmv : 0,
    netDealRoi: input.adSpend > input.compensation ? effectiveGmv * (1 - oneHourRefundRate) / (input.adSpend - input.compensation) : 0,
    actualProfit,
    profitAvailable: input.cost !== null,
    oneHourRefundRate,
    netShippingRate,
    overallShippingRate,
    signRate,
  };
}

function aggregateSourceMetrics(rows: ParsedProductMetric[]): ParsedProductMetric[] {
  const groups = new Map<string, ParsedProductMetric[]>();
  for (const row of rows) groups.set(row.storeProductKey, [...(groups.get(row.storeProductKey) ?? []), row]);
  return [...groups.values()].map((items) => {
    const first = items[0];
    const base: SourceProductFact = {
      metricDate: "",
      storeName: first.storeName,
      productId: first.productId,
      planId: first.planId,
      submittedOrders: items.reduce((total, row) => total + row.submittedOrders, 0),
      oneHourRefundOrders: items.reduce((total, row) => total + row.oneHourRefundOrders, 0),
      paidOrders: items.reduce((total, row) => total + row.paidOrders, 0),
      preShipRefundOrders: items.reduce((total, row) => total + row.preShipRefundOrders, 0),
      shippedOrders: items.reduce((total, row) => total + row.shippedOrders, 0),
      pendingOrders: items.reduce((total, row) => total + row.pendingOrders, 0),
      postShipRefundOrders: items.reduce((total, row) => total + row.postShipRefundOrders, 0),
      fakeOrders: items.reduce((total, row) => total + row.fakeOrders, 0),
      price: items.reduce<number | null>((current, row) => Math.max(current ?? 0, row.price ?? 0) || null, null),
      cost: items.find((row) => row.cost !== null)?.cost ?? null,
      gmv: items.reduce((total, row) => total + row.gmv, 0),
      adSpend: items.reduce((total, row) => total + row.adSpend, 0),
      compensation: items.reduce((total, row) => total + row.compensation, 0),
    };
    const summary = calculateMetric(base, first.businessOwner, first.categoryName);
    const profitAvailable = items.every((row) => row.profitAvailable);
    const actualProfit = profitAvailable ? items.reduce((total, row) => total + row.actualProfit, 0) : 0;
    return {
      ...summary,
      metricDate: null,
      isSummary: true,
      actualProfit,
      profitAvailable,
      profitMargin: profitAvailable && base.gmv > 0 ? actualProfit / base.gmv : 0,
    };
  });
}

function parseSourceProductRows(
  workbook: XLSX.WorkBook,
  storeNames: string[],
  stores: ParsedStoreDaily[],
  mappings: ProductMappings,
  pivotProducts: ParsedProductMetric[],
) {
  const orderSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("订单明细修改"));
  const afterSaleSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("售后工作台"));
  const costSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("产品成本"));
  const spendSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("千川计划消耗-全域"));
  const compensationSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("赔付金额"));
  if (!orderSheetName || !afterSaleSheetName || !costSheetName || !spendSheetName || !compensationSheetName) return null;

  const currentStores = new Set(storeNames);
  const storeDates = stores.map((row) => row.metricDate).sort();
  const sourcePeriod = { start: storeDates[0] ?? null, end: storeDates.at(-1) ?? null };
  const ownerByStore = new Map<string, string | null>();
  for (const row of stores) if (!ownerByStore.has(row.storeName)) ownerByStore.set(row.storeName, row.businessOwner);
  const registrationCosts = new Map<string, number>();
  const categorySheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("产品类目登记"));
  if (categorySheetName) {
    const categoryRows = sheetRows(workbook, categorySheetName);
    const categoryHeaderRow = findHeaderRow(categoryRows, ["店铺", "商品ID", "成本"]);
    if (categoryHeaderRow >= 0) {
      const headers = categoryRows[categoryHeaderRow];
      const storeColumn = sourceColumn(headers, "店铺");
      const productColumn = sourceColumn(headers, "商品ID");
      const costColumn = sourceColumn(headers, "成本");
      for (const row of categoryRows.slice(categoryHeaderRow + 1)) {
        const storeName = textValue(rawAt(row, storeColumn));
        const productId = normalizedId(rawAt(row, productColumn));
        const cost = nullableNumber(rawAt(row, costColumn));
        if (currentStores.has(storeName) && productId && cost !== null && cost > 0) registrationCosts.set(mappingKey(storeName, productId), cost);
      }
    }
  }
  const costs = new Map<string, number>();
  const costRows = sheetRows(workbook, costSheetName);
  const costHeaderRow = findHeaderRow(costRows, ["商品ID", "单价"]);
  if (costHeaderRow < 0) return null;
  const costHeaders = costRows[costHeaderRow];
  const costProductColumn = sourceColumn(costHeaders, "商品ID");
  const costValueColumn = sourceColumn(costHeaders, "单价");
  for (const row of costRows.slice(costHeaderRow + 1)) {
    const productId = normalizedId(rawAt(row, costProductColumn));
    const cost = nullableNumber(rawAt(row, costValueColumn));
    if (productId && cost !== null && cost > 0 && !costs.has(productId)) costs.set(productId, cost);
  }

  const oneHourRefundOrders = new Set<string>();
  const afterSaleRows = sheetRows(workbook, afterSaleSheetName);
  const afterSaleHeaderRow = findHeaderRow(afterSaleRows, ["订单号", "商品ID", "1H退款订单"]);
  if (afterSaleHeaderRow < 0) return null;
  const afterSaleHeaders = afterSaleRows[afterSaleHeaderRow];
  const afterSaleOrderColumn = sourceColumn(afterSaleHeaders, "订单号");
  const afterSaleProductColumn = sourceColumn(afterSaleHeaders, "商品ID");
  const oneHourColumn = sourceColumn(afterSaleHeaders, "1H退款订单");
  for (const row of afterSaleRows.slice(afterSaleHeaderRow + 1)) {
    const orderId = normalizedId(rawAt(row, afterSaleOrderColumn));
    const productId = normalizedId(rawAt(row, afterSaleProductColumn));
    if (orderId && productId && textValue(rawAt(row, oneHourColumn)) === "1H退款订单") oneHourRefundOrders.add(`${orderId}::${productId}`);
  }

  const facts = new Map<string, SourceProductFact>();
  const ensureFact = (metricDate: string, storeName: string, productId: string, planId: string | null) => {
    const key = `${storeName}::${productId}::${metricDate}`;
    const existing = facts.get(key);
    if (existing) {
      if (!existing.planId && planId) existing.planId = planId;
      return existing;
    }
    const fallbackCost = costs.get(productId) ?? registrationCosts.get(mappingKey(storeName, productId)) ?? null;
    const fact: SourceProductFact = { metricDate, storeName, productId, planId, submittedOrders: 0, oneHourRefundOrders: 0, paidOrders: 0, preShipRefundOrders: 0, shippedOrders: 0, pendingOrders: 0, postShipRefundOrders: 0, fakeOrders: 0, price: null, cost: fallbackCost, gmv: 0, adSpend: 0, compensation: 0 };
    facts.set(key, fact);
    return fact;
  };

  const planByStoreProduct = new Map<string, string>();
  const spendRows = sheetRows(workbook, spendSheetName);
  const spendHeaderRow = findHeaderRow(spendRows, ["消耗日期", "计划ID", "商品ID", "店铺"]);
  if (spendHeaderRow < 0) return null;
  const spendHeaders = spendRows[spendHeaderRow];
  const spendDateColumn = sourceColumn(spendHeaders, "消耗日期");
  const spendPlanColumn = sourceColumn(spendHeaders, "计划ID");
  const spendProductColumn = findColumn(spendHeaders, (header) => header.includes(normalizeHeader("商品ID")));
  const spendValueColumn = sourceColumn(spendHeaders, "消耗");
  const spendStoreColumn = sourceColumn(spendHeaders, "店铺");
  for (const row of spendRows.slice(spendHeaderRow + 1)) {
    const metricDate = dateValue(rawAt(row, spendDateColumn));
    const storeName = textValue(rawAt(row, spendStoreColumn));
    const productId = normalizedId(rawAt(row, spendProductColumn));
    const planId = normalizedId(rawAt(row, spendPlanColumn));
    if (!metricDate || !currentStores.has(storeName) || !productId || !planId) continue;
    planByStoreProduct.set(mappingKey(storeName, productId), planId);
    ensureFact(metricDate, storeName, productId, planId).adSpend += numberValue(rawAt(row, spendValueColumn));
  }

  const compensationRows = sheetRows(workbook, compensationSheetName);
  const compensationStoresByLookup = new Map<string, Set<string>>();
  const compensationLookupKey = (metricDate: string, productId: string, planId: string) => `${metricDate}::${productId}::${planId}`;
  const compensationHeaderRow = findHeaderRow(compensationRows, ["商品ID", "计划ID", "赔付金额"]);
  if (compensationHeaderRow >= 0) {
    const headers = compensationRows[compensationHeaderRow];
    const productColumn = sourceColumn(headers, "商品ID");
    const planColumn = sourceColumn(headers, "计划ID");
    const dateColumn = findColumn(headers, (header) => header.includes(normalizeHeader("计划日期")));
    const valueColumn = findColumn(headers, (header) => header.includes(normalizeHeader("赔付金额")));
    const storeColumn = sourceColumn(headers, "店铺");
    for (const row of compensationRows.slice(compensationHeaderRow + 1)) {
      const metricDate = dateValue(rawAt(row, dateColumn));
      const storeName = textValue(rawAt(row, storeColumn));
      const productId = normalizedId(rawAt(row, productColumn));
      const planId = normalizedId(rawAt(row, planColumn));
      if (!metricDate || !currentStores.has(storeName) || !productId || !planId) continue;
      const lookupKey = compensationLookupKey(metricDate, productId, planId);
      compensationStoresByLookup.set(lookupKey, new Set([...(compensationStoresByLookup.get(lookupKey) ?? []), storeName]));
      ensureFact(metricDate, storeName, productId, planId).compensation += numberValue(rawAt(row, valueColumn));
    }
  }

  const orderRows = sheetRows(workbook, orderSheetName);
  const orderHeaderRow = findHeaderRow(orderRows, ["店铺", "主订单编号", "商品ID", "订单应付金额", "订单提交时间", "支付完成时间", "订单状态", "售后状态", "发货时间"]);
  if (orderHeaderRow < 0) return null;
  const headers = orderRows[orderHeaderRow];
  const columns = {
    store: sourceColumn(headers, "店铺"), orderId: sourceColumn(headers, "主订单编号"), productId: sourceColumn(headers, "商品ID"), amount: sourceColumn(headers, "订单应付金额"),
    price: sourceColumn(headers, "商品单价"), submittedAt: sourceColumn(headers, "订单提交时间"), paidAt: sourceColumn(headers, "支付完成时间"),
    orderStatus: sourceColumn(headers, "订单状态"), afterSaleStatus: sourceColumn(headers, "售后状态"), shippedAt: sourceColumn(headers, "发货时间"),
  };
  for (const row of orderRows.slice(orderHeaderRow + 1)) {
    const storeName = textValue(rawAt(row, columns.store));
    const productId = normalizedId(rawAt(row, columns.productId));
    if (!currentStores.has(storeName) || !/^\d{12,}$/.test(productId)) continue;
    const planId = planByStoreProduct.get(mappingKey(storeName, productId)) ?? null;
    const submittedDate = dateValue(rawAt(row, columns.submittedAt));
    const paidDate = dateValue(rawAt(row, columns.paidAt));
    const amount = numberValue(rawAt(row, columns.amount));
    const isFake = amount < 20;
    const hasShipment = Boolean(textValue(rawAt(row, columns.shippedAt)));
    const orderStatus = textValue(rawAt(row, columns.orderStatus));
    const afterSaleStatus = textValue(rawAt(row, columns.afterSaleStatus));
    const hasAfterSale = afterSaleStatus !== "-";
    const orderId = normalizedId(rawAt(row, columns.orderId));
    if (submittedDate) ensureFact(submittedDate, storeName, productId, planId).submittedOrders += 1;
    if (!paidDate) continue;
    const fact = ensureFact(paidDate, storeName, productId, planId);
    fact.paidOrders += 1;
    fact.price = Math.max(fact.price ?? 0, nullableNumber(rawAt(row, columns.price)) ?? 0) || fact.price;
    if (isFake) {
      // 已确认口径：刷单统一归为未发货退款，不参与发货、待发货或签收后的统计。
      fact.fakeOrders += 1;
      fact.preShipRefundOrders += 1;
    } else {
      if (hasAfterSale && !hasShipment) fact.preShipRefundOrders += 1;
      if (orderStatus === "待发货" && !hasShipment) fact.pendingOrders += 1;
      if (hasShipment) fact.shippedOrders += 1;
      if (hasAfterSale && hasShipment && afterSaleStatus !== "售后关闭") fact.postShipRefundOrders += 1;
    }
    if (oneHourRefundOrders.has(`${orderId}::${productId}`) && !isFake) fact.oneHourRefundOrders += 1;
    if (!(orderStatus === "已关闭" && afterSaleStatus === "-")) fact.gmv += amount;
  }

  const pivotKeys = new Set(pivotProducts.filter((product) => product.isSummary).map((product) => mappingKey(product.storeName, product.productId)));
  const pivotDailyProfit = new Map(pivotProducts
    .filter((product) => !product.isSummary && product.metricDate)
    .map((product) => [`${mappingKey(product.storeName, product.productId)}::${product.metricDate}`, product] as const));
  const pivotSummaryProfit = new Map(pivotProducts
    .filter((product) => product.isSummary)
    .map((product) => [mappingKey(product.storeName, product.productId), product] as const));
  const applyAuthoritativeProfit = (row: ParsedProductMetric) => {
    const pivot = row.metricDate ? pivotDailyProfit.get(`${mappingKey(row.storeName, row.productId)}::${row.metricDate}`) : null;
    if (!pivot?.profitAvailable) return { ...row, actualProfit: 0, profitMargin: 0, profitAvailable: false };
    return { ...row, actualProfit: pivot.actualProfit, profitMargin: pivot.profitMargin, profitAvailable: true };
  };
  const sourceRowsBeforeRegistryFilter = [...facts.values()].map((fact) => {
    const categoryName = mappings.categories.get(mappingKey(fact.storeName, fact.productId)) ?? "未登记类目";
    return calculateMetric(fact, ownerByStore.get(fact.storeName) ?? null, categoryName);
  }).map(applyAuthoritativeProfit).filter((row) => row.metricDate && (!sourcePeriod.start || row.metricDate >= sourcePeriod.start) && (!sourcePeriod.end || row.metricDate <= sourcePeriod.end));
  const belongsToKnownProduct = (row: ParsedProductMetric) => {
    const key = mappingKey(row.storeName, row.productId);
    return mappings.registry.has(key) || pivotKeys.has(key);
  };
  const ignoredUnregisteredSourceRows = sourceRowsBeforeRegistryFilter.filter((row) => !belongsToKnownProduct(row)).length;
  const sourceRows = sourceRowsBeforeRegistryFilter.filter(belongsToKnownProduct);
  const pivotRange = productDateRange(sheetRows(workbook, workbook.SheetNames.find((name) => normalizeHeader(name).includes(normalizeHeader("数据透视表-提取刷单"))) ?? ""));
  const pivotFacts = sourceRows.filter((row) => row.metricDate && pivotKeys.has(mappingKey(row.storeName, row.productId)) && (!pivotRange.start || row.metricDate >= pivotRange.start) && (!pivotRange.end || row.metricDate <= pivotRange.end));
  const summaries = aggregateSourceMetrics(pivotFacts).map((summary) => {
    const pivot = pivotSummaryProfit.get(mappingKey(summary.storeName, summary.productId));
    if (!pivot?.profitAvailable) return { ...summary, actualProfit: 0, profitMargin: 0, profitAvailable: false };
    return { ...summary, actualProfit: pivot.actualProfit, profitMargin: pivot.profitMargin, profitAvailable: true };
  });
  const pivotSummaries = pivotProducts.filter((row) => row.isSummary);
  const pivotByKey = new Map(pivotSummaries.map((row) => [mappingKey(row.storeName, row.productId), row]));
  const rebuiltKeys = new Set(summaries.map((row) => mappingKey(row.storeName, row.productId)));
  const unmatchedPivotProducts = pivotSummaries
    .filter((row) => !rebuiltKeys.has(mappingKey(row.storeName, row.productId)))
    .map((row) => ({ storeName: row.storeName, productId: row.productId, productName: row.productName }));
  const mismatchSamples: Array<{ storeName: string; productId: string; fields: string[] }> = [];
  let mismatchCount = 0;
  const acceptedVariances: Array<{ storeName: string; productId: string; fields: string[] }> = [];
  const compensationCrossStoreProducts = new Set(pivotFacts.flatMap((row) => {
    if (!row.metricDate || !row.planId) return [];
    const storesForLookup = compensationStoresByLookup.get(compensationLookupKey(row.metricDate, row.productId, row.planId));
    return storesForLookup && [...storesForLookup].some((storeName) => storeName !== row.storeName)
      ? [mappingKey(row.storeName, row.productId)]
      : [];
  }));
  const comparisons = summaries.map((row) => {
    const pivot = pivotByKey.get(mappingKey(row.storeName, row.productId));
    const fields = !pivot ? ["missing_pivot_summary"] : [
      ["submittedOrders", row.submittedOrders, pivot.submittedOrders], ["paidOrders", row.paidOrders, pivot.paidOrders], ["gmv", row.gmv, pivot.gmv], ["adSpend", row.adSpend, pivot.adSpend], ["compensation", row.compensation, pivot.compensation], ["actualProfit", row.actualProfit, pivot.actualProfit],
    ].flatMap(([field, actual, expected]) => Math.abs(Number(actual) - Number(expected)) < 0.01 ? [] : [String(field)]);
    if (fields.length) {
      mismatchCount += 1;
      if (mismatchSamples.length < 20) mismatchSamples.push({ storeName: row.storeName, productId: row.productId, fields });
    }
    const accepted = fields.length > 0
      && fields.every((field) => field === "compensation" || field === "actualProfit")
      && compensationCrossStoreProducts.has(mappingKey(row.storeName, row.productId));
    if (accepted) acceptedVariances.push({ storeName: row.storeName, productId: row.productId, fields });
    return { fields, accepted };
  });
  const verified = summaries.length === pivotSummaries.length && comparisons.every((comparison) => comparison.fields.length === 0);
  const authoritative = summaries.length === pivotSummaries.length && comparisons.every((comparison) => comparison.fields.length === 0 || comparison.accepted);
  return {
    products: [...summaries, ...sourceRows],
    verified,
    authoritative,
    summaryCount: summaries.length,
    pivotSummaryCount: pivotSummaries.length,
    mismatchCount,
    samples: mismatchSamples,
    acceptedVariances,
    unmatchedPivotProducts,
    ignoredUnregisteredSourceRows,
    // Product analysis must cover all source facts in the imported operating window.
    // The pivot range is retained above only for Excel reconciliation.
    period: sourcePeriod,
  };
}

function buildIssues(stores: ParsedStoreDaily[], products: ParsedProductMetric[], mappings: ProductMappings) {
  const issues: ParsedAnalyticsIssue[] = [];
  const summaryProducts = products.filter((product) => product.isSummary);
  const summaryCounts = new Map<string, number>();
  for (const product of summaryProducts) {
    summaryCounts.set(product.storeProductKey, (summaryCounts.get(product.storeProductKey) ?? 0) + 1);
    if (product.cost === null || product.cost <= 0) {
      issues.push({ severity: "critical", issueType: "missing_cost", scope: "product", entityKey: product.storeProductKey, message: `${product.storeName} · ${product.productName} 缺少有效成本，暂停利润决策。` });
    }
    if (product.price === null || product.price <= 0) {
      issues.push({ severity: "warning", issueType: "missing_price", scope: "product", entityKey: product.storeProductKey, message: `${product.storeName} · ${product.productName} 缺少有效售价。` });
    }
    if (product.adSpend > 100 && product.gmv <= 0) {
      issues.push({ severity: "critical", issueType: "spend_without_gmv", scope: "product", entityKey: product.storeProductKey, message: `${product.storeName} · ${product.productName} 有 ${product.adSpend.toFixed(2)} 元消耗但没有成交金额。` });
    }
    if (!product.planId) {
      issues.push({ severity: "warning", issueType: "missing_plan_mapping", scope: "product", entityKey: product.storeProductKey, message: `${product.storeName} · ${product.productId} 未在千川全域表匹配到计划 ID。` });
    }
    if (!mappings.categories.has(mappingKey(product.storeName, product.productId))) {
      issues.push({ severity: "warning", issueType: "missing_category_mapping", scope: "product", entityKey: product.storeProductKey, message: `${product.storeName} · ${product.productId} 未在产品类目登记中找到店铺商品映射，当前名称仅作原表回退展示。` });
    }
  }
  for (const [key, count] of summaryCounts) {
    if (count > 1) issues.push({ severity: "warning", issueType: "duplicate_product_summary", scope: "product", entityKey: key, message: `商品周期小计出现 ${count} 次，分析时已按导入批次隔离，建议检查透视表层级。` });
  }
  for (const store of stores) {
    const threshold = Math.max(100, Math.abs(store.gmv) * 0.05);
    if (Math.abs(store.gmvGap) > threshold) {
      issues.push({ severity: "info", issueType: "store_gmv_variance", scope: "store", entityKey: `${store.metricDate}:${store.storeName}`, message: `${store.storeName} 在 ${store.metricDate} 的千川与店铺 GMV 口径差异为 ${store.gmvGap.toFixed(2)} 元。` });
    }
  }
  return issues;
}

type WorkbookProgress = { progress: number; stage: string };

function* parseAnalyticsWorkbookSteps(buffer: Buffer): Generator<WorkbookProgress, ParsedAnalyticsWorkbook, void> {
  // Keep Excel serial dates as numbers. Converting them to JavaScript Date objects
  // shifts date-only cells across the local/UTC boundary before aggregation.
  // The 9.1 workbook stores some date/formula cells in styled ranges where
  // SheetJS drops the cached value when cellStyles is enabled. Values are the
  // authoritative input for parsing; audit logic does not require styles.
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, cellFormula: true, cellStyles: false });
  yield { progress: 4, stage: "已读取工作簿" };
  const storeSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader("店铺每日数据汇总"));
  const productSheetName = workbook.SheetNames.find((name) => normalizeHeader(name).includes(normalizeHeader("数据透视表-提取刷单")));
  if (!storeSheetName) throw new Error("利润表缺少“店铺每日数据汇总”工作表");
  if (!productSheetName) throw new Error("利润表缺少“数据透视表-提取刷单”工作表");
  yield { progress: 8, stage: `已识别 ${workbook.SheetNames.length} 张工作表` };

  const storeRows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[storeSheetName], { header: 1, defval: null, raw: true });
  const stores = parseStoreRows(storeRows);
  if (!stores.length) throw new Error("店铺每日数据汇总中没有可识别的店铺日数据");
  const storeNames = [...new Set(stores.map((row) => row.storeName))];
  yield { progress: 20, stage: `已解析店铺日数据 ${stores.length.toLocaleString("zh-CN")} 行` };
  const productRows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[productSheetName], { header: 1, defval: null, raw: true });
  const pivotProductPeriod = productDateRange(productRows);
  const storeDates = stores.map((row) => row.metricDate).sort();
  const sourceProductPeriod = { start: storeDates[0] ?? null, end: storeDates.at(-1) ?? null };
  const mappings = buildProductMappings(workbook, storeNames, sourceProductPeriod.start, sourceProductPeriod.end);
  yield { progress: 32, stage: `已建立商品映射 ${mappings.registry.size.toLocaleString("zh-CN")} 个` };
  const pivotProducts = parseProductRows(productRows, storeNames, mappings);
  for (const product of pivotProducts) {
    if (product.price === null) continue;
    const key = mappingKey(product.storeName, product.productId);
    if (mappings.storeProductPrices.get(key) === null || mappings.storeProductPrices.get(key) === undefined) {
      mappings.storeProductPrices.set(key, product.price);
    }
  }
  yield { progress: 42, stage: `已解析商品透视数据 ${pivotProducts.length.toLocaleString("zh-CN")} 行` };
  const planAnalysis = parsePlanAnalysis(workbook, mappings);
  yield { progress: 50, stage: `已解析千川计划 ${planAnalysis.rows.length.toLocaleString("zh-CN")} 行` };
  const sourceProducts = parseSourceProductRows(workbook, storeNames, stores, mappings, pivotProducts);
  // Source-level daily facts are the sole product-analysis input. Pivot rows only
  // validate that the workbook's selected Excel view follows the same formulas.
  const sourceDailyProducts = sourceProducts?.products.filter((product) => !product.isSummary) ?? [];
  const products = sourceProducts?.products ?? pivotProducts;
  const reconciliationProducts = sourceDailyProducts.length ? sourceProducts?.products ?? pivotProducts : pivotProducts;
  const issueProducts = sourceProducts
    ? aggregateSourceMetrics(products)
    : reconciliationProducts;
  const productPeriod = sourceProducts?.period ?? pivotProductPeriod;
  if (!products.some((product) => product.metricDate)) throw new Error("未找到可用于商品经营分析的原始每日数据");
  yield { progress: 62, stage: `已回推商品经营数据 ${products.length.toLocaleString("zh-CN")} 行` };

  const issues = [
    ...buildIssues(stores, issueProducts, mappings),
    ...(sourceProducts?.acceptedVariances.map((variance) => ({
      severity: "info" as const,
      issueType: "compensation_cross_store_match_prevented",
      scope: "product" as const,
      entityKey: mappingKey(variance.storeName, variance.productId),
      message: `${variance.storeName} / ${variance.productId} 的旧透视赔付会串入其他店铺同商品同计划记录；当前已按店铺、商品 ID、计划 ID 与日期隔离重算。`,
    })) ?? []),
    ...(sourceProducts && sourceProducts.ignoredUnregisteredSourceRows > 0 ? [{
      severity: "warning" as const,
      issueType: "unregistered_source_product_rows",
      scope: "import" as const,
      entityKey: null,
      message: `发现 ${sourceProducts.ignoredUnregisteredSourceRows} 条没有“店铺 + 商品 ID”主档的源数据，已隔离出商品经营分析，避免串入其他店铺商品。`,
    }] : []),
  ];
  yield { progress: 70, stage: `已生成数据核验 ${issues.length.toLocaleString("zh-CN")} 项` };
  const audit = auditProfitWorkbook(workbook, stores, reconciliationProducts);
  yield { progress: 78, stage: `已完成公式审计 ${audit.formulas.length.toLocaleString("zh-CN")} 项` };
  const sourceRebuild = sourceProducts
    ? {
      available: true,
      verified: sourceProducts.verified,
      authoritative: sourceProducts.authoritative,
      summaryCount: sourceProducts.summaryCount,
      pivotSummaryCount: sourceProducts.pivotSummaryCount,
      mismatchCount: sourceProducts.mismatchCount,
      samples: sourceProducts.samples,
      acceptedVariances: sourceProducts.acceptedVariances,
      unmatchedPivotProducts: sourceProducts.unmatchedPivotProducts,
      ignoredUnregisteredSourceRows: sourceProducts.ignoredUnregisteredSourceRows,
    }
    : {
      available: false,
      verified: false,
      authoritative: false,
      summaryCount: 0,
      pivotSummaryCount: pivotProducts.filter((row) => row.isSummary).length,
      mismatchCount: 0,
      samples: [],
      acceptedVariances: [],
      unmatchedPivotProducts: [],
      ignoredUnregisteredSourceRows: 0,
    };
  const sourceRebuildCheck: WorkbookReconciliation = !sourceRebuild.available
    ? {
      checkKey: "source_product_rebuild",
      category: "product",
      status: "warning",
      label: "商品日数据回推",
      expectedValue: sourceRebuild.pivotSummaryCount,
      actualValue: null,
      difference: null,
      tolerance: 0,
      message: "未能从订单、售后、成本、消耗和赔付源表完整回推商品日数据，当前仅使用透视表结果，需复核源表结构。",
    }
    : sourceRebuild.authoritative
      ? {
        checkKey: "source_product_rebuild",
        category: "product",
        status: "pass",
        label: "商品日数据回推",
        expectedValue: sourceRebuild.pivotSummaryCount,
        actualValue: sourceRebuild.summaryCount,
        difference: 0,
        tolerance: 0,
        message: sourceRebuild.verified
          ? `已按订单、售后、成本、消耗、赔付的店铺 + 商品 ID + 计划 ID + 日期回推 ${sourceRebuild.summaryCount} 个商品周期小计，与透视表完全一致。`
          : `已回推 ${sourceRebuild.summaryCount} 个商品周期小计；${sourceRebuild.acceptedVariances.length} 条旧透视赔付串店差异已按店铺、商品、计划和日期隔离修正。`,
      }
      : {
        checkKey: "source_product_rebuild",
        category: "product",
        status: "warning",
        label: "商品日数据回推",
        expectedValue: sourceRebuild.pivotSummaryCount,
        actualValue: sourceRebuild.summaryCount,
        difference: sourceRebuild.summaryCount - sourceRebuild.pivotSummaryCount,
        tolerance: 0,
        message: `源表回推 ${sourceRebuild.summaryCount} 个商品周期小计、透视表 ${sourceRebuild.pivotSummaryCount} 个；${sourceRebuild.mismatchCount} 个商品存在字段差异，${sourceRebuild.unmatchedPivotProducts.length} 个透视商品未能从源表回推。相关商品会在问题清单中保留，需复核原表。`,
      };
  const reconciliations = [...audit.reconciliations, sourceRebuildCheck];
  const reconciliationStatus: ParsedAnalyticsWorkbook["reconciliationStatus"] = reconciliations.some((item) => item.status === "fail")
    ? "fail"
    : reconciliations.some((item) => item.status === "warning")
      ? "warning"
      : "pass";
  const sourceOrderAudit = audit.sheets.find((sheet) => sheet.sheetName === "订单明细修改");
  const sourceSpendAudit = audit.sheets.find((sheet) => sheet.sheetName === "千川计划消耗-全域");
  yield { progress: 86, stage: "正在整理预检结果" };
  return {
    periodStart: storeDates[0] ?? null,
    periodEnd: storeDates.at(-1) ?? null,
    productPeriodStart: productPeriod.start,
    productPeriodEnd: productPeriod.end,
    productProfitTotal: audit.productProfitTotal,
    cachedProductProfitTotal: audit.cachedProductProfitTotal,
    reconciliationStatus,
    formulaCount: audit.formulaCount,
    formulaErrorCount: audit.formulaErrorCount,
    fixedRangeRiskCount: audit.fixedRangeRiskCount,
    stores,
    products,
    productRegistry: [...mappings.registry.values()].sort((left, right) => left.storeName.localeCompare(right.storeName, "zh-CN") || left.productId.localeCompare(right.productId)),
    planAnalysis,
    sourceRebuild,
    issues,
    sheetAudits: audit.sheets,
    formulaAudits: audit.formulas,
    reconciliations,
    sourceOrderRows: sourceOrderAudit?.dataRowCount ?? 0,
    sourceOrderLastRow: sourceOrderAudit?.lastDataRow ?? 0,
    sourceSpendRows: sourceSpendAudit?.dataRowCount ?? 0,
    sourceSpendLastRow: sourceSpendAudit?.lastDataRow ?? 0,
    storeCount: new Set(stores.map((row) => row.storeName)).size,
    productCount: new Set(products.map((row) => row.storeProductKey)).size,
    registeredProductCount: mappings.registry.size,
  };
}

export function parseAnalyticsWorkbook(buffer: Buffer): ParsedAnalyticsWorkbook {
  const iterator = parseAnalyticsWorkbookSteps(buffer);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

export async function parseAnalyticsWorkbookWithProgress(
  buffer: Buffer,
  onProgress: (progress: WorkbookProgress) => Promise<void>,
): Promise<ParsedAnalyticsWorkbook> {
  const iterator = parseAnalyticsWorkbookSteps(buffer);
  let step = iterator.next();
  while (!step.done) {
    await onProgress(step.value);
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = iterator.next();
  }
  return step.value;
}
