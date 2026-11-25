import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "@/lib/db";
import { storagePaths } from "@/lib/storage-root";
import {
  analyticsDataIssues,
  analyticsAuditLogs,
  analyticsFormulaAudits,
  analyticsImports,
  analyticsProductRegistry,
  analyticsProductMetrics,
  analyticsPlanDaily,
  analyticsReconciliations,
  analyticsSheetAudits,
  analyticsStoreDaily,
  authUsers,
} from "@/lib/db/schema";
import { parseAnalyticsWorkbookWithProgress, type ParsedProductMetric } from "@/lib/analytics/workbook-parser";
import { buildPlanChangeInsights, buildPlanInsights, mergePlanChangeInsights, type PlanInsights } from "@/lib/analytics/plan-insights";
import {
  classifyStoreDiagnostic,
  isStoreGmvVariance,
  storeGmvGapRate,
  topStoreGmvVarianceDays,
  type StoreDiagnosticStatus,
  type StoreGmvVarianceDay,
} from "@/lib/analytics/store-diagnostics";

const IMPORT_ROOT = storagePaths.imports();
const INSERT_CHUNK_SIZE = 400;

export type AnalyticsDecision = "scale" | "stable" | "optimize" | "high_roi_loss" | "review" | "data_issue";

export type AnalyticsAction = {
  state: AnalyticsDecision | "store_loss";
  count: number;
  label: string;
  impactAmount: number | null;
  impactLabel: string;
  topEntities: Array<{ key: string; name: string; detail: string; amount: number | null }>;
};

export type AnalyticsDashboard = {
  scope: { ownerId: string; username: string; accountId: string; isAll: boolean }[];
  imports: Array<{
    id: string;
    ownerId: string;
    username: string;
    accountId: string;
    fileName: string;
    periodStart: string | null;
    periodEnd: string | null;
    productPeriodStart: string | null;
    productPeriodEnd: string | null;
    createdAt: string | null;
    storeCount: number;
    productCount: number;
    registeredProductCount: number;
    issueCount: number;
    productProfitTotal: number;
    cachedProductProfitTotal: number;
    reconciliationStatus: "pass" | "warning" | "fail";
    formulaCount: number;
    formulaErrorCount: number;
    fixedRangeRiskCount: number;
    snapshotDate: string | null;
    maturityDays: number;
  }>;
  period: { start: string | null; end: string | null };
  dataWindows: {
    store: { start: string | null; end: string | null };
    product: { start: string | null; end: string | null };
    productAnalysis: { available: boolean; comparisonAvailable: boolean; message: string | null };
  };
  kpis: {
    gmv: number;
    adSpend: number;
    actualProfit: number;
    profitMargin: number;
    totalRefund: number;
    compensation: number;
    roi: number;
    netDealRoi: number;
    paidOrders: number;
    fakeOrders: number;
    fakeOrderRate: number;
    productProfitTotal: number;
  };
  stores: StoreSummary[];
  products: ProductSummary[];
  issues: Array<{
    id: string;
    ownerId: string;
    username: string;
    severity: "info" | "warning" | "critical";
    issueType: string;
    scope: "import" | "store" | "product";
    entityKey: string | null;
    message: string;
  }>;
  trend: Array<{ date: string; gmv: number; adSpend: number; actualProfit: number; totalRefund: number; compensation: number; paidOrders: number; maturity: "observing" | "settling" | "stable"; ageDays: number }>;
  comparison: {
    currentStart: string | null;
    currentEnd: string | null;
    previousStart: string | null;
    previousEnd: string | null;
    days: number;
    hasPreviousData: boolean;
  };
  revisionSignals: RevisionSignal[];
  versionComparison: VersionComparison;
  actions: AnalyticsAction[];
  availableStores: string[];
  accuracy: {
    status: "pass" | "warning" | "fail" | "empty";
    formulaCount: number;
    formulaErrorCount: number;
    fixedRangeRiskCount: number;
    passedChecks: number;
    warningChecks: number;
    failedChecks: number;
  };
  sheetAudits: Array<typeof analyticsSheetAudits.$inferSelect>;
  formulaAudits: Array<typeof analyticsFormulaAudits.$inferSelect>;
  reconciliations: Array<typeof analyticsReconciliations.$inferSelect>;
  history: ImportHistoryItem[];
  historyDiffs: ImportHistoryDiff[];
  planInsights: PlanInsights;
};

export type ImportHistoryItem = {
  id: string;
  ownerId: string;
  username: string;
  fileName: string;
  status: typeof analyticsImports.$inferSelect.status;
  stage: string;
  progress: number;
  periodStart: string | null;
  periodEnd: string | null;
  productPeriodStart: string | null;
  productPeriodEnd: string | null;
  storeCount: number;
  productCount: number;
  registeredProductCount: number;
  issueCount: number;
  productProfitTotal: number;
  reconciliationStatus: "pass" | "warning" | "fail";
  snapshotDate: string | null;
  maturityDays: number;
  errorMessage: string | null;
  createdAt: string | null;
  committedAt: string | null;
};

export type ImportHistoryDiff = {
  ownerId: string;
  username: string;
  currentImportId: string;
  previousImportId: string | null;
  profitChange: number;
  issueChange: number;
  storeChange: number;
  productChange: number;
};

export type StoreSummary = {
  key: string;
  ownerId: string;
  username: string;
  storeName: string;
  gmv: number;
  adSpend: number;
  actualProfit: number;
  profitMargin: number;
  roi: number;
  netDealRoi: number;
  totalRefund: number;
  compensation: number;
  paidOrders: number;
  fakeOrders: number;
  fakeOrderRate: number;
  oneHourRefundRate: number | null;
  overallShippingRate: number | null;
  netShippingRate: number | null;
  signRate: number | null;
  gmvGap: number;
  gmvGapRate: number | null;
  qianchuanGmv: number;
  hasGmvVariance: boolean;
  gmvVarianceDays: StoreGmvVarianceDay[];
  qianchuanAccounts: Array<{
    accountId: string;
    accountName: string;
    spend: number;
    netAmount: number;
    netOrders: number;
    planCount: number;
  }>;
  dataIssueReasons: string[];
  previousGmv: number;
  hasPreviousData: boolean;
  previousAdSpend: number;
  previousActualProfit: number;
  previousTotalRefund: number;
  gmvChange: number;
  adSpendChange: number;
  profitChange: number;
  refundChange: number;
  status: StoreDiagnosticStatus;
};

export type ProductSummary = ParsedProductMetric & {
  key: string;
  ownerId: string;
  username: string;
  accountId: string;
  decision: AnalyticsDecision;
  reasons: string[];
  fakeOrderRate: number;
  previousGmv: number;
  hasPreviousData: boolean;
  previousAdSpend: number;
  previousActualProfit: number;
  previousNetShippingRate: number;
  previousSignRate: number;
  gmvChange: number;
  adSpendChange: number;
  profitChange: number;
  netShippingRateChange: number;
  signRateChange: number;
  storeCategoryNetShippingMedian: number | null;
  storeCategorySignMedian: number | null;
  globalCategoryNetShippingMedian: number | null;
  globalCategorySignMedian: number | null;
  maturity: "observing" | "settling" | "stable";
  maturityAgeDays: number;
  latestMetricDate: string | null;
};

export type RevisionSignal = {
  key: string;
  ownerId: string;
  storeName: string;
  productId: string;
  planId: string | null;
  categoryName: string;
  metricDate: string;
  previousSnapshotDate: string;
  currentSnapshotDate: string;
  previousRoi: number;
  currentRoi: number;
  previousNetDealRoi: number;
  currentNetDealRoi: number;
  previousPaidOrders: number;
  currentPaidOrders: number;
  previousOverallShippingRate: number;
  currentOverallShippingRate: number;
  previousNetShippingRate: number;
  currentNetShippingRate: number;
  previousSignRate: number;
  currentSignRate: number;
  previousProfitMargin: number;
  currentProfitMargin: number;
  previousActualProfit: number;
  currentActualProfit: number;
  previousGmv: number;
  currentGmv: number;
  previousAdSpend: number;
  currentAdSpend: number;
  previousOneHourRefundRate: number;
  currentOneHourRefundRate: number;
  roiChange: number;
  netDealRoiChange: number;
  paidOrdersChange: number;
  overallShippingRateChange: number;
  netShippingRateChange: number;
  signRateChange: number;
  profitMarginChange: number;
  actualProfitChange: number;
  gmvChange: number;
  adSpendChange: number;
  oneHourRefundRateChange: number;
  shippingDeclined: boolean;
  signDeclined: boolean;
  profitDeclined: boolean;
  refundIncreased: boolean;
};

export type VersionImportSummary = {
  id: string;
  ownerId: string;
  fileName: string;
  snapshotDate: string | null;
  committedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  productPeriodStart: string | null;
  productPeriodEnd: string | null;
};

export type VersionComparison = {
  available: boolean;
  mode: "adjacent" | "custom" | "per_owner";
  baseline: VersionImportSummary | null;
  target: VersionImportSummary | null;
  pairs: Array<{ ownerId: string; baseline: VersionImportSummary; target: VersionImportSummary }>;
  summary: {
    overlapRows: number;
    changedRows: number;
    unchangedRows: number;
    addedRows: number;
    missingRows: number;
    addedBusinessDates: string[];
    missingBusinessDates: string[];
    previousGmv: number;
    currentGmv: number;
    previousAdSpend: number;
    currentAdSpend: number;
    previousActualProfit: number;
    currentActualProfit: number;
    addedGmv: number;
    addedAdSpend: number;
    addedActualProfit: number;
  };
  message: string | null;
};

function currentShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function validDateInput(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateDistance(later: string, earlier: string) {
  return Math.max(0, Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000));
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function categoryFor(product: { categoryName: string; productName: string }) {
  return product.categoryName && product.categoryName !== "未登记类目" ? product.categoryName : product.productName;
}

function maturityFor(metricDate: string, snapshotDate: string | null, maturityDays: number) {
  const ageDays = snapshotDate ? dateDistance(snapshotDate, metricDate) : 0;
  const maturity: "observing" | "settling" | "stable" = ageDays >= maturityDays + 1 ? "stable" : ageDays >= Math.max(1, maturityDays - 2) ? "settling" : "observing";
  return { maturity, ageDays };
}

function chunks<T>(items: T[], size = INSERT_CHUNK_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function writeAnalyticsChunks<T>(input: {
  rows: T[];
  insert: (chunk: T[]) => unknown;
  stage: string;
  progressStart: number;
  progressEnd: number;
  updateProgress: (progress: number, stage: string) => Promise<void>;
}) {
  const groups = chunks(input.rows);
  if (!groups.length) {
    await input.updateProgress(input.progressEnd, `${input.stage}（无数据）`);
    return;
  }
  for (const [index, group] of groups.entries()) {
    await input.insert(group);
    const progress = input.progressStart + Math.round(((index + 1) / groups.length) * (input.progressEnd - input.progressStart));
    await input.updateProgress(progress, `${input.stage} ${index + 1}/${groups.length}`);
    await yieldToEventLoop();
  }
}

function safeFileName(fileName: string) {
  const base = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").trim();
  return base.slice(0, 120) || "利润表.xlsx";
}

async function writeAnalyticsAudit(input: {
  actorId: string | null;
  ownerId: string | null;
  importId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}) {
  await getDb().insert(analyticsAuditLogs).values({
    id: crypto.randomUUID(),
    actorId: input.actorId,
    ownerId: input.ownerId,
    importId: input.importId,
    action: input.action,
    detail: input.detail ?? {},
  });
}

export async function createAnalyticsImportPreview(input: { ownerId: string; actorId: string; fileName: string; buffer: Buffer; snapshotDate?: string | null }) {
  const db = getDb();
  const importId = crypto.randomUUID();
  const ownerDir = join(IMPORT_ROOT, input.ownerId);
  await mkdir(ownerDir, { recursive: true });
  const storedName = `${Date.now()}-${safeFileName(input.fileName)}`;
  const absolutePath = join(ownerDir, storedName);
  await writeFile(absolutePath, input.buffer);
  const filePath = absolutePath;
  await db.insert(analyticsImports).values({
    id: importId,
    ownerId: input.ownerId,
    createdBy: input.actorId,
    fileName: input.fileName,
    filePath,
    status: "queued",
    stage: "等待后台解析",
    progress: 0,
    snapshotDate: validDateInput(input.snapshotDate) ?? currentShanghaiDate(),
    maturityDays: 6,
  });
  await writeAnalyticsAudit({
    actorId: input.actorId,
    ownerId: input.ownerId,
    importId,
    action: "analytics.import.queued",
    detail: { fileName: input.fileName, bytes: input.buffer.byteLength },
  });
  invalidateAnalyticsDashboardCache(input.ownerId);
  return { importId };
}

async function clearAnalyticsImportData(importId: string) {
  const db = getDb();
  await db.delete(analyticsStoreDaily).where(eq(analyticsStoreDaily.importId, importId));
  await db.delete(analyticsProductMetrics).where(eq(analyticsProductMetrics.importId, importId));
  await db.delete(analyticsProductRegistry).where(eq(analyticsProductRegistry.importId, importId));
  await db.delete(analyticsPlanDaily).where(eq(analyticsPlanDaily.importId, importId));
  await db.delete(analyticsDataIssues).where(eq(analyticsDataIssues.importId, importId));
  await db.delete(analyticsSheetAudits).where(eq(analyticsSheetAudits.importId, importId));
  await db.delete(analyticsFormulaAudits).where(eq(analyticsFormulaAudits.importId, importId));
  await db.delete(analyticsReconciliations).where(eq(analyticsReconciliations.importId, importId));
}

export async function processAnalyticsImport(importId: string, targetStatus: "preview_ready" | "completed" = "preview_ready") {
  const db = getDb();
  const [batch] = await db.select().from(analyticsImports).where(eq(analyticsImports.id, importId)).limit(1);
  if (!batch) throw new Error("利润表批次不存在");
  const updateProgress = async (progress: number, stage: string) => {
    await db.update(analyticsImports).set({ status: "processing", stage, progress, errorMessage: null }).where(eq(analyticsImports.id, importId));
    invalidateAnalyticsDashboardCache(batch.ownerId);
  };
  await updateProgress(1, "准备读取利润表");
  invalidateAnalyticsDashboardCache(batch.ownerId);

  try {
    const parsed = await parseAnalyticsWorkbookWithProgress(
      await readFile(resolveAnalyticsImportFilePath(batch.ownerId, batch.filePath)),
      ({ progress, stage }) => updateProgress(progress, stage),
    );
    await clearAnalyticsImportData(importId);
    await updateProgress(88, "开始写入经营数据");
    await writeAnalyticsChunks({ rows: parsed.stores, stage: "写入店铺日数据", progressStart: 88, progressEnd: 90, updateProgress, insert: (chunk) => db.insert(analyticsStoreDaily).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await writeAnalyticsChunks({ rows: parsed.products, stage: "写入商品经营数据", progressStart: 90, progressEnd: 92, updateProgress, insert: (chunk) => db.insert(analyticsProductMetrics).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await writeAnalyticsChunks({ rows: parsed.productRegistry, stage: "写入商品登记", progressStart: 92, progressEnd: 93, updateProgress, insert: (chunk) => db.insert(analyticsProductRegistry).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await writeAnalyticsChunks({ rows: parsed.planAnalysis.rows, stage: "写入千川计划", progressStart: 93, progressEnd: 96, updateProgress, insert: (chunk) => db.insert(analyticsPlanDaily).values(chunk.map((row) => ({
        id: crypto.randomUUID(),
        importId,
        ownerId: batch.ownerId,
        ...row,
        brushLike: row.brushLike ? 1 : 0,
        roiHit: row.roiHit ? 1 : 0,
        lowOrderStop: row.lowOrderStop ? 1 : 0,
      }))) });
    await writeAnalyticsChunks({ rows: parsed.issues, stage: "写入异常清单", progressStart: 96, progressEnd: 97, updateProgress, insert: (chunk) => db.insert(analyticsDataIssues).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await writeAnalyticsChunks({ rows: parsed.sheetAudits, stage: "写入工作表审计", progressStart: 97, progressEnd: 98, updateProgress, insert: (chunk) => db.insert(analyticsSheetAudits).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await writeAnalyticsChunks({ rows: parsed.formulaAudits, stage: "写入公式审计", progressStart: 98, progressEnd: 99, updateProgress, insert: (chunk) => db.insert(analyticsFormulaAudits).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await writeAnalyticsChunks({ rows: parsed.reconciliations, stage: "写入对账结果", progressStart: 99, progressEnd: 99, updateProgress, insert: (chunk) => db.insert(analyticsReconciliations).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row }))) });
    await db.update(analyticsImports).set({
      status: targetStatus,
      stage: targetStatus === "completed" ? "已按 Excel 原表导入" : "等待确认导入",
      progress: 100,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      productPeriodStart: parsed.productPeriodStart,
      productPeriodEnd: parsed.productPeriodEnd,
      storeCount: parsed.storeCount,
      productCount: parsed.productCount,
      registeredProductCount: parsed.registeredProductCount,
      storeRowCount: parsed.stores.length,
      productRowCount: parsed.products.length,
      productProfitTotal: parsed.productProfitTotal,
      cachedProductProfitTotal: parsed.cachedProductProfitTotal,
      reconciliationStatus: parsed.reconciliationStatus,
      formulaCount: parsed.formulaCount,
      formulaErrorCount: parsed.formulaErrorCount,
      fixedRangeRiskCount: parsed.fixedRangeRiskCount,
      issueCount: parsed.issues.length,
      sourceOrderRows: parsed.sourceOrderRows,
      sourceOrderLastRow: parsed.sourceOrderLastRow,
      sourceSpendRows: parsed.sourceSpendRows,
      sourceSpendLastRow: parsed.sourceSpendLastRow,
      previewedAt: new Date(),
      committedAt: targetStatus === "completed" ? batch.committedAt ?? new Date() : null,
      completedAt: batch.completedAt ?? new Date(),
      errorMessage: null,
    }).where(eq(analyticsImports.id, importId));
    await writeAnalyticsAudit({
      actorId: batch.createdBy,
      ownerId: batch.ownerId,
      importId,
      action: targetStatus === "completed" ? "analytics.import.completed" : "analytics.import.preview_ready",
      detail: { storeCount: parsed.storeCount, productCount: parsed.productCount, issueCount: parsed.issues.length, reconciliationStatus: parsed.reconciliationStatus },
    });
    invalidateAnalyticsDashboardCache(batch.ownerId);
    return { importId, ...parsed, stores: undefined, products: undefined, productRegistry: undefined, issues: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : "利润表解析失败";
    await db.update(analyticsImports).set({ status: "failed", stage: "解析失败", progress: 100, errorMessage: message, completedAt: new Date() }).where(eq(analyticsImports.id, importId));
    await writeAnalyticsAudit({ actorId: batch.createdBy, ownerId: batch.ownerId, importId, action: "analytics.import.failed", detail: { message } });
    invalidateAnalyticsDashboardCache(batch.ownerId);
    throw new Error(message);
  }
}

export async function importAnalyticsWorkbook(input: { ownerId: string; actorId?: string; fileName: string; buffer: Buffer }) {
  const { importId } = await createAnalyticsImportPreview({ ...input, actorId: input.actorId ?? input.ownerId });
  return processAnalyticsImport(importId, "completed");
}

export async function getAnalyticsImportStatus(importId: string, user: { id: string; role: "admin" | "user" }) {
  const [batch] = await getDb().select().from(analyticsImports).where(eq(analyticsImports.id, importId)).limit(1);
  if (!batch || (user.role !== "admin" && batch.ownerId !== user.id)) throw new Error("利润表批次不存在或无权访问");
  return {
    id: batch.id,
    ownerId: batch.ownerId,
    fileName: batch.fileName,
    status: batch.status,
    stage: batch.stage,
    progress: batch.progress,
    periodStart: batch.periodStart,
    periodEnd: batch.periodEnd,
    productPeriodStart: batch.productPeriodStart,
    productPeriodEnd: batch.productPeriodEnd,
    storeCount: batch.storeCount,
    productCount: batch.productCount,
    registeredProductCount: batch.registeredProductCount,
    issueCount: batch.issueCount,
    productProfitTotal: batch.productProfitTotal,
    cachedProductProfitTotal: batch.cachedProductProfitTotal,
    reconciliationStatus: batch.reconciliationStatus,
    formulaCount: batch.formulaCount,
    formulaErrorCount: batch.formulaErrorCount,
    sourceOrderRows: batch.sourceOrderRows,
    sourceOrderLastRow: batch.sourceOrderLastRow,
    sourceSpendRows: batch.sourceSpendRows,
    sourceSpendLastRow: batch.sourceSpendLastRow,
    snapshotDate: batch.snapshotDate,
    maturityDays: batch.maturityDays,
    errorMessage: batch.errorMessage,
  };
}

export async function commitAnalyticsImport(importId: string, user: { id: string; role: "admin" | "user" }, options?: { snapshotDate?: string | null; maturityDays?: number | null }) {
  const db = getDb();
  const [batch] = await db.select().from(analyticsImports).where(eq(analyticsImports.id, importId)).limit(1);
  if (!batch || (user.role !== "admin" && batch.ownerId !== user.id)) throw new Error("利润表批次不存在或无权访问");
  if (batch.status !== "preview_ready") throw new Error("当前批次尚未完成预检或已经提交");
  const snapshotDate = validDateInput(options?.snapshotDate) ?? batch.snapshotDate ?? currentShanghaiDate();
  const maturityDays = Math.min(30, Math.max(1, Math.round(options?.maturityDays ?? batch.maturityDays ?? 6)));
  await db.update(analyticsImports).set({ status: "completed", stage: "已正式导入", snapshotDate, maturityDays, committedAt: new Date(), completedAt: new Date() }).where(eq(analyticsImports.id, importId));
  await writeAnalyticsAudit({ actorId: user.id, ownerId: batch.ownerId, importId, action: "analytics.import.committed", detail: { fileName: batch.fileName } });
  invalidateAnalyticsDashboardCache(batch.ownerId);
  return getAnalyticsImportStatus(importId, user);
}

export function resolveAnalyticsImportFilePath(ownerId: string, filePath: string) {
  const ownerRoot = resolve(join(IMPORT_ROOT, ownerId));
  const target = resolve(filePath);
  const pathInsideOwner = relative(ownerRoot, target);
  if (!pathInsideOwner || pathInsideOwner.startsWith("..") || isAbsolute(pathInsideOwner)) {
    throw new Error("利润表源文件路径异常，已拒绝删除");
  }
  return target;
}

export async function deleteAnalyticsImport(importId: string, user: { id: string; role: "admin" | "user" }) {
  const db = getDb();
  const [batch] = await db.select().from(analyticsImports).where(eq(analyticsImports.id, importId)).limit(1);
  if (!batch || (user.role !== "admin" && batch.ownerId !== user.id)) throw new Error("利润表批次不存在或无权删除");
  if (batch.status === "queued" || batch.status === "processing") throw new Error("该利润表正在处理，处理结束后再删除");

  const completed = await db.select().from(analyticsImports)
    .where(and(eq(analyticsImports.ownerId, batch.ownerId), eq(analyticsImports.status, "completed")))
    .orderBy(desc(analyticsImports.committedAt), desc(analyticsImports.createdAt));
  const wasCurrent = completed[0]?.id === batch.id;
  const fallback = wasCurrent ? completed.find((item) => item.id !== batch.id) ?? null : completed[0] ?? null;
  const sourcePath = resolveAnalyticsImportFilePath(batch.ownerId, batch.filePath);

  await rm(sourcePath, { force: true });
  await writeAnalyticsAudit({
    actorId: user.id,
    ownerId: batch.ownerId,
    importId: batch.id,
    action: "analytics.import.deleted",
    detail: {
      deletedImportId: batch.id,
      fileName: batch.fileName,
      previousStatus: batch.status,
      wasCurrent,
      fallbackImportId: fallback?.id ?? null,
      fallbackFileName: fallback?.fileName ?? null,
    },
  });
  await clearAnalyticsImportData(batch.id);
  await db.delete(analyticsImports).where(eq(analyticsImports.id, batch.id));
  invalidateAnalyticsDashboardCache(batch.ownerId);

  return {
    importId: batch.id,
    fileName: batch.fileName,
    wasCurrent,
    fallback: fallback ? { id: fallback.id, fileName: fallback.fileName } : null,
  };
}

function traceText(value: unknown) {
  return String(value ?? "").trim().replace(/^\t+/, "");
}

export async function getAnalyticsOrderTrace(input: {
  importId: string;
  user: { id: string; role: "admin" | "user" };
  query: string;
}) {
  const db = getDb();
  const [batch] = await db.select().from(analyticsImports).where(eq(analyticsImports.id, input.importId)).limit(1);
  if (!batch || (input.user.role !== "admin" && batch.ownerId !== input.user.id)) throw new Error("利润表批次不存在或无权追溯");
  const query = input.query.trim().toLowerCase();
  if (query.length < 2) throw new Error("请输入至少 2 个字符的订单号、商品 ID、店铺商品键或日期");
  const workbook = XLSX.read(await readFile(resolveAnalyticsImportFilePath(batch.ownerId, batch.filePath)), { type: "buffer", cellDates: true, cellFormula: false });
  const sheetName = workbook.SheetNames.find((name) => name.replace(/\s+/g, "") === "订单明细修改");
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet?.["!ref"]) throw new Error("原始订单工作表不可读取");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const rows: Array<Record<string, unknown>> = [];
  for (let row = 3; row <= range.e.r + 1 && rows.length < 100; row += 1) {
    const searchable = ["B", "C", "G", "BW", "CC", "CD", "A", "D"].map((column) => traceText(sheet[`${column}${row}`]?.v)).join(" ").toLowerCase();
    if (!searchable.includes(query)) continue;
    const amount = Number(sheet[`J${row}`]?.v) || 0;
    rows.push({
      sourceRow: row,
      storeName: traceText(sheet[`A${row}`]?.v),
      mainOrderId: traceText(sheet[`B${row}`]?.v),
      subOrderId: traceText(sheet[`C${row}`]?.v),
      productName: traceText(sheet[`D${row}`]?.v),
      productId: traceText(sheet[`BW${row}`]?.v) || traceText(sheet[`G${row}`]?.v),
      storeProductKey: traceText(sheet[`CC${row}`]?.v),
      metricDate: traceText(sheet[`CD${row}`]?.v),
      orderAmount: amount,
      orderStatus: traceText(sheet[`AK${row}`]?.v),
      aftersaleStatus: traceText(sheet[`AR${row}`]?.v),
      shippedAt: traceText(sheet[`BE${row}`]?.v),
      productCost: typeof sheet[`BY${row}`]?.v === "number" ? sheet[`BY${row}`]?.v : null,
      businessOwner: traceText(sheet[`BZ${row}`]?.v),
      isFakeOrder: Boolean(traceText(sheet[`AH${row}`]?.v)) && amount < 20,
    });
  }
  await writeAnalyticsAudit({ actorId: input.user.id, ownerId: batch.ownerId, importId: input.importId, action: "analytics.trace.searched", detail: { query, resultCount: rows.length } });
  return { importId: input.importId, fileName: batch.fileName, query: input.query.trim(), resultCount: rows.length, truncated: rows.length >= 100, rows };
}

export async function getAnalyticsAuditLog(user: { id: string; role: "admin" | "user" }, limit = 100) {
  if (user.role !== "admin") throw new Error("仅管理员可查看经营审计日志");
  const db = getDb();
  const logs = await db.select().from(analyticsAuditLogs).orderBy(desc(analyticsAuditLogs.createdAt)).limit(Math.min(Math.max(limit, 1), 500));
  const actorIds = [...new Set(logs.flatMap((item) => [item.actorId, item.ownerId]).filter((id): id is string => Boolean(id)))];
  const users = actorIds.length ? await db.select({ id: authUsers.id, username: authUsers.username, accountId: authUsers.accountId }).from(authUsers).where(inArray(authUsers.id, actorIds)) : [];
  const usersById = new Map(users.map((item) => [item.id, item]));
  return logs.map((item) => ({
    ...item,
    actor: item.actorId ? usersById.get(item.actorId) ?? null : null,
    owner: item.ownerId ? usersById.get(item.ownerId) ?? null : null,
    createdAt: item.createdAt?.toISOString() ?? null,
  }));
}

export async function resolveAnalyticsOwnerIds(user: { id: string; role: "admin" | "user" }, requestedOwnerId?: string | null) {
  if (user.role !== "admin") return [user.id];
  if (requestedOwnerId && requestedOwnerId !== "all") {
    const [target] = await getDb().select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, requestedOwnerId)).limit(1);
    if (!target) throw new Error("目标用户不存在");
    return [target.id];
  }
  if (requestedOwnerId === "all") {
    const users = await getDb().select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.disabled, false)).orderBy(asc(authUsers.accountId));
    return users.map((item) => item.id);
  }
  return [user.id];
}

async function latestCompletedImports(ownerIds: string[]) {
  if (!ownerIds.length) return [];
  const rows = await getDb().select().from(analyticsImports)
    .where(and(inArray(analyticsImports.ownerId, ownerIds), eq(analyticsImports.status, "completed")))
    .orderBy(desc(analyticsImports.committedAt), desc(analyticsImports.createdAt));
  const selected = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!selected.has(row.ownerId)) selected.set(row.ownerId, row);
  return [...selected.values()];
}

async function analyticsImportHistory(ownerIds: string[]) {
  if (!ownerIds.length) return [];
  return getDb().select().from(analyticsImports)
    .where(inArray(analyticsImports.ownerId, ownerIds))
    .orderBy(desc(analyticsImports.createdAt));
}

function sum<T>(rows: T[], getter: (row: T) => number) {
  return rows.reduce((total, row) => total + (Number.isFinite(getter(row)) ? getter(row) : 0), 0);
}

function sumMoney<T>(rows: T[], getter: (row: T) => number) {
  return rows.reduce((total, row) => total + Math.round((Number.isFinite(getter(row)) ? getter(row) : 0) * 1_000_000), 0) / 1_000_000;
}

function addMoney(left: number, right: number) {
  return (Math.round(left * 1_000_000) + Math.round(right * 1_000_000)) / 1_000_000;
}

function effectiveOrderAmount(gmv: number, paidOrders: number, fakeOrders: number) {
  if (!Number.isFinite(gmv) || gmv <= 0 || paidOrders <= 0) return 0;
  const nonFakeOrders = Math.max(0, paidOrders - fakeOrders);
  if (nonFakeOrders <= 0) return 0;
  const average = gmv / paidOrders;
  if (gmv <= 5 || average <= 5) return 0;
  return addMoney(gmv * (nonFakeOrders / paidOrders), 0);
}

function productDecision(product: ParsedProductMetric, hasIssue: boolean): { decision: AnalyticsDecision; reasons: string[] } {
  const reasons: string[] = [];
  const fakeOrderRate = product.paidOrders > 0 ? product.fakeOrders / product.paidOrders : 0;
  if (hasIssue || product.cost === null || product.price === null || !product.profitAvailable) {
    reasons.push("成本、售价或数据映射不完整");
    return { decision: "data_issue", reasons };
  }
  if (product.actualProfit < 0 && product.roi >= 3) {
    reasons.push(`ROI ${product.roi.toFixed(2)} 但 Excel 商品利润为负`);
    if (product.signRate < 0.8) reasons.push("签收率低于 80%");
    return { decision: "high_roi_loss", reasons };
  }
  if (product.actualProfit < 0) {
    reasons.push("Excel 商品利润为负");
    if (product.adSpend > 300) reasons.push("已产生明显投放消耗");
    return { decision: "review", reasons };
  }
  if (product.actualProfit > 0 && product.profitMargin >= 0.1 && product.nonFakeOrders >= 20 && product.netShippingRate >= 0.9 && product.signRate >= 0.8 && fakeOrderRate < 0.3) {
    reasons.push("利润、样本量和履约指标同时达标");
    return { decision: "scale", reasons };
  }
  if (product.actualProfit > 0 && (product.netShippingRate < 0.9 || product.signRate < 0.8 || product.oneHourRefundRate >= 0.15 || fakeOrderRate >= 0.3)) {
    if (product.netShippingRate < 0.9) reasons.push("净成交发货率低于 90%");
    if (product.signRate < 0.8) reasons.push("签收率低于 80%");
    if (product.oneHourRefundRate >= 0.15) reasons.push("1H 退款率偏高");
    if (fakeOrderRate >= 0.3) reasons.push("刷单占比较高");
    return { decision: "optimize", reasons };
  }
  reasons.push(product.actualProfit > 0 ? "Excel 原表显示当前周期保持盈利" : "样本不足，继续观察");
  return { decision: "stable", reasons };
}

function aggregateProductRows(rows: Array<typeof analyticsProductMetrics.$inferSelect>) {
  const groups = new Map<string, Array<typeof analyticsProductMetrics.$inferSelect>>();
  for (const row of rows) {
    const key = `${row.ownerId}:${row.storeProductKey}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map((items): ParsedProductMetric & { ownerId: string } => {
    const first = items[0];
    const submittedOrders = sum(items, (row) => row.submittedOrders);
    const oneHourRefundOrders = sum(items, (row) => row.oneHourRefundOrders);
    const paidOrders = sum(items, (row) => row.paidOrders);
    const preShipRefundOrders = sum(items, (row) => row.preShipRefundOrders);
    const shippedOrders = sum(items, (row) => row.shippedOrders);
    const pendingOrders = sum(items, (row) => row.pendingOrders);
    const postShipRefundOrders = sum(items, (row) => row.postShipRefundOrders);
    const fakeOrders = sum(items, (row) => row.fakeOrders);
    const nonFakeOrders = Math.max(0, paidOrders - fakeOrders);
    const adSpend = sumMoney(items, (row) => row.adSpend);
    const gmv = sumMoney(items, (row) => row.gmv);
    const effectiveGmv = sumMoney(items, (row) => effectiveOrderAmount(row.gmv, row.paidOrders, row.fakeOrders));
    const compensation = sumMoney(items, (row) => row.compensation);
    const price = items.reduce<number | null>((current, row) => Math.max(current ?? 0, row.price ?? 0) || null, null);
    const cost = items.reduce<number | null>((current, row) => Math.max(current ?? 0, row.cost ?? 0) || null, null);
    const oneHourRefundRate = nonFakeOrders > 0 ? oneHourRefundOrders / nonFakeOrders : 0;
    const netShippingRate = nonFakeOrders > oneHourRefundOrders
      ? (paidOrders - preShipRefundOrders) / (nonFakeOrders - oneHourRefundOrders)
      : 0;
    const overallShippingRate = nonFakeOrders > 0
      ? 1 - (preShipRefundOrders - fakeOrders) / nonFakeOrders
      : 0;
    const signRateDenominator = shippedOrders + pendingOrders;
    const signRate = signRateDenominator > 0 ? 1 - postShipRefundOrders / signRateDenominator : 0;
    const profitAvailable = items.every((row) => row.profitAvailable !== false);
    const actualProfit = profitAvailable ? sumMoney(items, (row) => row.actualProfit) : 0;
    return {
      ownerId: first.ownerId,
      storeProductKey: first.storeProductKey,
      metricDate: null,
      isSummary: true,
      businessOwner: first.businessOwner,
      storeName: first.storeName,
      productId: first.productId,
      planId: first.planId,
      productName: first.productName,
      categoryName: categoryFor(first),
      submittedOrders,
      oneHourRefundOrders,
      paidOrders,
      preShipRefundOrders,
      shippedOrders,
      pendingOrders,
      postShipRefundOrders,
      fakeOrders,
      price,
      cost,
      nonFakeOrders,
      gmv,
      adSpend,
      compensation,
      roi: adSpend > 0 ? gmv / adSpend : 0,
      compensationRoi: adSpend > compensation ? gmv / (adSpend - compensation) : 0,
      profitMargin: profitAvailable && gmv > 0 ? actualProfit / gmv : 0,
      netDealRoi: adSpend > compensation ? effectiveGmv * (1 - oneHourRefundRate) / (adSpend - compensation) : 0,
      actualProfit,
      profitAvailable,
      oneHourRefundRate,
      netShippingRate,
      overallShippingRate,
      signRate,
    };
  });
}

export function buildRevisionSignals(
  rows: Array<typeof analyticsProductMetrics.$inferSelect>,
  imports: Array<typeof analyticsImports.$inferSelect>,
  input: { dateFrom?: string | null; dateTo?: string | null; storeNames?: string[] },
) {
  const selectedStores = new Set(input.storeNames ?? []);
  const completedByOwner = new Map<string, Array<typeof analyticsImports.$inferSelect>>();
  for (const item of imports) {
    if (item.status !== "completed" || !item.snapshotDate) continue;
    completedByOwner.set(item.ownerId, [...(completedByOwner.get(item.ownerId) ?? []), item]);
  }

  const isChanged = (value: number) => Math.abs(value) > 0.000001;
  const rowKey = (row: typeof analyticsProductMetrics.$inferSelect) => `${row.storeName}\u0000${row.productId}\u0000${row.planId ?? ""}\u0000${row.metricDate}`;
  const revisions: RevisionSignal[] = [];

  for (const [ownerId, ownerImports] of completedByOwner) {
    const orderedImports = [...ownerImports].sort((left, right) => {
      const leftTime = (left.committedAt ?? left.createdAt)?.getTime() ?? 0;
      const rightTime = (right.committedAt ?? right.createdAt)?.getTime() ?? 0;
      return rightTime - leftTime || right.id.localeCompare(left.id);
    });
    const currentImport = orderedImports[0];
    const previousImport = orderedImports[1];
    if (!currentImport?.snapshotDate || !previousImport?.snapshotDate) continue;

    const previousRows = new Map<string, typeof analyticsProductMetrics.$inferSelect>();
    for (const row of rows) {
      if (row.importId !== previousImport.id || row.isSummary || !row.metricDate) continue;
      previousRows.set(rowKey(row), row);
    }

    for (const current of rows) {
      if (current.importId !== currentImport.id || current.isSummary || !current.metricDate) continue;
      if (input.dateFrom && current.metricDate < input.dateFrom) continue;
      if (input.dateTo && current.metricDate > input.dateTo) continue;
      if (selectedStores.size && !selectedStores.has(current.storeName)) continue;
      const previous = previousRows.get(rowKey(current));
      if (!previous) continue;

      const roiChange = current.roi - previous.roi;
      const netDealRoiChange = current.netDealRoi - previous.netDealRoi;
      const paidOrdersChange = current.paidOrders - previous.paidOrders;
      const overallShippingRateChange = current.overallShippingRate - previous.overallShippingRate;
      const netShippingRateChange = current.netShippingRate - previous.netShippingRate;
      const signRateChange = current.signRate - previous.signRate;
      const profitMarginChange = current.profitMargin - previous.profitMargin;
      const actualProfitChange = current.actualProfit - previous.actualProfit;
      const gmvChange = current.gmv - previous.gmv;
      const adSpendChange = current.adSpend - previous.adSpend;
      const oneHourRefundRateChange = current.oneHourRefundRate - previous.oneHourRefundRate;
      if (![roiChange, netDealRoiChange, paidOrdersChange, overallShippingRateChange, netShippingRateChange, signRateChange, profitMarginChange, actualProfitChange, gmvChange, adSpendChange, oneHourRefundRateChange].some(isChanged)) continue;

      revisions.push({
        key: `${ownerId}:${rowKey(current)}`,
        ownerId,
        storeName: current.storeName,
        productId: current.productId,
        planId: current.planId ?? previous.planId,
        categoryName: categoryFor(current),
        metricDate: current.metricDate,
        previousSnapshotDate: previousImport.snapshotDate,
        currentSnapshotDate: currentImport.snapshotDate,
        previousRoi: previous.roi,
        currentRoi: current.roi,
        previousNetDealRoi: previous.netDealRoi,
        currentNetDealRoi: current.netDealRoi,
        previousPaidOrders: previous.paidOrders,
        currentPaidOrders: current.paidOrders,
        previousOverallShippingRate: previous.overallShippingRate,
        currentOverallShippingRate: current.overallShippingRate,
        previousNetShippingRate: previous.netShippingRate,
        currentNetShippingRate: current.netShippingRate,
        previousSignRate: previous.signRate,
        currentSignRate: current.signRate,
        previousProfitMargin: previous.profitMargin,
        currentProfitMargin: current.profitMargin,
        previousActualProfit: previous.actualProfit,
        currentActualProfit: current.actualProfit,
        previousGmv: previous.gmv,
        currentGmv: current.gmv,
        previousAdSpend: previous.adSpend,
        currentAdSpend: current.adSpend,
        previousOneHourRefundRate: previous.oneHourRefundRate,
        currentOneHourRefundRate: current.oneHourRefundRate,
        roiChange,
        netDealRoiChange,
        paidOrdersChange,
        overallShippingRateChange,
        netShippingRateChange,
        signRateChange,
        profitMarginChange,
        actualProfitChange,
        gmvChange,
        adSpendChange,
        oneHourRefundRateChange,
        shippingDeclined: netShippingRateChange < -0.000001,
        signDeclined: signRateChange < -0.000001,
        profitDeclined: actualProfitChange < -0.000001,
        refundIncreased: oneHourRefundRateChange > 0.000001,
      });
    }
  }

  return revisions.sort((left, right) => right.metricDate.localeCompare(left.metricDate) || Math.abs(right.actualProfitChange) - Math.abs(left.actualProfitChange) || left.storeName.localeCompare(right.storeName, "zh-CN") || left.productId.localeCompare(right.productId));
}

type VersionPair = {
  ownerId: string;
  baseline: typeof analyticsImports.$inferSelect;
  target: typeof analyticsImports.$inferSelect;
};

function importVersionTime(item: typeof analyticsImports.$inferSelect) {
  return (item.committedAt ?? item.createdAt)?.getTime() ?? 0;
}

function versionImportSummary(item: typeof analyticsImports.$inferSelect): VersionImportSummary {
  return {
    id: item.id,
    ownerId: item.ownerId,
    fileName: item.fileName,
    snapshotDate: item.snapshotDate,
    committedAt: item.committedAt?.toISOString() ?? item.createdAt?.toISOString() ?? null,
    periodStart: item.periodStart,
    periodEnd: item.periodEnd,
    productPeriodStart: item.productPeriodStart,
    productPeriodEnd: item.productPeriodEnd,
  };
}

function resolveVersionPairs(
  imports: Array<typeof analyticsImports.$inferSelect>,
  input: { baselineImportId?: string | null; targetImportId?: string | null },
): { mode: VersionComparison["mode"]; pairs: VersionPair[] } {
  const completed = imports.filter((item) => item.status === "completed" && item.snapshotDate);
  const baselineImportId = input.baselineImportId?.trim() || null;
  const targetImportId = input.targetImportId?.trim() || null;
  if (Boolean(baselineImportId) !== Boolean(targetImportId)) {
    throw new Error("版本对比需要同时选择两份正式利润表");
  }
  if (baselineImportId && targetImportId) {
    if (baselineImportId === targetImportId) throw new Error("请分别选择两份不同的正式利润表");
    const baselineCandidate = completed.find((item) => item.id === baselineImportId);
    const targetCandidate = completed.find((item) => item.id === targetImportId);
    if (!baselineCandidate || !targetCandidate) throw new Error("所选利润表不存在、未正式导入或不在当前账户范围");
    if (baselineCandidate.ownerId !== targetCandidate.ownerId) throw new Error("版本对比只能在同一账户的利润表之间进行");
    const [baseline, target] = [baselineCandidate, targetCandidate].sort((left, right) => importVersionTime(left) - importVersionTime(right) || left.id.localeCompare(right.id));
    return { mode: "custom", pairs: [{ ownerId: baseline.ownerId, baseline, target }] };
  }

  const byOwner = new Map<string, Array<typeof analyticsImports.$inferSelect>>();
  for (const item of completed) byOwner.set(item.ownerId, [...(byOwner.get(item.ownerId) ?? []), item]);
  const pairs = [...byOwner.entries()].flatMap(([ownerId, ownerImports]) => {
    const ordered = [...ownerImports].sort((left, right) => importVersionTime(right) - importVersionTime(left) || right.id.localeCompare(left.id));
    return ordered.length >= 2 ? [{ ownerId, baseline: ordered[1], target: ordered[0] }] : [];
  });
  return { mode: pairs.length > 1 ? "per_owner" : "adjacent", pairs };
}

function versionRowKey(row: typeof analyticsProductMetrics.$inferSelect) {
  return `${row.ownerId}\u0000${row.storeName}\u0000${row.productId}\u0000${row.planId ?? ""}\u0000${row.metricDate}`;
}

function versionRowsForImport(
  rows: Array<typeof analyticsProductMetrics.$inferSelect>,
  importId: string,
  input: { dateFrom?: string | null; dateTo?: string | null; storeNames?: string[] },
) {
  const selectedStores = new Set(input.storeNames ?? []);
  return rows.filter((row) => {
    if (row.importId !== importId || row.isSummary || !row.metricDate) return false;
    if (input.dateFrom && row.metricDate < input.dateFrom) return false;
    if (input.dateTo && row.metricDate > input.dateTo) return false;
    if (selectedStores.size && !selectedStores.has(row.storeName)) return false;
    return true;
  });
}

function versionRowChanged(previous: typeof analyticsProductMetrics.$inferSelect, current: typeof analyticsProductMetrics.$inferSelect) {
  return [
    current.roi - previous.roi,
    current.netDealRoi - previous.netDealRoi,
    current.paidOrders - previous.paidOrders,
    current.overallShippingRate - previous.overallShippingRate,
    current.netShippingRate - previous.netShippingRate,
    current.signRate - previous.signRate,
    current.profitMargin - previous.profitMargin,
    current.actualProfit - previous.actualProfit,
    current.gmv - previous.gmv,
    current.adSpend - previous.adSpend,
    current.oneHourRefundRate - previous.oneHourRefundRate,
  ].some((value) => Math.abs(value) > 0.000001);
}

function emptyVersionComparison(mode: VersionComparison["mode"], message: string | null): VersionComparison {
  return {
    available: false,
    mode,
    baseline: null,
    target: null,
    pairs: [],
    summary: {
      overlapRows: 0,
      changedRows: 0,
      unchangedRows: 0,
      addedRows: 0,
      missingRows: 0,
      addedBusinessDates: [],
      missingBusinessDates: [],
      previousGmv: 0,
      currentGmv: 0,
      previousAdSpend: 0,
      currentAdSpend: 0,
      previousActualProfit: 0,
      currentActualProfit: 0,
      addedGmv: 0,
      addedAdSpend: 0,
      addedActualProfit: 0,
    },
    message,
  };
}

export function buildVersionComparison(
  rows: Array<typeof analyticsProductMetrics.$inferSelect>,
  pairs: VersionPair[],
  mode: VersionComparison["mode"],
  input: { dateFrom?: string | null; dateTo?: string | null; storeNames?: string[] },
) {
  if (!pairs.length) return { comparison: emptyVersionComparison(mode, "至少需要两份正式利润表，才能建立版本对比。"), revisionSignals: [] as RevisionSignal[] };

  const comparison = emptyVersionComparison(mode, null);
  comparison.available = true;
  comparison.pairs = pairs.map((pair) => ({ ownerId: pair.ownerId, baseline: versionImportSummary(pair.baseline), target: versionImportSummary(pair.target) }));
  if (pairs.length === 1) {
    comparison.baseline = comparison.pairs[0].baseline;
    comparison.target = comparison.pairs[0].target;
  }

  const revisionSignals: RevisionSignal[] = [];
  const addedDates = new Set<string>();
  const missingDates = new Set<string>();
  for (const pair of pairs) {
    const previousRows = versionRowsForImport(rows, pair.baseline.id, input);
    const currentRows = versionRowsForImport(rows, pair.target.id, input);
    const previousByKey = new Map(previousRows.map((row) => [versionRowKey(row), row]));
    const currentKeys = new Set(currentRows.map(versionRowKey));
    const previousDates = new Set(previousRows.map((row) => row.metricDate!));
    const currentDates = new Set(currentRows.map((row) => row.metricDate!));

    revisionSignals.push(...buildRevisionSignals([...previousRows, ...currentRows], [pair.baseline, pair.target], input));
    for (const current of currentRows) {
      const previous = previousByKey.get(versionRowKey(current));
      if (!previous) {
        comparison.summary.addedRows += 1;
        comparison.summary.addedGmv += current.gmv;
        comparison.summary.addedAdSpend += current.adSpend;
        comparison.summary.addedActualProfit += current.actualProfit;
        if (!previousDates.has(current.metricDate!)) addedDates.add(current.metricDate!);
        continue;
      }
      comparison.summary.overlapRows += 1;
      comparison.summary.previousGmv += previous.gmv;
      comparison.summary.currentGmv += current.gmv;
      comparison.summary.previousAdSpend += previous.adSpend;
      comparison.summary.currentAdSpend += current.adSpend;
      comparison.summary.previousActualProfit += previous.actualProfit;
      comparison.summary.currentActualProfit += current.actualProfit;
      if (versionRowChanged(previous, current)) comparison.summary.changedRows += 1;
      else comparison.summary.unchangedRows += 1;
    }
    for (const previous of previousRows) {
      if (currentKeys.has(versionRowKey(previous))) continue;
      comparison.summary.missingRows += 1;
      if (!currentDates.has(previous.metricDate!)) missingDates.add(previous.metricDate!);
    }
  }
  comparison.summary.addedBusinessDates = [...addedDates].sort();
  comparison.summary.missingBusinessDates = [...missingDates].sort();
  return { comparison, revisionSignals: revisionSignals.sort((left, right) => right.metricDate.localeCompare(left.metricDate) || Math.abs(right.actualProfitChange) - Math.abs(left.actualProfitChange) || left.storeName.localeCompare(right.storeName, "zh-CN") || left.productId.localeCompare(right.productId)) };
}

type AnalyticsDashboardInput = {
  ownerIds: string[];
  dateFrom?: string | null;
  dateTo?: string | null;
  storeNames?: string[];
  baselineImportId?: string | null;
  targetImportId?: string | null;
  forceRefresh?: boolean;
};

type AnalyticsDashboardCacheEntry = {
  expiresAt: number;
  ownerIds: string[];
  dashboard?: AnalyticsDashboard;
  pending?: Promise<AnalyticsDashboard>;
};

const ANALYTICS_DASHBOARD_CACHE_TTL_MS = 4_000;
const analyticsDashboardCache = new Map<string, AnalyticsDashboardCacheEntry>();

function analyticsDashboardCacheKey(input: AnalyticsDashboardInput) {
  return JSON.stringify({
    ownerIds: [...input.ownerIds].sort(),
    dateFrom: input.dateFrom ?? null,
    dateTo: input.dateTo ?? null,
    storeNames: [...(input.storeNames ?? [])].sort(),
    baselineImportId: input.baselineImportId ?? null,
    targetImportId: input.targetImportId ?? null,
  });
}

export function invalidateAnalyticsDashboardCache(ownerId?: string) {
  if (!ownerId) {
    analyticsDashboardCache.clear();
    return;
  }
  for (const [key, entry] of analyticsDashboardCache) {
    if (entry.ownerIds.includes(ownerId)) analyticsDashboardCache.delete(key);
  }
}

export async function getAnalyticsDashboard(input: AnalyticsDashboardInput): Promise<AnalyticsDashboard> {
  const key = analyticsDashboardCacheKey(input);
  if (input.forceRefresh) analyticsDashboardCache.delete(key);
  const cached = analyticsDashboardCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.dashboard) return cached.dashboard;
    if (cached.pending) return cached.pending;
  }

  const pending = buildAnalyticsDashboard(input);
  analyticsDashboardCache.set(key, {
    expiresAt: Date.now() + ANALYTICS_DASHBOARD_CACHE_TTL_MS,
    ownerIds: [...input.ownerIds],
    pending,
  });
  try {
    const dashboard = await pending;
    analyticsDashboardCache.set(key, {
      expiresAt: Date.now() + ANALYTICS_DASHBOARD_CACHE_TTL_MS,
      ownerIds: [...input.ownerIds],
      dashboard,
    });
    return dashboard;
  } catch (error) {
    analyticsDashboardCache.delete(key);
    throw error;
  }
}

async function buildAnalyticsDashboard(input: AnalyticsDashboardInput): Promise<AnalyticsDashboard> {
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw new Error("开始日期不能晚于结束日期");
  const db = getDb();
  const [latestImports, rawHistoryRows] = await Promise.all([
    latestCompletedImports(input.ownerIds),
    analyticsImportHistory(input.ownerIds),
  ]);
  const imports = latestImports;
  const historyRows = rawHistoryRows;
  const importIds = imports.map((item) => item.id);
  const userRows = input.ownerIds.length
    ? await db.select({ id: authUsers.id, username: authUsers.username, accountId: authUsers.accountId }).from(authUsers).where(inArray(authUsers.id, input.ownerIds))
    : [];
  const userMap = new Map(userRows.map((item) => [item.id, item]));
  const history: ImportHistoryItem[] = historyRows.map((item) => ({
    id: item.id,
    ownerId: item.ownerId,
    username: userMap.get(item.ownerId)?.username ?? "未知用户",
    fileName: item.fileName,
    status: item.status,
    stage: item.stage,
    progress: item.progress,
    periodStart: item.periodStart,
    periodEnd: item.periodEnd,
    productPeriodStart: item.productPeriodStart,
    productPeriodEnd: item.productPeriodEnd,
    storeCount: item.storeCount,
    productCount: item.productCount,
    registeredProductCount: item.registeredProductCount,
    issueCount: item.issueCount,
    productProfitTotal: item.productProfitTotal,
    reconciliationStatus: item.reconciliationStatus,
    snapshotDate: item.snapshotDate,
    maturityDays: item.maturityDays,
    errorMessage: item.errorMessage,
    createdAt: item.createdAt?.toISOString() ?? null,
    committedAt: item.committedAt?.toISOString() ?? null,
  }));
  const historyDiffs: ImportHistoryDiff[] = [];
  for (const ownerId of input.ownerIds) {
    const ownerHistory = historyRows.filter((item) => item.ownerId === ownerId && item.status === "completed");
    const current = ownerHistory[0];
    if (!current) continue;
    const previous = ownerHistory[1] ?? null;
    historyDiffs.push({
      ownerId,
      username: userMap.get(ownerId)?.username ?? "未知用户",
      currentImportId: current.id,
      previousImportId: previous?.id ?? null,
      profitChange: previous ? current.productProfitTotal - previous.productProfitTotal : 0,
      issueChange: previous ? current.issueCount - previous.issueCount : 0,
      storeChange: previous ? current.storeCount - previous.storeCount : 0,
      productChange: previous ? current.productCount - previous.productCount : 0,
    });
  }
  if (!importIds.length) {
    return {
      scope: userRows.map((user) => ({ ownerId: user.id, username: user.username, accountId: user.accountId, isAll: input.ownerIds.length > 1 })),
      imports: [],
      period: { start: null, end: null },
      dataWindows: { store: { start: null, end: null }, product: { start: null, end: null }, productAnalysis: { available: false, comparisonAvailable: false, message: "尚未导入商品原始数据。" } },
      kpis: { gmv: 0, adSpend: 0, actualProfit: 0, profitMargin: 0, totalRefund: 0, compensation: 0, roi: 0, netDealRoi: 0, paidOrders: 0, fakeOrders: 0, fakeOrderRate: 0, productProfitTotal: 0 },
      stores: [], products: [], issues: [], trend: [], actions: [], availableStores: [],
      comparison: { currentStart: null, currentEnd: null, previousStart: null, previousEnd: null, days: 0, hasPreviousData: false },
      revisionSignals: [],
      versionComparison: emptyVersionComparison("adjacent", "至少需要两份正式利润表，才能建立版本对比。"),
      accuracy: { status: "empty", formulaCount: 0, formulaErrorCount: 0, fixedRangeRiskCount: 0, passedChecks: 0, warningChecks: 0, failedChecks: 0 },
      sheetAudits: [], formulaAudits: [], reconciliations: [], history, historyDiffs,
      planInsights: buildPlanInsights([], [], []),
    };
  }

  const { mode: versionComparisonMode, pairs: versionPairs } = resolveVersionPairs(historyRows, input);
  const snapshotImportIds = [...new Set(versionPairs.flatMap((pair) => [pair.baseline.id, pair.target.id]))];
  const previousImportIds = [...new Set(input.ownerIds.flatMap((ownerId) => historyRows.filter((item) => item.ownerId === ownerId && item.status === "completed").slice(1, 2).map((item) => item.id)))];
  const [allStoreRows, allProductRows, allIssues, sheetAudits, formulaAudits, reconciliations, allPlanRows, previousPlanRows, snapshotProductRows] = await Promise.all([
    db.select().from(analyticsStoreDaily).where(inArray(analyticsStoreDaily.importId, importIds)),
    db.select().from(analyticsProductMetrics).where(inArray(analyticsProductMetrics.importId, importIds)),
    db.select().from(analyticsDataIssues).where(inArray(analyticsDataIssues.importId, importIds)),
    db.select().from(analyticsSheetAudits).where(inArray(analyticsSheetAudits.importId, importIds)),
    db.select().from(analyticsFormulaAudits).where(inArray(analyticsFormulaAudits.importId, importIds)),
    db.select().from(analyticsReconciliations).where(inArray(analyticsReconciliations.importId, importIds)),
    db.select().from(analyticsPlanDaily).where(inArray(analyticsPlanDaily.importId, importIds)),
    previousImportIds.length ? db.select().from(analyticsPlanDaily).where(inArray(analyticsPlanDaily.importId, previousImportIds)) : Promise.resolve([]),
    snapshotImportIds.length ? db.select().from(analyticsProductMetrics).where(inArray(analyticsProductMetrics.importId, snapshotImportIds)) : Promise.resolve([]),
  ]);
  const availableDates = allStoreRows.map((row) => row.metricDate).sort();
  const productRanges = input.ownerIds.flatMap((ownerId) => {
    const dates = allProductRows.filter((row) => row.ownerId === ownerId && !row.isSummary && row.metricDate).map((row) => row.metricDate!).sort();
    return dates.length ? [{ start: dates[0], end: dates.at(-1)! }] : [];
  });
  const productPeriodStart = productRanges.length === input.ownerIds.length ? productRanges.map((range) => range.start).sort().at(-1) ?? null : null;
  const productPeriodEnd = productRanges.length === input.ownerIds.length ? productRanges.map((range) => range.end).sort()[0] ?? null : null;
  const hasCommonProductPeriod = Boolean(productPeriodStart && productPeriodEnd && productPeriodStart <= productPeriodEnd);
  const currentStart = input.dateFrom ?? availableDates[0] ?? null;
  const currentEnd = input.dateTo ?? availableDates.at(-1) ?? null;
  const comparisonDays = currentStart && currentEnd ? dateDistance(currentEnd, currentStart) + 1 : 0;
  const previousEnd = currentStart && comparisonDays ? dateShift(currentStart, -1) : null;
  const previousStart = previousEnd && comparisonDays ? dateShift(previousEnd, -(comparisonDays - 1)) : null;
  const dateMatches = (date: string) => (!currentStart || date >= currentStart) && (!currentEnd || date <= currentEnd);
  const previousDateMatches = (date: string) => Boolean(previousStart && previousEnd && date >= previousStart && date <= previousEnd);
  const selectedStoreNames = new Set(input.storeNames ?? []);
  const storeMatches = (storeName: string) => !selectedStoreNames.size || selectedStoreNames.has(storeName);
  const storeRows = allStoreRows.filter((row) => dateMatches(row.metricDate) && storeMatches(row.storeName));
  const previousStoreRows = allStoreRows.filter((row) => previousDateMatches(row.metricDate) && storeMatches(row.storeName));
  const isCustomPeriod = Boolean(input.dateFrom || input.dateTo);
  const productAnalysisAvailable = !isCustomPeriod
    ? hasCommonProductPeriod
    : Boolean(hasCommonProductPeriod && currentStart && currentEnd && currentStart >= productPeriodStart! && currentEnd <= productPeriodEnd!);
  const productComparisonAvailable = Boolean(productAnalysisAvailable && isCustomPeriod && previousStart && previousEnd && previousStart >= productPeriodStart! && previousEnd <= productPeriodEnd!);
  const selectedProducts = productAnalysisAvailable
    ? aggregateProductRows(allProductRows.filter((row) => !row.isSummary && row.metricDate && dateMatches(row.metricDate) && storeMatches(row.storeName)))
    : [];
  const previousProducts = productComparisonAvailable
    ? aggregateProductRows(allProductRows.filter((row) => !row.isSummary && row.metricDate && previousDateMatches(row.metricDate) && storeMatches(row.storeName)))
    : [];
  const previousProductMap = new Map(previousProducts.map((product) => [`${product.ownerId}:${product.storeProductKey}`, product]));
  const latestMetricDateByProductKey = new Map<string, string>();
  for (const row of allProductRows) {
    if (row.isSummary || !row.metricDate || !dateMatches(row.metricDate) || !storeMatches(row.storeName)) continue;
    const key = `${row.ownerId}:${row.storeProductKey}`;
    if (!latestMetricDateByProductKey.has(key) || row.metricDate > (latestMetricDateByProductKey.get(key) ?? "")) {
      latestMetricDateByProductKey.set(key, row.metricDate);
    }
  }
  const storeCategoryGroups = new Map<string, typeof selectedProducts>();
  const globalCategoryGroups = new Map<string, typeof selectedProducts>();
  for (const product of selectedProducts) {
    const category = categoryFor(product);
    const storeKey = `${product.ownerId}:${product.storeName}:${category}`;
    const globalKey = `${product.ownerId}:${category}`;
    const storeCategoryGroup = storeCategoryGroups.get(storeKey);
    if (storeCategoryGroup) storeCategoryGroup.push(product);
    else storeCategoryGroups.set(storeKey, [product]);
    const globalCategoryGroup = globalCategoryGroups.get(globalKey);
    if (globalCategoryGroup) globalCategoryGroup.push(product);
    else globalCategoryGroups.set(globalKey, [product]);
  }
  const issueKeys = new Set(allIssues.filter((issue) => issue.scope === "product" && issue.entityKey).map((issue) => `${issue.ownerId}:${issue.entityKey}`));
  const importByOwner = new Map(imports.map((item) => [item.ownerId, item]));
  const products: ProductSummary[] = selectedProducts.map((product) => {
    const user = userMap.get(product.ownerId);
    const decision = productDecision(product, issueKeys.has(`${product.ownerId}:${product.storeProductKey}`));
    const key = `${product.ownerId}:${product.storeProductKey}`;
    const previous = previousProductMap.get(key);
    const category = categoryFor(product);
    const storeBenchmarks = storeCategoryGroups.get(`${product.ownerId}:${product.storeName}:${category}`) ?? [];
    const globalBenchmarks = globalCategoryGroups.get(`${product.ownerId}:${category}`) ?? [];
    const ownerImport = importByOwner.get(product.ownerId);
    const productMaturityDate = isCustomPeriod ? currentEnd : productPeriodEnd;
    const productMaturity = maturityFor(productMaturityDate ?? ownerImport?.productPeriodEnd ?? ownerImport?.periodEnd ?? currentShanghaiDate(), ownerImport?.snapshotDate ?? null, ownerImport?.maturityDays ?? 6);
    const reasons = [...decision.reasons];
    if (productMaturity.maturity !== "stable") reasons.unshift(productMaturity.maturity === "observing" ? "当前周期仍在观察期，结论仅用于复核" : "当前周期数据趋于稳定，仍需结合后续快照复核");
    return {
      ...product,
      categoryName: category,
      key,
      username: user?.username ?? "未知用户",
      accountId: user?.accountId ?? "--",
      decision: decision.decision,
      reasons,
      fakeOrderRate: product.paidOrders > 0 ? product.fakeOrders / product.paidOrders : 0,
      previousGmv: previous?.gmv ?? 0,
      hasPreviousData: Boolean(previous),
      previousAdSpend: previous?.adSpend ?? 0,
      previousActualProfit: previous?.actualProfit ?? 0,
      previousNetShippingRate: previous?.netShippingRate ?? 0,
      previousSignRate: previous?.signRate ?? 0,
      gmvChange: previous ? product.gmv - previous.gmv : 0,
      adSpendChange: previous ? product.adSpend - previous.adSpend : 0,
      profitChange: previous ? product.actualProfit - previous.actualProfit : 0,
      netShippingRateChange: previous ? product.netShippingRate - previous.netShippingRate : 0,
      signRateChange: previous ? product.signRate - previous.signRate : 0,
      storeCategoryNetShippingMedian: median(storeBenchmarks.map((item) => item.netShippingRate)),
      storeCategorySignMedian: median(storeBenchmarks.map((item) => item.signRate)),
      globalCategoryNetShippingMedian: median(globalBenchmarks.map((item) => item.netShippingRate)),
      globalCategorySignMedian: median(globalBenchmarks.map((item) => item.signRate)),
      maturity: productMaturity.maturity,
      maturityAgeDays: productMaturity.ageDays,
      latestMetricDate: latestMetricDateByProductKey.get(key) ?? null,
    };
  }).sort((a, b) => a.profitChange - b.profitChange || a.actualProfit - b.actualProfit);

  const selectedPlanRows = allPlanRows.filter((row) => dateMatches(row.metricDate) && storeMatches(row.storeName));
  const planRowsByStore = new Map<string, typeof selectedPlanRows>();
  for (const row of selectedPlanRows) {
    const key = row.ownerId + ":" + row.storeName;
    const group = planRowsByStore.get(key);
    if (group) group.push(row);
    else planRowsByStore.set(key, [row]);
  }
  const storeIssueMessages = new Map<string, string[]>();
  for (const issue of allIssues) {
    if (issue.scope !== "store" || issue.issueType === "store_gmv_gap" || issue.issueType === "store_gmv_variance" || !issue.entityKey) continue;
    const separator = issue.entityKey.indexOf(":");
    const storeName = separator >= 0 ? issue.entityKey.slice(separator + 1) : issue.entityKey;
    const key = issue.ownerId + ":" + storeName;
    storeIssueMessages.set(key, [...(storeIssueMessages.get(key) ?? []), issue.message]);
  }
  const formulaErrorOwners = new Set(formulaAudits.filter((item) => item.hasFormulaError).map((item) => item.ownerId));
  const storeGroups = new Map<string, typeof storeRows>();
  const previousStoreGroups = new Map<string, typeof previousStoreRows>();
  const productsByStore = new Map<string, ProductSummary[]>();
  for (const product of products) {
    const key = `${product.ownerId}:${product.storeName}`;
    const productGroup = productsByStore.get(key);
    if (productGroup) productGroup.push(product);
    else productsByStore.set(key, [product]);
  }
  for (const row of storeRows) {
    const key = `${row.ownerId}:${row.storeName}`;
    const storeGroup = storeGroups.get(key);
    if (storeGroup) storeGroup.push(row);
    else storeGroups.set(key, [row]);
  }
  for (const row of previousStoreRows) {
    const key = `${row.ownerId}:${row.storeName}`;
    const previousStoreGroup = previousStoreGroups.get(key);
    if (previousStoreGroup) previousStoreGroup.push(row);
    else previousStoreGroups.set(key, [row]);
  }
  const stores: StoreSummary[] = [...storeGroups.entries()].map(([key, rows]) => {
    const first = rows[0];
    const user = userMap.get(first.ownerId);
    const gmv = sumMoney(rows, (row) => row.gmv);
    const adSpend = sumMoney(rows, (row) => row.adSpend);
    const actualProfit = sumMoney(rows, (row) => row.actualProfit);
    const compensation = sumMoney(rows, (row) => row.compensationRegistered);
    const paidOrders = sum(rows, (row) => row.paidOrders);
    const fakeOrders = sum(rows, (row) => row.fakeOrders);
    const gmvGap = sumMoney(rows, (row) => row.gmvGap);
    const storePlanRows = planRowsByStore.get(key) ?? [];
    const accountGroups = new Map<string, {
      accountId: string;
      accountName: string;
      spend: number;
      netAmount: number;
      netOrders: number;
      planIds: Set<string>;
    }>();
    for (const row of storePlanRows) {
      const accountId = row.accountId || "未匹配账户";
      const current = accountGroups.get(accountId) ?? {
        accountId,
        accountName: row.accountName || row.accountShortName || accountId,
        spend: 0,
        netAmount: 0,
        netOrders: 0,
        planIds: new Set<string>(),
      };
      current.spend = addMoney(current.spend, row.spend);
      current.netAmount = addMoney(current.netAmount, row.netAmount);
      current.netOrders += row.netOrders;
      if (row.planId) current.planIds.add(row.planId);
      accountGroups.set(accountId, current);
    }
    const qianchuanAccounts = [...accountGroups.values()]
      .map((account) => ({
        accountId: account.accountId,
        accountName: account.accountName,
        spend: account.spend,
        netAmount: account.netAmount,
        netOrders: account.netOrders,
        planCount: account.planIds.size,
      }))
      .sort((left, right) => right.netAmount - left.netAmount || right.spend - left.spend);
    const qianchuanGmv = sumMoney(qianchuanAccounts, (account) => account.netAmount);
    const dataIssueReasons = [...(storeIssueMessages.get(key) ?? [])];
    if (formulaErrorOwners.has(first.ownerId)) dataIssueReasons.push("当前利润表存在公式错误，店铺诊断需先完成数据核验。");
    if (adSpend > 0 && !storePlanRows.length) dataIssueReasons.push("当前周期有店铺投放消耗，但没有可归属的千川账户明细。");
    if (storePlanRows.some((row) => !row.accountId || !row.accountName || !row.accountShortName || !row.storeName)) {
      dataIssueReasons.push("存在未完整匹配千川账户对照的计划记录。");
    }
    const uniqueDataIssueReasons = [...new Set(dataIssueReasons)];
    const previousRows = previousStoreGroups.get(key) ?? [];
    const previousGmv = sumMoney(previousRows, (row) => row.gmv);
    const previousAdSpend = sumMoney(previousRows, (row) => row.adSpend);
    const previousActualProfit = sumMoney(previousRows, (row) => row.actualProfit);
    const previousTotalRefund = sumMoney(previousRows, (row) => row.totalRefundAmount);
    const totalRefund = sumMoney(rows, (row) => row.totalRefundAmount);
    const storeProducts = productsByStore.get(key) ?? [];
    const oneHourRefundOrders = sum(storeProducts, (item) => item.oneHourRefundOrders);
    const productPaidOrders = sum(storeProducts, (item) => item.paidOrders);
    const preShipRefundOrders = sum(storeProducts, (item) => item.preShipRefundOrders);
    const shippedOrders = sum(storeProducts, (item) => item.shippedOrders);
    const pendingOrders = sum(storeProducts, (item) => item.pendingOrders);
    const postShipRefundOrders = sum(storeProducts, (item) => item.postShipRefundOrders);
    const productFakeOrders = sum(storeProducts, (item) => item.fakeOrders);
    const nonFakeOrders = sum(storeProducts, (item) => item.nonFakeOrders);
    const hasProductMetrics = storeProducts.length > 0;
    const oneHourRefundRate = hasProductMetrics && nonFakeOrders > 0 ? oneHourRefundOrders / nonFakeOrders : null;
    const netShippingRate = hasProductMetrics && nonFakeOrders > oneHourRefundOrders
      ? (productPaidOrders - preShipRefundOrders) / (nonFakeOrders - oneHourRefundOrders)
      : null;
    const overallShippingRate = hasProductMetrics && nonFakeOrders > 0
      ? 1 - (preShipRefundOrders - productFakeOrders) / nonFakeOrders
      : null;
    const signRateDenominator = shippedOrders + pendingOrders;
    const signRate = hasProductMetrics && signRateDenominator > 0 ? 1 - postShipRefundOrders / signRateDenominator : null;
    const netDealRoi = hasProductMetrics && adSpend > compensation
      ? gmv * (1 - (oneHourRefundRate ?? 0)) / (adSpend - compensation)
      : 0;
    const status = classifyStoreDiagnostic({ gmv, gmvGap, actualProfit, hasDataIssue: uniqueDataIssueReasons.length > 0 });
    return {
      key, ownerId: first.ownerId, username: user?.username ?? "未知用户", storeName: first.storeName,
      gmv, adSpend, actualProfit, profitMargin: gmv > 0 ? actualProfit / gmv : 0, roi: adSpend > 0 ? gmv / adSpend : 0, netDealRoi,
      totalRefund, compensation,
      paidOrders, fakeOrders, fakeOrderRate: paidOrders > 0 ? fakeOrders / paidOrders : 0,
      oneHourRefundRate, overallShippingRate, netShippingRate, signRate, gmvGap,
      gmvGapRate: storeGmvGapRate(gmv, gmvGap),
      qianchuanGmv,
      hasGmvVariance: isStoreGmvVariance(gmv, gmvGap),
      gmvVarianceDays: topStoreGmvVarianceDays(rows),
      qianchuanAccounts,
      dataIssueReasons: uniqueDataIssueReasons,
      previousGmv, previousAdSpend, previousActualProfit, previousTotalRefund,
      hasPreviousData: previousRows.length > 0,
      gmvChange: previousRows.length ? gmv - previousGmv : 0,
      adSpendChange: previousRows.length ? adSpend - previousAdSpend : 0,
      profitChange: previousRows.length ? actualProfit - previousActualProfit : 0,
      refundChange: previousRows.length ? totalRefund - previousTotalRefund : 0,
      status,
    };
  }).sort((a, b) => a.profitChange - b.profitChange || a.actualProfit - b.actualProfit);

  const trendMap = new Map<string, AnalyticsDashboard["trend"][number]>();
  for (const row of storeRows) {
    const ownerImport = importByOwner.get(row.ownerId);
    const rowMaturity = maturityFor(row.metricDate, ownerImport?.snapshotDate ?? null, ownerImport?.maturityDays ?? 6);
    const current = trendMap.get(row.metricDate) ?? { date: row.metricDate, gmv: 0, adSpend: 0, actualProfit: 0, totalRefund: 0, compensation: 0, paidOrders: 0, maturity: rowMaturity.maturity, ageDays: rowMaturity.ageDays };
    current.gmv = addMoney(current.gmv, row.gmv);
    current.adSpend = addMoney(current.adSpend, row.adSpend);
    current.actualProfit = addMoney(current.actualProfit, row.actualProfit);
    current.totalRefund = addMoney(current.totalRefund, row.totalRefundAmount);
    current.compensation = addMoney(current.compensation, row.compensationRegistered);
    current.paidOrders += row.paidOrders;
    if (rowMaturity.ageDays < current.ageDays) {
      current.ageDays = rowMaturity.ageDays;
      current.maturity = rowMaturity.maturity;
    }
    trendMap.set(row.metricDate, current);
  }
  const gmv = sumMoney(storeRows, (row) => row.gmv);
  const adSpend = sumMoney(storeRows, (row) => row.adSpend);
  const actualProfit = sumMoney(storeRows, (row) => row.actualProfit);
  const compensation = sumMoney(storeRows, (row) => row.compensationRegistered);
  const oneHourRefundOrders = sum(products, (item) => item.oneHourRefundOrders);
  const nonFakeOrders = sum(products, (item) => item.nonFakeOrders);
  const oneHourRefundRate = nonFakeOrders > 0 ? oneHourRefundOrders / nonFakeOrders : 0;
  const paidOrders = sum(storeRows, (row) => row.paidOrders);
  const fakeOrders = sum(storeRows, (row) => row.fakeOrders);
  const productAction = (
    state: AnalyticsDecision,
    label: string,
    impactLabel: string,
    impactValue: (product: ProductSummary) => number | null
  ): AnalyticsAction => {
    const matches = products.filter((item) => item.decision === state);
    const ranked = matches
      .map((item) => ({ item, amount: impactValue(item) }))
      .sort((left, right) => (right.amount ?? -1) - (left.amount ?? -1));
    const amounts = ranked.map((item) => item.amount).filter((value): value is number => value !== null);
    return {
      state,
      count: matches.length,
      label,
      impactAmount: amounts.length ? addMoney(0, amounts.reduce((sum, value) => sum + value, 0)) : null,
      impactLabel,
      topEntities: ranked.slice(0, 3).map(({ item, amount }) => ({
        key: item.key,
        name: `${item.storeName} · ${item.categoryName}`,
        detail: `商品 ${item.productId}${item.planId ? ` · 计划 ${item.planId}` : ""}`,
        amount,
      })),
    };
  };
  const lossStores = stores.filter((item) => item.status === "loss");
  const actionCandidates: AnalyticsDashboard["actions"] = [
    productAction("high_roi_loss", "高 ROI 亏损", "当前亏损", (item) => Math.max(0, -item.actualProfit)),
    productAction("review", "重点复核", "当前亏损", (item) => Math.max(0, -item.actualProfit)),
    productAction("optimize", "待优化商品", "利润下滑", (item) => item.hasPreviousData ? Math.max(0, -item.profitChange) : null),
    productAction("data_issue", "数据异常", "待核验", () => null),
    {
      state: "store_loss",
      count: lossStores.length,
      label: "亏损店铺",
      impactAmount: addMoney(0, lossStores.reduce((sum, item) => sum + Math.max(0, -item.actualProfit), 0)),
      impactLabel: "当前亏损",
      topEntities: lossStores.slice(0, 3).map((item) => ({
        key: item.key,
        name: item.storeName,
        detail: `${item.username} · 利润率 ${(item.profitMargin * 100).toFixed(1)}%`,
        amount: Math.max(0, -item.actualProfit),
      })),
    },
  ];
  const actions = actionCandidates
    .filter((item) => item.count > 0)
    .sort((left, right) => (right.impactAmount ?? -1) - (left.impactAmount ?? -1) || right.count - left.count);
  const { comparison: versionComparison, revisionSignals } = buildVersionComparison(
    snapshotProductRows,
    versionPairs,
    versionComparisonMode,
    { dateFrom: currentStart, dateTo: currentEnd, storeNames: input.storeNames },
  );
  const planInsights = buildPlanInsights(
    selectedPlanRows,
    allProductRows.filter((row) => !row.isSummary && Boolean(row.metricDate) && dateMatches(row.metricDate ?? "") && storeMatches(row.storeName)),
    imports.map((item) => ({ ownerId: item.ownerId, snapshotDate: item.snapshotDate })),
    // Product-name matching needs the complete current-batch registry even when the user narrows the date range.
    allProductRows.filter((row) => storeMatches(row.storeName)),
  );
  const currentPlanByOwner = new Map(imports.map((item) => [item.ownerId, selectedPlanRows.filter((row) => row.importId === item.id)]));
  const previousImportByOwner = new Map(historyRows.filter((item) => previousImportIds.includes(item.id)).map((item) => [item.ownerId, item]));
  const planChangeParts = imports.map((item) => buildPlanChangeInsights({
    currentRows: currentPlanByOwner.get(item.ownerId) ?? [],
    previousRows: previousPlanRows.filter((row) => row.ownerId === item.ownerId && dateMatches(row.metricDate) && storeMatches(row.storeName)),
    currentSnapshotDate: item.snapshotDate,
    previousSnapshotDate: previousImportByOwner.get(item.ownerId)?.snapshotDate ?? null,
    currentImportId: item.id,
    previousImportId: previousImportByOwner.get(item.ownerId)?.id ?? null,
  }));
  const planChanges = planChangeParts.length === 1 ? planChangeParts[0] : mergePlanChangeInsights(planChangeParts);
  planInsights.changes = planChanges;

  const periodDates = storeRows.map((row) => row.metricDate).sort();
  const productAnalysisMessage = !hasCommonProductPeriod
    ? "当前账户之间没有共同的商品原始数据日期范围，商品分析不可用。"
    : !productAnalysisAvailable
      ? `所选日期 ${currentStart ?? "--"} 至 ${currentEnd ?? "--"} 超出商品原始数据范围 ${productPeriodStart} 至 ${productPeriodEnd}，已停止生成商品结论。`
      : isCustomPeriod && !productComparisonAvailable
        ? `当前商品周期可分析，但前一等长周期超出商品原始数据范围 ${productPeriodStart} 至 ${productPeriodEnd}，商品波动对比显示为暂无数据。`
        : null;
  const displayIssues = allIssues.map((issue) => issue.issueType === "store_gmv_gap"
    ? {
      ...issue,
      severity: "info" as const,
      issueType: "store_gmv_variance",
      message: issue.message.replace("千川与店铺 GMV 差额", "千川与店铺 GMV 口径差异"),
    }
    : { ...issue, username: userMap.get(issue.ownerId)?.username ?? "未知用户" });
  return {
    scope: userRows.map((user) => ({ ownerId: user.id, username: user.username, accountId: user.accountId, isAll: input.ownerIds.length > 1 })),
    imports: imports.map((item) => {
      const user = userMap.get(item.ownerId);
      return { id: item.id, ownerId: item.ownerId, username: user?.username ?? "未知用户", accountId: user?.accountId ?? "--", fileName: item.fileName, periodStart: item.periodStart, periodEnd: item.periodEnd, productPeriodStart: item.productPeriodStart ?? productPeriodStart, productPeriodEnd: item.productPeriodEnd ?? productPeriodEnd, createdAt: item.createdAt?.toISOString() ?? null, storeCount: item.storeCount, productCount: item.productCount, registeredProductCount: item.registeredProductCount, issueCount: item.issueCount, productProfitTotal: item.productProfitTotal, cachedProductProfitTotal: item.cachedProductProfitTotal, reconciliationStatus: item.reconciliationStatus, formulaCount: item.formulaCount, formulaErrorCount: item.formulaErrorCount, fixedRangeRiskCount: item.fixedRangeRiskCount, snapshotDate: item.snapshotDate, maturityDays: item.maturityDays };
    }),
    period: { start: periodDates[0] ?? imports.map((item) => item.periodStart).filter(Boolean).sort()[0] ?? null, end: periodDates.at(-1) ?? imports.map((item) => item.periodEnd).filter(Boolean).sort().at(-1) ?? null },
    dataWindows: {
      store: { start: availableDates[0] ?? null, end: availableDates.at(-1) ?? null },
      product: { start: productPeriodStart, end: productPeriodEnd },
      productAnalysis: { available: productAnalysisAvailable, comparisonAvailable: productComparisonAvailable, message: productAnalysisMessage },
    },
    kpis: {
      gmv, adSpend, actualProfit, profitMargin: gmv > 0 ? actualProfit / gmv : 0,
      totalRefund: sumMoney(storeRows, (row) => row.totalRefundAmount),
      compensation,
      roi: adSpend > 0 ? gmv / adSpend : 0,
      netDealRoi: adSpend > compensation ? gmv * (1 - oneHourRefundRate) / (adSpend - compensation) : 0,
      paidOrders, fakeOrders, fakeOrderRate: paidOrders > 0 ? fakeOrders / paidOrders : 0,
      productProfitTotal: sumMoney(selectedProducts.filter((item) => item.profitAvailable), (item) => item.actualProfit),
    },
    stores,
    products,
    issues: displayIssues.map((issue) => ({ ...issue, username: userMap.get(issue.ownerId)?.username ?? "未知用户" })),
    trend: [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    comparison: { currentStart, currentEnd, previousStart, previousEnd, days: comparisonDays, hasPreviousData: previousStoreRows.length > 0 },
    revisionSignals,
    versionComparison,
    actions,
    availableStores: [...new Set(allStoreRows.map((row) => row.storeName))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    accuracy: {
      status: imports.some((item) => item.reconciliationStatus === "fail") ? "fail" : imports.some((item) => item.reconciliationStatus === "warning") ? "warning" : "pass",
      formulaCount: sum(imports, (item) => item.formulaCount),
      formulaErrorCount: sum(imports, (item) => item.formulaErrorCount),
      fixedRangeRiskCount: sum(imports, (item) => item.fixedRangeRiskCount),
      passedChecks: reconciliations.filter((item) => item.status === "pass").length,
      warningChecks: reconciliations.filter((item) => item.status === "warning").length,
      failedChecks: reconciliations.filter((item) => item.status === "fail").length,
    },
    sheetAudits,
    formulaAudits,
    reconciliations,
    history,
    historyDiffs,
    planInsights,
  };
}
