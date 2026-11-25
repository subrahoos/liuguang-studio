"use client";

import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleDollarSign,
  Database,
  FileSpreadsheet,
  FilterX,
  GitCompareArrows,
  History,
  LoaderCircle,
  PackageSearch,
  RefreshCw,
  Search,
  ScanSearch,
  Store,
  Trash2,
  TriangleAlert,
  Upload,
  UserRound,
  WalletCards,
} from "lucide-react";
import type { AnalyticsDashboard, AnalyticsDecision, ProductSummary, StoreSummary } from "@/lib/analytics/service";
import { allocatePlanQuota } from "@/lib/analytics/plan-insights";
import { nextMetricSort, sortByMetric, type MetricSort } from "@/lib/analytics/metric-sort";

type CurrentUser = { id: string; accountId: string; username: string; role: "admin" | "user" };
type AdminUser = { id: string; accountId: string; username: string; role: string; disabled: boolean | null };
type ViewId = "overview" | "stores" | "products" | "compare" | "ads" | "strategy" | "aftersales" | "costs" | "simulation" | "lineage" | "history" | "trace";
type Selection = { type: "store"; value: StoreSummary } | { type: "product"; value: ProductSummary } | null;
type ActionFilter = AnalyticsDashboard["actions"][number]["state"] | null;
type ImportPreview = {
  id: string;
  fileName: string;
  status: "queued" | "processing" | "preview_ready" | "completed" | "failed";
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
  cachedProductProfitTotal: number;
  reconciliationStatus: "pass" | "warning" | "fail";
  formulaCount: number;
  formulaErrorCount: number;
  sourceOrderRows: number;
  sourceOrderLastRow: number;
  sourceSpendRows: number;
  sourceSpendLastRow: number;
  snapshotDate: string | null;
  maturityDays: number;
  errorMessage: string | null;
};

const viewGroups: Array<{
  id: "diagnosis" | "breakdown" | "verification" | "tools";
  label: string;
  views: Array<{ id: ViewId; label: string; icon: typeof ChartNoAxesCombined }>;
}> = [
  { id: "diagnosis", label: "经营分析", views: [
    { id: "overview", label: "总览", icon: ChartNoAxesCombined },
    { id: "stores", label: "店铺", icon: Store },
    { id: "products", label: "商品", icon: PackageSearch },
    { id: "compare", label: "利润表对比", icon: GitCompareArrows },
  ] },
  { id: "breakdown", label: "问题拆解", views: [
    { id: "ads", label: "投放计划", icon: ChartNoAxesCombined },
    { id: "strategy", label: "计划策略", icon: ChartNoAxesCombined },
    { id: "aftersales", label: "退款履约", icon: RefreshCw },
    { id: "costs", label: "成本赔付", icon: WalletCards },
  ] },
  { id: "verification", label: "数据核验", views: [
    { id: "lineage", label: "数据血缘", icon: Database },
    { id: "trace", label: "原始追溯", icon: ScanSearch },
    { id: "history", label: "导入记录", icon: History },
  ] },
  { id: "tools", label: "辅助工具", views: [
    { id: "simulation", label: "经营情景测算", icon: CircleDollarSign },
  ] },
];
const decisionMeta: Record<AnalyticsDecision, { label: string; className: string }> = {
  scale: { label: "可放量", className: "border-emerald-200/25 bg-emerald-300/12 text-emerald-100" },
  stable: { label: "稳定经营", className: "border-cyan-200/25 bg-cyan-300/10 text-cyan-100" },
  optimize: { label: "待优化", className: "border-amber-200/25 bg-amber-300/12 text-amber-100" },
  high_roi_loss: { label: "高ROI亏损", className: "border-rose-200/28 bg-rose-300/13 text-rose-100" },
  review: { label: "重点复核", className: "border-rose-200/28 bg-rose-300/12 text-rose-100" },
  data_issue: { label: "数据异常", className: "border-violet-200/25 bg-violet-300/12 text-violet-100" },
};
const dateRangeStoragePrefix = "luma.analytics.date-range.v1";

function isValidDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateRangeStorageKey(ownerScope: string) {
  return dateRangeStoragePrefix + ":" + ownerScope;
}

function readStoredDateRange(ownerScope: string) {
  if (!ownerScope) return null;
  try {
    const raw = window.localStorage.getItem(dateRangeStorageKey(ownerScope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown };
    const from = typeof parsed.from === "string" ? parsed.from : "";
    const to = typeof parsed.to === "string" ? parsed.to : "";
    if ((!from && !to) || (from && !isValidDateInput(from)) || (to && !isValidDateInput(to)) || (from && to && from > to)) {
      window.localStorage.removeItem(dateRangeStorageKey(ownerScope));
      return null;
    }
    return { from, to };
  } catch {
    return null;
  }
}

function storeDateRange(ownerScope: string, from: string, to: string) {
  if (!ownerScope) return;
  const key = dateRangeStorageKey(ownerScope);
  try {
    if (!from && !to) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify({ from, to }));
  } catch {
    // 本地存储不可用时仍保留当前会话内的日期筛选。
  }
}

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value || 0);
}

function compactMoney(value: number) {
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return money(value);
}

function shortDate(value: string | null | undefined) {
  return value ? value.slice(5).replace("-", "/") : "--";
}

function percent(value: number) {
  return `${((value || 0) * 100).toFixed(1)}%`;
}

function percentOrDash(value: number | null | undefined) {
  return Number.isFinite(value) ? percent(value as number) : "--";
}

type ProductRateKey = "overallShippingRate" | "netShippingRate" | "signRate" | "oneHourRefundRate" | "profitMargin";

function productRateValue(product: ProductSummary, key: ProductRateKey) {
  if (key === "overallShippingRate") return product.nonFakeOrders > 0 ? product.overallShippingRate : null;
  if (key === "netShippingRate") return product.nonFakeOrders > product.oneHourRefundOrders ? product.netShippingRate : null;
  if (key === "signRate") return product.shippedOrders + product.pendingOrders > 0 ? product.signRate : null;
  if (key === "oneHourRefundRate") return product.nonFakeOrders > 0 ? product.oneHourRefundRate : null;
  return product.profitAvailable && product.gmv > 0 ? product.profitMargin : null;
}

function productPercent(product: ProductSummary, key: ProductRateKey) {
  const value = productRateValue(product, key);
  return value === null ? "--" : percent(value);
}

function productProfit(product: ProductSummary) {
  return product.profitAvailable ? `¥${money(product.actualProfit)}` : "--";
}

function valueTone(value: number) {
  return value < 0 ? "text-rose-200" : value > 0 ? "text-emerald-200" : "text-slate-300";
}

function moneyChange(hasPreviousData: boolean, value: number) {
  return hasPreviousData ? `${value >= 0 ? "+" : ""}¥${money(value)}` : "--";
}

export function OperationsReviewDashboard({ currentUser }: { currentUser: CurrentUser | null }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dashboardAbortRef = useRef<AbortController | null>(null);
  const dashboardRequestRef = useRef(0);
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [ownerScope, setOwnerScope] = useState("");
  const [view, setView] = useState<ViewId>("overview");
  const [visitedViews, setVisitedViews] = useState<Set<ViewId>>(() => new Set(["overview"]));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [importStage, setImportStage] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [notice, setNotice] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AnalyticsDashboard["history"][number] | null>(null);
  const [deletingImport, setDeletingImport] = useState(false);
  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");
  const [appliedFrom, setAppliedFrom] = useState("");
  const [appliedTo, setAppliedTo] = useState("");
  const [restoredDateScope, setRestoredDateScope] = useState("");
  const [storeFilters, setStoreFilters] = useState<string[]>([]);
  const [storeFilterOpen, setStoreFilterOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [actionFilter, setActionFilter] = useState<ActionFilter>(null);
  const [versionBaselineId, setVersionBaselineId] = useState("");
  const [versionTargetId, setVersionTargetId] = useState("");
  const deferredSearch = useDeferredValue(search);

  const isAdmin = currentUser?.role === "admin";

  const activateView = useCallback((nextView: ViewId) => {
    setVisitedViews((current) => {
      if (current.has(nextView)) return current;
      const next = new Set(current);
      next.add(nextView);
      return next;
    });
    startTransition(() => setView(nextView));
  }, []);

  useEffect(() => () => {
    dashboardAbortRef.current?.abort();
  }, []);

  const syncImportStatus = useCallback((batch: ImportPreview) => {
    setDashboard((current) => current ? {
      ...current,
      history: current.history.map((item) => item.id === batch.id ? {
        ...item,
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
        reconciliationStatus: batch.reconciliationStatus,
        snapshotDate: batch.snapshotDate,
        maturityDays: batch.maturityDays,
        errorMessage: batch.errorMessage,
      } : item),
    } : current);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    setOwnerScope((current) => current || currentUser.id);
    if (!isAdmin) return;
    fetch("/api/admin/users", { cache: "no-store" })
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => setUsers(response.ok && Array.isArray(body.users) ? body.users : []))
      .catch(() => setUsers([]));
  }, [currentUser, isAdmin]);

  useEffect(() => {
    setVersionBaselineId("");
    setVersionTargetId("");
  }, [ownerScope]);

  useEffect(() => {
    if (!ownerScope) {
      setRestoredDateScope("");
      return;
    }
    const storedRange = readStoredDateRange(ownerScope);
    const from = storedRange?.from ?? "";
    const to = storedRange?.to ?? "";
    setDateFromInput(from);
    setDateToInput(to);
    setAppliedFrom(from);
    setAppliedTo(to);
    setRestoredDateScope(ownerScope);
  }, [ownerScope]);

  const loadDashboard = useCallback(async (options?: { resetVersionPair?: boolean; forceRefresh?: boolean }) => {
    if (!ownerScope || restoredDateScope !== ownerScope) return;
    const requestId = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = requestId;
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ ownerId: ownerScope });
      if (appliedFrom) params.set("from", appliedFrom);
      if (appliedTo) params.set("to", appliedTo);
      for (const storeName of storeFilters) params.append("store", storeName);
      const compareFrom = options?.resetVersionPair ? "" : versionBaselineId;
      const compareTo = options?.resetVersionPair ? "" : versionTargetId;
      if (compareFrom && compareTo) {
        params.set("compareFrom", compareFrom);
        params.set("compareTo", compareTo);
      }
      if (options?.forceRefresh) params.set("refresh", "1");
      const response = await fetch(`/api/analytics/dashboard?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "经营复盘读取失败");
      if (controller.signal.aborted || dashboardRequestRef.current !== requestId) return;
      setDashboard(body as AnalyticsDashboard);
      setDateFromInput((current) => current || body.period?.start || "");
      setDateToInput((current) => current || body.period?.end || "");
    } catch (loadError) {
      if (controller.signal.aborted || dashboardRequestRef.current !== requestId) return;
      setError(loadError instanceof Error ? loadError.message : "经营复盘读取失败");
    } finally {
      if (dashboardRequestRef.current === requestId) setLoading(false);
    }
  }, [ownerScope, restoredDateScope, appliedFrom, appliedTo, storeFilters, versionBaselineId, versionTargetId]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  async function importWorkbook(file: File | null) {
    if (!file) return;
    setSelectedFileName(file.name);
    if (ownerScope === "all") {
      setError("管理员导入前需要先选择一个具体用户，避免文件归属不清。");
      return;
    }
    setError("");
    setNotice("");
    setImportStage("正在上传利润表...");
    try {
      const form = new FormData();
      form.set("file", file);
      if (isAdmin && ownerScope) form.set("ownerId", ownerScope);
      const response = await fetch("/api/analytics/imports", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "利润表导入失败");
      const importId = String(body.import?.id ?? "");
      if (!importId) throw new Error("后台没有返回导入批次");
      setImportStage(`${body.import?.stage || "等待后台解析"} ${Number(body.import?.progress) || 0}%`);
      activateView("history");
      await loadDashboard({ resetVersionPair: true });
      let previewReady = false;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const statusResponse = await fetch(`/api/analytics/imports/${importId}`, { cache: "no-store" });
        const statusBody = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok) throw new Error(statusBody.error || "预检状态读取失败");
        const batch = statusBody.import as ImportPreview;
        setImportStage(`${batch.stage} ${batch.progress}%`);
        syncImportStatus(batch);
        if (batch.status === "failed") {
          await loadDashboard();
          throw new Error(batch.errorMessage || "利润表预检失败");
        }
        if (batch.status === "preview_ready") {
          setImportPreview(batch);
          setNotice("预检完成，请核对批次摘要后确认正式导入。");
          await loadDashboard();
          previewReady = true;
          break;
        }
      }
      if (!previewReady) throw new Error("后台预检超时，请稍后在导入记录中查看批次状态");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "利润表导入失败");
      await loadDashboard({ resetVersionPair: true });
    } finally {
      setImportStage("");
      setSelectedFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    if (!file) {
      setNotice("未选择文件。");
      return;
    }
    void importWorkbook(file);
    input.value = "";
  }

  async function commitPreview(importId: string, options?: { snapshotDate?: string | null; maturityDays?: number }) {
    setImportStage("正在确认正式导入...");
    setError("");
    try {
      const response = await fetch(`/api/analytics/imports/${importId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options ?? {}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "确认导入失败");
      setImportPreview(null);
      setNotice(body.message || "利润表已正式导入");
      setVersionBaselineId("");
      setVersionTargetId("");
      await loadDashboard({ resetVersionPair: true });
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "确认导入失败");
    } finally {
      setImportStage("");
    }
  }

  async function deleteImport(target: AnalyticsDashboard["history"][number]) {
    setDeletingImport(true);
    setError("");
    try {
      const response = await fetch(`/api/analytics/imports/${target.id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "利润表删除失败");
      const deleted = body.deleted as { wasCurrent?: boolean; fallback?: { fileName?: string } | null } | undefined;
      setDeleteTarget(null);
      setSelection(null);
      setVersionBaselineId("");
      setVersionTargetId("");
      await loadDashboard({ resetVersionPair: true });
      setNotice(deleted?.wasCurrent
        ? deleted.fallback?.fileName
          ? `已删除利润表，当前经营数据已回退到：${deleted.fallback.fileName}`
          : "已删除利润表，当前账户暂无正式经营数据。"
        : `已删除利润表：${target.fileName}`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "利润表删除失败");
    } finally {
      setDeletingImport(false);
    }
  }

  function applyDateRange() {
    if (dateFromInput && dateToInput && dateFromInput > dateToInput) {
      setError("开始日期不能晚于结束日期，请重新选择。");
      return;
    }
    setError("");
    setNotice(dateFromInput || dateToInput ? "日期范围已应用，经营数据已按所选日期重新读取。" : "已恢复完整日期范围。");
    storeDateRange(ownerScope, dateFromInput, dateToInput);
    setAppliedFrom(dateFromInput);
    setAppliedTo(dateToInput);
    setSelection(null);
  }

  function resetFilters() {
    storeDateRange(ownerScope, "", "");
    setAppliedFrom("");
    setAppliedTo("");
    setDateFromInput(dashboard?.imports[0]?.periodStart || dashboard?.period.start || "");
    setDateToInput(dashboard?.imports[0]?.periodEnd || dashboard?.period.end || "");
    setStoreFilters([]);
    setStoreFilterOpen(false);
    setSearch("");
    setSelection(null);
    setActionFilter(null);
  }

  function applyPreset(days: number) {
    const end = dashboard?.imports[0]?.periodEnd ?? dashboard?.period.end;
    if (!end) return;
    const startDate = new Date(`${end}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
    const start = startDate.toISOString().slice(0, 10);
    storeDateRange(ownerScope, start, end);
    setDateFromInput(start);
    setDateToInput(end);
    setAppliedFrom(start);
    setAppliedTo(end);
    setSelection(null);
    setNotice("");
  }

  const searchedProducts = useMemo(() => {
    const keyword = deferredSearch.trim().toLowerCase();
    if (!dashboard) return [];
    let items = dashboard.products;
    if (actionFilter && actionFilter !== "store_loss") items = items.filter((item) => item.decision === actionFilter);
    if (!keyword) return items;
    return items.filter((item) => `${item.storeName} ${item.productName} ${item.categoryName} ${item.productId} ${item.planId ?? ""} ${item.username} ${item.reasons.join(" ")}`.toLowerCase().includes(keyword));
  }, [dashboard, deferredSearch, actionFilter]);

  const searchedStores = useMemo(() => {
    const keyword = deferredSearch.trim().toLowerCase();
    if (!dashboard) return [];
    let items = dashboard.stores;
    if (actionFilter === "store_loss") items = items.filter((item) => item.status === "loss");
    if (!keyword) return items;
    return items.filter((item) => `${item.storeName} ${item.username}`.toLowerCase().includes(keyword));
  }, [dashboard, deferredSearch, actionFilter]);

  function openAction(state: NonNullable<ActionFilter>) {
    setActionFilter(state);
    setSearch("");
    setSelection(null);
    activateView(state === "store_loss" ? "stores" : "products");
  }

  const currentImport = dashboard?.imports[0];
  const activeAction = dashboard?.actions.find((item) => item.state === actionFilter) ?? null;
  const scopeName = ownerScope === "all" ? "全部用户" : users.find((user) => user.id === ownerScope)?.username || currentUser?.username || "当前用户";
  const hasData = Boolean(dashboard?.imports.length);
  const activeViewGroup = viewGroups.find((group) => group.views.some((item) => item.id === view)) ?? viewGroups[0];
  const profitChange = dashboard?.stores.reduce((sum, store) => sum + (store.hasPreviousData ? store.profitChange : 0), 0) ?? 0;
  const hasProfitComparison = Boolean(dashboard?.stores.some((store) => store.hasPreviousData));
  const lossStoreCount = dashboard?.stores.filter((store) => store.status === "loss").length ?? 0;
  const diagnosisProductCount = dashboard?.products.filter((product) => !["scale", "stable"].includes(product.decision)).length ?? 0;
  const latestMaturity = dashboard?.trend.at(-1)?.maturity;
  const storeRange = `${appliedFrom || currentImport?.periodStart || "--"} 至 ${appliedTo || currentImport?.periodEnd || "--"}`;
  const productRange = `${appliedFrom || currentImport?.productPeriodStart || "--"} 至 ${appliedTo || currentImport?.productPeriodEnd || "--"}`;
  const periodComparison = dashboard?.comparison;
  const currentPeriodLabel = `${shortDate(periodComparison?.currentStart)} 至 ${shortDate(periodComparison?.currentEnd)}`;
  const previousPeriodLabel = `${shortDate(periodComparison?.previousStart)} 至 ${shortDate(periodComparison?.previousEnd)}`;
  const largestLossStore = [...(dashboard?.stores ?? [])]
    .filter((store) => store.status === "loss")
    .sort((left, right) => left.actualProfit - right.actualProfit)[0];
  const diagnosticQueueItems = useMemo<QueueItem[]>(() => (dashboard?.products ?? [])
    .map((product) => ({ product, tags: productQueueTags(product), impact: actionImpact(product) }))
    .filter((item) => item.tags.length > 0), [dashboard?.products]);

  return (
    <section className="luma-analytics-shell relative isolate flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-lg border border-cyan-100/14 bg-[#061019]/20 shadow-[0_24px_90px_rgba(0,0,0,0.24)] backdrop-blur-[15px]">
      {importPreview && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
          <div data-border-glow className="w-full max-w-[620px] rounded-lg border border-cyan-100/20 bg-[#07151e]/90 p-5 shadow-[0_28px_100px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-[10px] font-bold uppercase text-cyan-100/60">Import Preview</p><h3 className="mt-1 text-xl font-black text-slate-50">确认利润表预检结果</h3><p className="mt-1 truncate text-xs text-slate-400">{importPreview.fileName}</p></div>
              <AccuracyBadge status={importPreview.reconciliationStatus} />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-2">
              <DetailMetric label="店铺周期" value={`${importPreview.periodStart ?? "--"} 至 ${importPreview.periodEnd ?? "--"}`} />
              <DetailMetric label="商品数据周期" value={`${importPreview.productPeriodStart ?? "--"} 至 ${importPreview.productPeriodEnd ?? "--"}`} />
              <DetailMetric label="店铺 / 经营商品" value={`${importPreview.storeCount} / ${importPreview.productCount}`} />
              <DetailMetric label="商品口径" value="原始记录按日期汇总" />
              <DetailMetric label="有效订单 / 末行" value={`${importPreview.sourceOrderRows.toLocaleString("zh-CN")} / ${importPreview.sourceOrderLastRow.toLocaleString("zh-CN")}`} />
              <DetailMetric label="有效千川 / 末行" value={`${importPreview.sourceSpendRows.toLocaleString("zh-CN")} / ${importPreview.sourceSpendLastRow.toLocaleString("zh-CN")}`} />
              <DetailMetric label="商品利润小计" value={`¥${money(importPreview.productProfitTotal)}`} tone={valueTone(importPreview.productProfitTotal)} />
              <DetailMetric label="公式审计" value={importPreview.formulaCount.toLocaleString("zh-CN")} />
              <DetailMetric label="异常数量" value={String(importPreview.issueCount)} tone={importPreview.issueCount ? "text-amber-100" : "text-emerald-100"} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">数据快照日期<input type="date" value={importPreview.snapshotDate ?? ""} onChange={(event) => setImportPreview((current) => current ? { ...current, snapshotDate: event.target.value } : current)} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-slate-100 outline-none" /></label>
              <label className="text-xs text-slate-400">观察期（天）<input type="number" min={1} max={30} value={importPreview.maturityDays} onChange={(event) => setImportPreview((current) => current ? { ...current, maturityDays: Math.min(30, Math.max(1, Number(event.target.value) || 6)) } : current)} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-slate-100 outline-none" /></label>
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-400">确认后该批次才会替换为当前账户的最新正式经营数据。所有经营指标均以 Excel 原表字段为准，异常项会单独标记。</p>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => { setImportPreview(null); activateView("history"); void loadDashboard(); }} className="h-9 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs text-slate-300">暂不导入</button><button type="button" onClick={() => commitPreview(importPreview.id, { snapshotDate: importPreview.snapshotDate, maturityDays: importPreview.maturityDays })} data-border-glow className="h-9 rounded-lg border border-cyan-200/24 bg-cyan-300/14 px-4 text-xs font-bold text-cyan-50">确认正式导入</button></div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div data-border-glow className="w-full max-w-[500px] rounded-lg border border-rose-200/22 bg-[#07151e]/92 p-5 shadow-[0_28px_100px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-rose-100/65">Delete Import</p>
            <h3 className="mt-1 text-xl font-black text-slate-50">删除这份利润表？</h3>
            <p className="mt-2 break-all text-xs text-slate-400">{deleteTarget.fileName}</p>
            <p className="mt-4 text-xs leading-6 text-slate-300">会删除原始 Excel 文件、这份批次的解析数据和关联主档。{deleteTarget.id === currentImport?.id ? "当前经营分析会自动回退到上一份正式导入。" : "不会影响当前正在使用的正式经营数据。"}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={deletingImport} onClick={() => setDeleteTarget(null)} className="h-9 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs text-slate-300 disabled:opacity-45">取消</button>
              <button type="button" disabled={deletingImport} onClick={() => void deleteImport(deleteTarget)} data-border-glow className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200/24 bg-rose-300/12 px-4 text-xs font-bold text-rose-50 disabled:cursor-not-allowed disabled:opacity-45"><Trash2 className="h-3.5 w-3.5" />{deletingImport ? "正在删除" : "确认删除"}</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-[96px] shrink-0 items-center gap-4 border-b border-cyan-100/12 bg-black/12 px-5 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-cyan-100/20 bg-cyan-200/10 text-cyan-100 shadow-[0_0_28px_rgba(34,211,238,0.12)]">
            <ChartNoAxesCombined className="h-5 w-5" />
          </span>
          <div className="flex min-w-0 flex-col justify-center self-stretch py-2">
            <div className="flex items-center gap-2">
              <h2 className="luma-analytics-title truncate text-xl font-black text-slate-50">经营分析中心</h2>
              {dashboard && <AccuracyBadge status={dashboard.accuracy.status} />}
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-300/68">
              {currentImport ? `${scopeName} · 店铺 ${currentImport.periodStart || "--"} 至 ${currentImport.periodEnd || "--"} · 商品 ${currentImport.productPeriodStart || "--"} 至 ${currentImport.productPeriodEnd || "--"}` : `${scopeName} · 尚未导入利润表`}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isAdmin ? (
            <label className="flex h-9 items-center gap-2 rounded-lg border border-cyan-100/14 bg-white/[0.045] px-3 text-xs text-slate-300">
              <UserRound className="h-4 w-4 text-cyan-100/70" />
              <select value={ownerScope} onChange={(event) => { setOwnerScope(event.target.value); setStoreFilters([]); setStoreFilterOpen(false); setSelection(null); setDateFromInput(""); setDateToInput(""); setAppliedFrom(""); setAppliedTo(""); }} className="max-w-[160px] bg-transparent font-semibold text-slate-100 outline-none">
                <option value="all">全部用户</option>
                {users.filter((user) => !user.disabled).map((user) => <option key={user.id} value={user.id}>{user.username} · {user.accountId}</option>)}
              </select>
            </label>
          ) : (
            <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-100/14 bg-white/[0.045] px-3 text-xs font-semibold text-cyan-50">
              <UserRound className="h-4 w-4" /> {currentUser?.username}
            </span>
          )}
          <button type="button" onClick={() => void loadDashboard({ forceRefresh: true })} disabled={loading} data-border-glow className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-cyan-100 transition hover:bg-cyan-200/10 disabled:opacity-50" title="强制重新计算并刷新经营数据">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <label data-border-glow aria-disabled={Boolean(importStage) || ownerScope === "all"} className={`relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-lg border border-cyan-200/24 bg-cyan-300/12 px-3 text-xs font-bold text-cyan-50 transition hover:bg-cyan-300/18 ${importStage || ownerScope === "all" ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" disabled={Boolean(importStage) || ownerScope === "all"} onChange={handleFileSelection} aria-label="选择利润表文件" className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
            {importStage ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {importStage || selectedFileName || "导入利润表"}
          </label>
        </div>
      </div>

      {(error || notice) && (
        <div className={`mx-4 mt-3 shrink-0 rounded-lg border px-3 py-2 text-xs ${error ? "border-rose-200/20 bg-rose-300/10 text-rose-100" : "border-emerald-200/20 bg-emerald-300/10 text-emerald-100"}`}>
          {error || notice}
        </div>
      )}

      {hasData && <>
        <div className="flex shrink-0 items-center gap-2 border-b border-cyan-100/10 px-4 py-2.5">
        <div className="flex h-8 items-center rounded-lg border border-cyan-100/12 bg-black/15 p-0.5">
          {[3, 7, 15, 30].map((days) => <button key={days} type="button" onClick={() => applyPreset(days)} className={`h-7 rounded-md px-2.5 text-[10px] font-bold transition ${dashboard?.comparison.days === days ? "bg-cyan-300/14 text-cyan-50" : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"}`}>{days}天</button>)}
        </div>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-2.5 text-xs text-slate-400">
          从 <input type="date" value={dateFromInput} onChange={(event) => setDateFromInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDateRange(); }} className="bg-transparent text-slate-100 outline-none" />
        </label>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-2.5 text-xs text-slate-400">
          至 <input type="date" value={dateToInput} onChange={(event) => setDateToInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDateRange(); }} className="bg-transparent text-slate-100 outline-none" />
        </label>
        <div className="relative">
          <button type="button" onClick={() => setStoreFilterOpen((value) => !value)} aria-expanded={storeFilterOpen} className="inline-flex h-8 min-w-[132px] items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#0b1821]/78 px-2.5 text-xs text-slate-100 outline-none transition hover:bg-white/[0.06]"><span className="truncate">{storeFilters.length ? `已选 ${storeFilters.length} 家店` : "全部店铺"}</span><ChevronDown className={`h-3.5 w-3.5 transition ${storeFilterOpen ? "rotate-180" : ""}`} /></button>
          {storeFilterOpen && <div className="absolute left-0 top-9 z-50 w-[250px] rounded-lg border border-cyan-100/15 bg-[#07141d]/98 p-2 shadow-2xl backdrop-blur-xl"><div className="mb-2 flex items-center justify-between border-b border-white/[0.07] pb-2 text-[10px]"><span className="text-slate-400">可同时筛选多家店铺</span><button type="button" onClick={() => { setStoreFilters([]); setSelection(null); }} className="text-cyan-100">全部清除</button></div><div className="max-h-64 overflow-y-auto">{(dashboard?.availableStores ?? []).map((storeName) => { const checked = storeFilters.includes(storeName); return <button key={storeName} type="button" onClick={() => { setStoreFilters((current) => checked ? current.filter((item) => item !== storeName) : [...current, storeName]); setSelection(null); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-200 transition hover:bg-cyan-200/[0.07]"><span className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "border-cyan-200/50 bg-cyan-300/20 text-cyan-50" : "border-white/15"}`}>{checked && <Check className="h-3 w-3" />}</span><span className="truncate">{storeName}</span></button>; })}</div></div>}
        </div>
        <button type="button" onClick={applyDateRange} className="h-8 rounded-lg border border-cyan-100/18 bg-cyan-200/9 px-3 text-xs font-semibold text-cyan-50 transition hover:bg-cyan-200/14">应用日期</button>
        <button type="button" onClick={resetFilters} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-2.5 text-xs text-slate-300 transition hover:bg-white/[0.07]"><FilterX className="h-3.5 w-3.5" /> 重置</button>
          <div className="relative ml-auto w-[230px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={(event) => { setSearch(event.target.value); setSelection(null); }} placeholder="全局搜索店铺、商品或ID" className="h-8 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-8 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-200/30" />
          </div>
        </div>

      {view === "overview" && <div className="grid shrink-0 grid-cols-6 gap-2 px-4 py-3">
        <MetricCard icon={CircleDollarSign} label="当前周期利润" value={`¥${compactMoney(dashboard?.kpis.actualProfit ?? 0)}`} detail={`店铺范围 ${storeRange} · 净成交 ROI ${(dashboard?.kpis.netDealRoi ?? 0).toFixed(2)} · 利润率 ${percent(dashboard?.kpis.profitMargin ?? 0)}`} tone={valueTone(dashboard?.kpis.actualProfit ?? 0)} onClick={() => { activateView("overview"); setSelection(null); }} />
        <MetricCard icon={GitCompareArrows} label="利润周期变化" value={hasProfitComparison ? `${profitChange >= 0 ? "+" : "-"}¥${compactMoney(Math.abs(profitChange))}` : "--"} detail={hasProfitComparison ? `${currentPeriodLabel} → ${previousPeriodLabel}` : "缺少前一等长周期数据"} tone={hasProfitComparison ? valueTone(profitChange) : "text-slate-400"} onClick={() => { activateView("stores"); setSelection(null); }} />
        <MetricCard icon={Store} label="亏损店铺" value={`${lossStoreCount}`} detail={largestLossStore ? `共 ${dashboard?.stores.length ?? 0} 家 · 最高亏损 ${largestLossStore.storeName}` : `共 ${dashboard?.stores.length ?? 0} 家店铺`} tone={lossStoreCount ? "text-rose-200" : "text-emerald-200"} onClick={() => openAction("store_loss")} />
        <MetricCard icon={PackageSearch} label="重点诊断商品" value={`${diagnosisProductCount}`} detail={`商品范围 ${productRange} · 占 ${dashboard?.products.length ?? 0} 个经营商品`} tone={diagnosisProductCount ? "text-amber-100" : "text-emerald-200"} onClick={() => { activateView("products"); setSelection(null); setActionFilter(null); }} />
        <MetricCard icon={History} label="最新数据成熟度" value={latestMaturity === "stable" ? "相对稳定" : latestMaturity === "settling" ? "趋于稳定" : "观察中"} detail={`快照 ${currentImport?.snapshotDate || currentImport?.periodEnd || "--"} · 观察期 ${currentImport?.maturityDays ?? "--"} 天`} tone={latestMaturity === "stable" ? "text-emerald-200" : latestMaturity === "settling" ? "text-amber-100" : "text-cyan-100"} onClick={() => { activateView("history"); setSelection(null); }} />
        <MetricCard icon={Database} label="数据准确性" value={dashboard?.accuracy.status === "pass" ? "已对账" : dashboard?.accuracy.status === "warning" ? "部分通过" : "禁止决策"} detail={`${dashboard?.accuracy.failedChecks ?? 0} 失败 · ${dashboard?.accuracy.warningChecks ?? 0} 警告 · 查看详情`} tone={dashboard?.accuracy.status === "pass" ? "text-emerald-200" : dashboard?.accuracy.status === "warning" ? "text-amber-100" : "text-rose-200"} onClick={() => { activateView("lineage"); setSelection(null); }} />
      </div>}

      <div className="flex shrink-0 items-center gap-1 border-y border-cyan-100/10 bg-black/8 px-4 py-1.5">
        <div className="flex items-center gap-1 border-r border-cyan-100/10 pr-2">
          {viewGroups.map((group) => <button key={group.id} type="button" onClick={() => { activateView(group.views[0].id); setSelection(null); setActionFilter(null); }} className={`h-8 rounded-lg px-3 text-xs font-bold transition ${activeViewGroup.id === group.id ? "border border-cyan-200/22 bg-cyan-300/12 text-cyan-50" : "border border-transparent text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"}`}>{group.label}</button>)}
        </div>
        {activeViewGroup.views.map((item) => {
          const Icon = item.icon;
          const count = item.id === "stores" ? searchedStores.length : item.id === "products" ? searchedProducts.length : item.id === "compare" ? dashboard?.revisionSignals.length : item.id === "lineage" ? (dashboard?.issues.length ?? 0) + (dashboard?.accuracy.failedChecks ?? 0) + (dashboard?.accuracy.warningChecks ?? 0) : item.id === "history" ? dashboard?.history.length : null;
          return (
            <button key={item.id} type="button" onClick={() => { activateView(item.id); setSelection(null); setActionFilter(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${view === item.id ? "border border-cyan-200/22 bg-cyan-300/12 text-cyan-50" : "border border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"}`}>
              <Icon className="h-3.5 w-3.5" /> {item.label}{count !== null ? <span className="text-[10px] opacity-65">{count}</span> : null}
            </button>
          );
        })}
        {actionFilter && <button type="button" onClick={() => { setActionFilter(null); setSelection(null); }} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-200/18 bg-amber-300/9 px-3 text-[10px] font-bold text-amber-100"><FilterX className="h-3.5 w-3.5" /> {activeAction?.label ?? "诊断筛选"} · 清除</button>}
      </div>
      </>}

      <div className={`grid min-h-0 min-w-0 flex-1 gap-3 overflow-hidden p-3 ${hasData && view !== "strategy" ? "xl:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
        <div className="min-h-0 min-w-0 overflow-hidden rounded-lg border border-cyan-100/12 bg-black/14">
          {loading && !dashboard ? <LoadingState /> : !dashboard?.imports.length ? (
            view === "history" && dashboard?.history.length
              ? <ImportHistoryView dashboard={dashboard} onCommit={commitPreview} onDelete={setDeleteTarget} />
              : <EmptyState onFile={importWorkbook} onHistory={() => activateView("history")} hasHistory={Boolean(dashboard?.history.length)} disabled={ownerScope === "all" || Boolean(importStage)} />
          ) : (
            <>
              {visitedViews.has("overview") && <div className={view === "overview" ? "h-full min-h-0" : "hidden"}><OverviewView dashboard={dashboard} stores={searchedStores} onSelectStore={(value) => setSelection({ type: "store", value })} /></div>}
              {visitedViews.has("stores") && <div className={view === "stores" ? "h-full min-h-0" : "hidden"}><StoreAnalysisView stores={searchedStores} showUser={ownerScope === "all"} onSelect={(value) => setSelection({ type: "store", value })} /></div>}
              {visitedViews.has("products") && <div className={view === "products" ? "h-full min-h-0" : "hidden"}>{dashboard.dataWindows.productAnalysis.available
                ? <ProductAnalysisView products={searchedProducts} showUser={ownerScope === "all"} onSelect={(value) => setSelection({ type: "product", value })} />
                : <ProductAvailabilityState dashboard={dashboard} />}</div>}
              {visitedViews.has("compare") && <div className={view === "compare" ? "h-full min-h-0" : "hidden"}><RevisionSignalsView
                dashboard={dashboard}
                baselineId={versionBaselineId}
                targetId={versionTargetId}
                canSelectPair={ownerScope !== "all"}
                onPairChange={(baselineId, targetId) => {
                  setVersionBaselineId(baselineId);
                  setVersionTargetId(targetId);
                  setSelection(null);
                }}
                onResetPair={() => {
                  setVersionBaselineId("");
                  setVersionTargetId("");
                  setSelection(null);
                }}
              /></div>}
              {visitedViews.has("ads") && <div className={view === "ads" ? "h-full min-h-0" : "hidden"}><AdsAnalysisView dashboard={dashboard} products={searchedProducts} onSelect={(value) => setSelection({ type: "product", value })} /></div>}
              {visitedViews.has("strategy") && <div className={view === "strategy" ? "h-full min-h-0" : "hidden"}><PlanStrategyView insights={dashboard.planInsights} accuracy={dashboard.accuracy.status} snapshotDate={currentImport?.snapshotDate ?? null} /></div>}
              {visitedViews.has("aftersales") && <div className={view === "aftersales" ? "h-full min-h-0" : "hidden"}><FulfillmentAnalysisView dashboard={dashboard} products={searchedProducts} onSelect={(value) => setSelection({ type: "product", value })} /></div>}
              {visitedViews.has("costs") && <div className={view === "costs" ? "h-full min-h-0" : "hidden"}><CostAnalysisView dashboard={dashboard} products={searchedProducts} onSelect={(value) => setSelection({ type: "product", value })} /></div>}
              {visitedViews.has("simulation") && <div className={view === "simulation" ? "h-full min-h-0" : "hidden"}><ScenarioAnalysisView dashboard={dashboard} /></div>}
              {visitedViews.has("lineage") && <div className={view === "lineage" ? "h-full min-h-0" : "hidden"}><LineageView dashboard={dashboard} showUser={ownerScope === "all"} /></div>}
              {visitedViews.has("trace") && <div className={view === "trace" ? "h-full min-h-0" : "hidden"}><TraceView importId={currentImport?.id ?? null} onNotice={setNotice} onError={setError} /></div>}
              {visitedViews.has("history") && <div className={view === "history" ? "h-full min-h-0" : "hidden"}><ImportHistoryView dashboard={dashboard} onCommit={commitPreview} onDelete={setDeleteTarget} /></div>}
            </>
          )}
        </div>

        {hasData && <aside className={`${view === "strategy" ? "hidden" : ""} min-h-0 min-w-0 overflow-y-auto rounded-lg border border-cyan-100/12 bg-[#061019]/34 p-3 backdrop-blur-[8px]`}>
          {selection ? <SelectionPanel selection={selection} onOpenStoreProducts={(storeName) => { setStoreFilters([storeName]); activateView("products"); setSelection(null); setActionFilter(null); }} /> : <ActionPanel dashboard={dashboard} queueItems={diagnosticQueueItems} onSelectProduct={(product) => { setSelection({ type: "product", value: product }); activateView("products"); setActionFilter(null); }} />}
        </aside>}
      </div>
    </section>
  );
}

function MetricCard({ icon: Icon, label, value, detail, tone = "text-slate-50", onClick }: { icon: typeof CircleDollarSign; label: string; value: string; detail: string; tone?: string; onClick?: () => void }) {
  const content = <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-400"><Icon className="h-3.5 w-3.5 shrink-0 text-cyan-100/70" /> <span className="truncate">{label}</span></div>
      <div className={`mt-1 truncate text-lg font-black ${tone}`}>{value}</div>
      <div className="mt-auto truncate text-[10px] text-slate-500">{detail}</div>
  </div>;
  const className = "h-[112px] min-w-0 rounded-lg border border-cyan-100/11 bg-white/[0.035] px-3 py-2.5 text-left backdrop-blur-[8px]";
  return onClick ? <button type="button" onClick={onClick} data-border-glow className={`${className} transition hover:border-cyan-100/24 hover:bg-cyan-200/[0.055] focus:outline-none`}>{content}</button> : <div data-border-glow className={className}>{content}</div>;
}

function AccuracyBadge({ status }: { status: AnalyticsDashboard["accuracy"]["status"] }) {
  const meta = status === "pass"
    ? ["已对账", "border-emerald-200/22 bg-emerald-300/10 text-emerald-100"]
    : status === "warning"
      ? ["部分通过", "border-amber-200/22 bg-amber-300/10 text-amber-100"]
      : status === "fail"
        ? ["禁止决策", "border-rose-200/24 bg-rose-300/12 text-rose-100"]
        : ["未导入", "border-slate-200/15 bg-white/[0.04] text-slate-300"];
  return <span className={`inline-flex shrink-0 rounded-md border px-2 py-1 text-[10px] font-bold ${meta[1]}`}>{meta[0]}</span>;
}

function LoadingState() {
  return <div className="flex h-full items-center justify-center gap-2 text-sm text-cyan-100/72"><LoaderCircle className="h-5 w-5 animate-spin" /> 正在读取经营数据...</div>;
}

function EmptyState({ onFile, onHistory, hasHistory, disabled }: { onFile: (file: File | null) => Promise<void>; onHistory: () => void; hasHistory: boolean; disabled: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-lg border border-cyan-100/18 bg-cyan-200/8 text-cyan-100"><FileSpreadsheet className="h-6 w-6" /></span>
      <h3 className="mt-4 text-xl font-black text-slate-50">还没有经营数据</h3>
      <p className="mt-2 max-w-md text-xs leading-6 text-slate-400">上传包含“店铺每日数据汇总”和“数据透视表-提取刷单”的利润表，系统会按当前登录账户独立保存并分析。</p>
      <div className="mt-5 flex items-center gap-2"><label className={`relative inline-flex items-center gap-2 overflow-hidden rounded-lg border border-cyan-200/24 bg-cyan-300/12 px-4 py-2 text-xs font-bold text-cyan-50 ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}><input type="file" accept=".xlsx,.xls" disabled={disabled} onChange={(event) => { const input = event.currentTarget; void onFile(input.files?.[0] ?? null); input.value = ""; }} aria-label="选择利润表文件" className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" /><Upload className="h-4 w-4" /> 上传利润表</label>{hasHistory && <button type="button" onClick={onHistory} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-bold text-slate-300"><History className="h-4 w-4" /> 导入记录</button>}</div>
    </div>
  );
}

function ProductAvailabilityState({ dashboard }: { dashboard: AnalyticsDashboard }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-[560px] rounded-lg border border-amber-200/18 bg-amber-300/[0.07] px-6 py-5">
        <TriangleAlert className="mx-auto h-6 w-6 text-amber-100" />
        <h3 className="mt-3 text-lg font-black text-slate-50">当前日期不能生成商品分析</h3>
        <p className="mt-2 text-xs leading-6 text-slate-300">{dashboard.dataWindows.productAnalysis.message}</p>
        <p className="mt-3 text-[11px] text-slate-500">商品原始数据范围：{dashboard.dataWindows.product.start ?? "--"} 至 {dashboard.dataWindows.product.end ?? "--"}。店铺趋势仍按店铺每日汇总正常展示。</p>
      </div>
    </div>
  );
}

function OverviewView({ dashboard, stores, onSelectStore }: { dashboard: AnalyticsDashboard; stores: StoreSummary[]; onSelectStore: (store: StoreSummary) => void }) {
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const trend = dashboard.trend;
  const activePoint = trend.find((item) => item.date === activeDate) ?? trend.at(-1) ?? null;
  const maxProfit = Math.max(1, ...trend.map((item) => Math.abs(item.actualProfit)));
  const maxStoreProfit = Math.max(1, ...stores.map((item) => Math.abs(item.actualProfit)));
  const dateLabelStep = Math.max(1, Math.ceil(trend.length / 8));
  const rankedStores = [...stores].sort((left, right) => right.actualProfit - left.actualProfit || right.gmv - left.gmv);
  const chartWidth = 1000;
  const chartHeight = 200;
  const chartMidY = chartHeight / 2;
  const chartPaddingX = 30;
  const chartAmplitude = 76;
  const chartStep = trend.length ? (chartWidth - chartPaddingX * 2) / trend.length : chartWidth - chartPaddingX * 2;
  const chartBarWidth = Math.min(48, Math.max(10, chartStep * 0.58));
  const trendBars = trend.map((item, index) => {
    const height = item.actualProfit === 0 ? 0 : Math.max(4, Math.abs(item.actualProfit) / maxProfit * chartAmplitude);
    const positive = item.actualProfit >= 0;
    return {
      ...item,
      positive,
      height,
      x: chartPaddingX + chartStep * index + (chartStep - chartBarWidth) / 2,
      y: positive ? chartMidY - height : chartMidY,
    };
  });
  const activeTrendBar = trendBars.find((item) => item.date === activePoint?.date) ?? null;
  const inlineMetrics = [
    { label: "GMV", value: `¥${compactMoney(dashboard.kpis.gmv)}`, tone: "text-slate-100" },
    { label: "消耗", value: `¥${compactMoney(dashboard.kpis.adSpend)}`, tone: "text-cyan-100" },
    { label: "利润", value: `¥${compactMoney(dashboard.kpis.actualProfit)}`, tone: valueTone(dashboard.kpis.actualProfit) },
    { label: "ROI", value: dashboard.kpis.roi.toFixed(2), tone: "text-amber-100" },
    { label: "净成交 ROI", value: dashboard.kpis.netDealRoi.toFixed(2), tone: "text-cyan-100" },
    { label: "店铺", value: `${stores.length} 家`, tone: "text-slate-100" },
  ];

  return (
    <div className="h-full min-h-0 overflow-hidden px-4 pb-4">
      <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-cyan-100/12 bg-[#061019]/18 backdrop-blur-[10px]">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-cyan-100/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <ChartNoAxesCombined className="h-4 w-4 shrink-0 text-cyan-100" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-100">经营全景</h3>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{dashboard.comparison.currentStart ?? "--"} 至 {dashboard.comparison.currentEnd ?? "--"} · {dashboard.comparison.hasPreviousData ? `对比 ${dashboard.comparison.previousStart} 至 ${dashboard.comparison.previousEnd}` : "当前周期"}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-stretch divide-x divide-cyan-100/10">
            {inlineMetrics.map((metric) => <div key={metric.label} className="min-w-[74px] px-3 first:pl-0 last:pr-0"><p className="text-[9px] text-slate-500">{metric.label}</p><p className={`mt-0.5 text-sm font-black ${metric.tone}`}>{metric.value}</p></div>)}
          </div>
        </header>

        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-h-0 flex-col border-r border-cyan-100/10 p-4">
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div><p className="text-[10px] font-bold text-slate-300">周期利润趋势</p><p className="mt-1 text-[10px] text-slate-500">悬停或点击日期查看当日经营数据</p></div>
              {activePoint && <div className="grid grid-cols-4 gap-x-4 text-right text-[10px]"><span><b className="block text-slate-100">¥{compactMoney(activePoint.gmv)}</b><em className="not-italic text-slate-500">GMV</em></span><span><b className="block text-cyan-100">¥{compactMoney(activePoint.adSpend)}</b><em className="not-italic text-slate-500">消耗</em></span><span><b className={`block ${valueTone(activePoint.actualProfit)}`}>¥{compactMoney(activePoint.actualProfit)}</b><em className="not-italic text-slate-500">利润</em></span><span><b className="block text-amber-100">¥{compactMoney(activePoint.totalRefund)}</b><em className="not-italic text-slate-500">退款</em></span></div>}
            </div>
            <div className="mt-5 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_20px]">
              <div className="relative min-h-0">
                <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-label="周期利润趋势图" role="img">
                  <rect x={chartPaddingX} y="12" width={chartWidth - chartPaddingX * 2} height={chartHeight - 24} rx="8" fill="rgba(3, 16, 24, 0.18)" stroke="rgba(103, 232, 249, 0.08)" />
                  {trendBars.map((bar) => <rect key={`track-${bar.date}`} x={bar.x} y="18" width={chartBarWidth} height={chartHeight - 36} rx="8" fill="rgba(226, 232, 240, 0.035)" />)}
                  <line x1={chartPaddingX} y1={chartMidY} x2={chartWidth - chartPaddingX} y2={chartMidY} stroke="rgba(226, 232, 240, 0.38)" strokeWidth="1.5" />
                  {trendBars.filter((bar) => bar.height > 0).map((bar) => <rect key={`glow-${bar.date}`} x={bar.x - 2} y={bar.y - 2} width={chartBarWidth + 4} height={bar.height + 4} rx="7" fill={bar.positive ? "#4cf0c4" : "#ff7897"} opacity="0.16" />)}
                  {trendBars.filter((bar) => bar.height > 0).map((bar) => <rect key={`bar-${bar.date}`} x={bar.x} y={bar.y} width={chartBarWidth} height={bar.height} rx="4" fill={bar.positive ? "#4cf0c4" : "#ff7897"} />)}
                  {activeTrendBar && <rect x={activeTrendBar.x - 3} y="15" width={chartBarWidth + 6} height={chartHeight - 30} rx="9" fill="none" stroke="rgba(103, 232, 249, 0.72)" strokeWidth="1.5" />}
                </svg>
                <div className="absolute inset-0 grid grid-flow-col auto-cols-fr">
                  {trend.map((item) => <button key={item.date} type="button" onMouseEnter={() => setActiveDate(item.date)} onFocus={() => setActiveDate(item.date)} onClick={() => setActiveDate(item.date)} title={`${item.date} · GMV ¥${money(item.gmv)} · 消耗 ¥${money(item.adSpend)} · 利润 ¥${money(item.actualProfit)}`} aria-label={`查看 ${item.date} 的经营数据`} className={`rounded-sm outline-none transition ${item.date === activePoint?.date ? "bg-cyan-200/[0.06]" : "hover:bg-white/[0.035] focus:bg-cyan-200/[0.06]"}`} />)}
                </div>
              </div>
              <div className="grid grid-flow-col auto-cols-fr pt-1.5 text-center text-[9px] text-slate-500">{trend.map((item, index) => <span key={item.date} className={item.date === activePoint?.date ? "text-cyan-100" : undefined}>{index % dateLabelStep === 0 || index === trend.length - 1 ? item.date.slice(5) : ""}</span>)}</div>
              {!trend.length && <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">当前日期范围没有经营趋势数据</p>}
            </div>
            <div className="mt-3 flex shrink-0 items-center gap-4 border-t border-cyan-100/10 pt-3 text-[10px] text-slate-500"><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-emerald-300/70" />正利润</span><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-rose-300/70" />负利润</span>{activePoint && <span className="ml-auto text-cyan-100/75">{activePoint.date} · {activePoint.maturity === "stable" ? "相对稳定" : activePoint.maturity === "settling" ? "趋于稳定" : "观察中"}</span>}</div>
          </div>

          <aside className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-cyan-100/10 px-4 py-3"><div><p className="text-[10px] font-bold text-slate-200">店铺经营排行</p><p className="mt-1 text-[10px] text-slate-500">按当前周期利润排序</p></div><span className="text-xs font-black text-cyan-100">{rankedStores.length}</span></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {rankedStores.map((store) => {
                const positive = store.actualProfit >= 0;
                const width = Math.max(3, Math.abs(store.actualProfit) / maxStoreProfit * 100);
                return <button key={store.key} type="button" onClick={() => onSelectStore(store)} className="group block w-full rounded-md px-2 py-2 text-left transition hover:bg-cyan-200/[0.06] focus:bg-cyan-200/[0.06] focus:outline-none"><span className="flex items-center justify-between gap-3"><b className="truncate text-xs text-slate-100">{store.storeName}</b><strong className={`shrink-0 text-xs ${valueTone(store.actualProfit)}`}>¥{compactMoney(store.actualProfit)}</strong></span><span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/[0.055]"><span className={`block h-full rounded-full ${positive ? "bg-emerald-300/70" : "bg-rose-300/70"}`} style={{ width: `${width}%` }} /></span><span className="mt-1.5 flex items-center justify-between text-[9px] text-slate-500"><span>GMV ¥{compactMoney(store.gmv)} · ROI {store.roi.toFixed(2)}</span><StoreStatus status={store.status} /></span></button>;
              })}
              {!rankedStores.length && <p className="flex h-full items-center justify-center text-xs text-slate-500">当前范围没有店铺数据</p>}
            </div>
          </aside>
        </div>
       </section>
   </div>
  );
}

function StoreAnalysisView({ stores, showUser, onSelect }: { stores: StoreSummary[]; showUser: boolean; onSelect: (store: StoreSummary) => void }) {
  const loss = stores.filter((item) => item.status === "loss");
  const thin = stores.filter((item) => item.status === "thin");
  const falling = stores.filter((item) => item.hasPreviousData && item.profitChange < 0);
  const lossAmount = loss.reduce((sum, item) => sum + Math.max(0, -item.actualProfit), 0);
  return <div className="grid h-full min-h-0 grid-rows-[112px_minmax(0,1fr)] overflow-hidden">
    <div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3">
      <AnalysisSummary label="当前店铺" value={`${stores.length} 家`} detail="所选账户与日期范围" />
      <AnalysisSummary label="亏损店铺" value={`${loss.length} 家`} detail={`合计亏损 ¥${money(lossAmount)}`} tone={loss.length ? "text-rose-200" : "text-emerald-200"} />
      <AnalysisSummary label="利润偏薄" value={`${thin.length} 家`} detail="利润率低于 5%" tone={thin.length ? "text-amber-100" : "text-emerald-200"} />
      <AnalysisSummary label="利润下降" value={`${falling.length} 家`} detail="对比前一等长周期" tone={falling.length ? "text-amber-100" : "text-emerald-200"} />
    </div>
    <SortableStoreTable stores={stores} showUser={showUser} onSelect={onSelect} />
  </div>;
}

function ProductAnalysisView({ products, showUser, onSelect }: { products: ProductSummary[]; showUser: boolean; onSelect: (product: ProductSummary) => void }) {
  const loss = products.filter((item) => item.profitAvailable && item.actualProfit < 0);
  const lowShipping = products.filter((item) => item.netShippingRate < 0.9);
  const lowSign = products.filter((item) => item.signRate < 0.8);
  const ratio = (count: number) => products.length ? `${(count / products.length * 100).toFixed(1)}%` : "0.0%";
  const lossAmount = loss.reduce((sum, item) => sum + Math.max(0, -item.actualProfit), 0);
  return <div className="grid h-full min-h-0 grid-rows-[132px_minmax(0,1fr)] overflow-hidden">
    <div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3">
      <AnalysisSummary label="当前筛选商品" value={`${products.length}`} detail="仅含当前日期范围内有经营数据的商品" tone="text-cyan-100" />
      <AnalysisSummary label="亏损商品" value={`${loss.length} · ${ratio(loss.length)}`} detail={`合计亏损 ¥${money(lossAmount)} · 可与履约问题重叠`} tone={loss.length ? "text-rose-200" : "text-emerald-200"} />
      <AnalysisSummary label="净发货偏低" value={`${lowShipping.length} · ${ratio(lowShipping.length)}`} detail="低于 90% · 与其他问题标签可重叠" tone={lowShipping.length ? "text-amber-100" : "text-emerald-200"} />
      <AnalysisSummary label="签收偏低" value={`${lowSign.length} · ${ratio(lowSign.length)}`} detail="低于 80% · 与其他问题标签可重叠" tone={lowSign.length ? "text-amber-100" : "text-emerald-200"} />
    </div>
    <SortableProductTable products={products} showUser={showUser} onSelect={onSelect} />
  </div>;
}

type ProductMetricSortKey =
  | "adSpend"
  | "gmv"
  | "roi"
  | "netDealRoi"
  | "paidOrders"
  | "overallShippingRate"
  | "netShippingRate"
  | "signRate"
  | "profitMargin"
  | "oneHourRefundRate"
  | "actualProfit";

type StoreMetricSortKey = ProductMetricSortKey;

const productMetricSortOptions: Array<{ key: ProductMetricSortKey; label: string }> = [
  { key: "adSpend", label: "消耗" },
  { key: "gmv", label: "成交金额" },
  { key: "roi", label: "ROI" },
  { key: "netDealRoi", label: "净成交 ROI" },
  { key: "paidOrders", label: "支付订单数" },
  { key: "overallShippingRate", label: "发货率" },
  { key: "netShippingRate", label: "净成交发货率" },
  { key: "signRate", label: "签收率" },
  { key: "profitMargin", label: "利润率" },
  { key: "oneHourRefundRate", label: "1H 退款率" },
  { key: "actualProfit", label: "真实利润" },
];

function productMetricValue(product: ProductSummary, key: ProductMetricSortKey) {
  if (key === "actualProfit") return product.profitAvailable ? product.actualProfit : null;
  if (key === "profitMargin") return productRateValue(product, key);
  if (key === "overallShippingRate" || key === "netShippingRate" || key === "signRate" || key === "oneHourRefundRate") return productRateValue(product, key);
  return product[key];
}

function storeMetricValue(store: StoreSummary, key: StoreMetricSortKey) {
  return store[key];
}

function productFallback(left: ProductSummary, right: ProductSummary) {
  return left.storeName.localeCompare(right.storeName, "zh-CN")
    || left.productName.localeCompare(right.productName, "zh-CN")
    || left.productId.localeCompare(right.productId);
}

function storeFallback(left: StoreSummary, right: StoreSummary) {
  return left.storeName.localeCompare(right.storeName, "zh-CN") || left.username.localeCompare(right.username, "zh-CN");
}

function SortableMetricHeader<Key extends string>({
  label,
  metric,
  sort,
  onSort,
  title,
}: {
  label: string;
  metric: Key;
  sort: MetricSort<Key>;
  onSort: (metric: Key) => void;
  title?: string;
}) {
  const active = sort.key === metric;
  const metricNotes: Record<string, string> = {
    adSpend: "口径：所选业务日期内，该商品关联计划的全部消耗汇总。",
    gmv: "口径：Excel 原表中的商品成交金额（GMV）。",
    roi: "口径：Excel 原表中的商品投放回报指标。",
    netDealRoi: "口径：净成交金额 ÷（消耗 - 赔付）；净成交金额已按 1H 退款率扣减。",
    paidOrders: "口径：Excel 原表中的支付订单数。",
    overallShippingRate: "口径：Excel 原表的发货率。",
    netShippingRate: "口径：Excel 原表的净成交发货率。",
    signRate: "口径：Excel 原表的签收率。",
    profitMargin: "口径：真实利润在 GMV 中的占比。",
    oneHourRefundRate: "口径：Excel 原表中的 1 小时退款率。",
    actualProfit: "口径：Excel 原表中的商品利润(Y)。",
  };
  const hint = `${metricNotes[metric] || label}${title ? ` ${title}` : ""} 点击按目标版本排序。`;
  return <th className="px-3 py-2.5 text-right">
    <button type="button" onClick={() => onSort(metric)} title={hint} aria-label={`${label}：${hint}`} className={`inline-flex items-center justify-end gap-1 whitespace-nowrap transition ${active ? "text-cyan-100" : "text-slate-400 hover:text-slate-200"}`}>
      {label}<ArrowDownUp className={`h-3 w-3 ${active && sort.direction === "asc" ? "rotate-180" : ""}`} />
    </button>
  </th>;
}

function ProductMetricSortToolbar({
  sort,
  onChange,
  query,
  onQueryChange,
  resultCount,
  totalCount,
}: {
  sort: MetricSort<ProductMetricSortKey>;
  onChange: (next: MetricSort<ProductMetricSortKey>) => void;
  query?: string;
  onQueryChange?: (value: string) => void;
  resultCount?: number;
  totalCount?: number;
}) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-b border-cyan-100/10 px-3 py-1">
    {onQueryChange && <label className="relative mr-auto flex min-w-[220px] flex-1 items-center sm:max-w-[360px]">
      <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" />
      <input value={query ?? ""} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索商品、类目、商品ID或计划ID" className="h-8 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-8 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-200/30" />
    </label>}
    {typeof resultCount === "number" && typeof totalCount === "number" && <span className="text-[10px] text-slate-500">显示 {resultCount} / {totalCount}</span>}
    <span className="text-[10px] text-slate-500">排序</span>
    <select aria-label="经营指标排序字段" value={sort.key} onChange={(event) => onChange(nextMetricSort(sort, event.target.value as ProductMetricSortKey))} className="h-8 rounded-lg border border-white/10 bg-[#0b1821]/78 px-2.5 text-xs text-slate-100 outline-none">
      {productMetricSortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
    <button type="button" onClick={() => onChange({ ...sort, direction: sort.direction === "desc" ? "asc" : "desc" })} title={sort.direction === "desc" ? "当前为从高到低" : "当前为从低到高"} aria-label="切换排序方向" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.035] text-cyan-100 transition hover:bg-cyan-200/[0.08]">
      <ArrowDownUp className={`h-3.5 w-3.5 ${sort.direction === "asc" ? "rotate-180" : ""}`} />
    </button>
  </div>;
}

function SortableProductTable({ products, showUser, onSelect }: { products: ProductSummary[]; showUser: boolean; onSelect: (product: ProductSummary) => void }) {
  const [sort, setSort] = useState<MetricSort<ProductMetricSortKey>>({ key: "actualProfit", direction: "asc" });
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query);
  const filteredProducts = useMemo(() => {
    const keyword = deferredQuery.trim().toLowerCase();
    if (!keyword) return products;
    return products.filter((item) => `${item.productName} ${item.categoryName} ${item.productId} ${item.planId ?? ""} ${item.storeName} ${item.username}`.toLowerCase().includes(keyword));
  }, [deferredQuery, products]);
  const rows = useMemo(() => sortByMetric(filteredProducts, sort, productMetricValue, productFallback), [filteredProducts, sort]);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = useMemo(() => rows.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, rows]);

  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <ProductMetricSortToolbar sort={sort} onChange={(next) => startTransition(() => setSort(next))} query={query} onQueryChange={(value) => { setQuery(value); setPage(1); }} resultCount={rows.length} totalCount={products.length} />
    <div className="min-h-0 flex-1 overflow-auto">
    <table className="w-full min-w-[2070px] border-collapse text-left text-xs">
      <thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400 backdrop-blur-xl"><tr>
        {showUser && <th className="px-3 py-2.5">用户</th>}
        <th className="px-3 py-2.5">商品信息</th><th className="px-3 py-2.5">计划 / 最新经营日</th>
        <SortableMetricHeader label="消耗" metric="adSpend" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="成交金额" metric="gmv" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="ROI" metric="roi" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} title="原表 ROI" />
        <SortableMetricHeader label="净成交 ROI" metric="netDealRoi" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="支付订单数" metric="paidOrders" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="发货率" metric="overallShippingRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} title="整体发货率" />
        <SortableMetricHeader label="净成交发货率" metric="netShippingRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="签收率" metric="signRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="利润率" metric="profitMargin" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="1H 退款率" metric="oneHourRefundRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="真实利润" metric="actualProfit" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <th className="px-3 py-2.5">经营判断</th>
      </tr></thead>
      <tbody className="divide-y divide-white/[0.055]">
        {pageRows.map((product) => <tr key={product.key} onClick={() => onSelect(product)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]">
          {showUser && <td className="px-3 py-2.5 text-cyan-100/72">{product.username}</td>}
          <td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{product.productName}</span><span className="mt-1 block text-[10px] text-slate-400">{product.storeName} · {product.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {product.productId}</span></td>
          <td className="px-3 py-2.5"><span className="block font-mono text-[10px] text-cyan-100/75">{product.planId || "计划待关联"}</span><span className="mt-1 block text-[10px] text-slate-400">最新 {product.latestMetricDate || "--"}</span></td>
          <td className="px-3 py-2.5 text-right">¥{money(product.adSpend)}</td><td className="px-3 py-2.5 text-right">¥{money(product.gmv)}</td><td className="px-3 py-2.5 text-right text-cyan-100">{product.roi.toFixed(2)}</td><td className="px-3 py-2.5 text-right font-bold text-cyan-100">{product.netDealRoi.toFixed(2)}</td><td className="px-3 py-2.5 text-right">{product.paidOrders}</td><td className="px-3 py-2.5 text-right">{productPercent(product, "overallShippingRate")}</td><td className="px-3 py-2.5 text-right">{productPercent(product, "netShippingRate")}</td><td className="px-3 py-2.5 text-right">{productPercent(product, "signRate")}</td><td className="px-3 py-2.5 text-right">{productPercent(product, "profitMargin")}</td><td className="px-3 py-2.5 text-right">{productPercent(product, "oneHourRefundRate")}</td><td className={`px-3 py-2.5 text-right font-bold ${product.profitAvailable ? valueTone(product.actualProfit) : "text-slate-500"}`}>{productProfit(product)}</td><td className="px-3 py-2.5"><DecisionBadge decision={product.decision} /></td>
        </tr>)}
        {!rows.length && <tr><td colSpan={showUser ? 15 : 14} className="px-4 py-12 text-center text-slate-500">当前日期和店铺范围内没有经营商品</td></tr>}
      </tbody>
    </table>
    </div>
    {rows.length > pageSize && <div className="flex shrink-0 items-center justify-between gap-3 border-t border-cyan-100/10 bg-[#061019]/70 px-3 py-2 text-[11px] text-slate-400 backdrop-blur-xl">
      <span>显示 {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, rows.length)} / {rows.length} 个商品</span>
      <div className="flex items-center gap-2">
        <button type="button" data-border-glow onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={currentPage === 1} className="h-7 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[10px] font-bold text-slate-200 transition hover:bg-cyan-200/[0.08] disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
        <span className="min-w-[64px] text-center text-cyan-100">第 {currentPage} / {pageCount} 页</span>
        <button type="button" data-border-glow onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={currentPage === pageCount} className="h-7 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[10px] font-bold text-slate-200 transition hover:bg-cyan-200/[0.08] disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
      </div>
    </div>}
  </div>;
}

function SortableStoreTable({ stores, showUser, onSelect }: { stores: StoreSummary[]; showUser: boolean; onSelect: (store: StoreSummary) => void }) {
  const [sort, setSort] = useState<MetricSort<StoreMetricSortKey>>({ key: "actualProfit", direction: "asc" });
  const rows = sortByMetric(stores, sort, storeMetricValue, storeFallback);
  return <div className="h-full overflow-auto">
    <table className="w-full min-w-[1860px] border-collapse text-left text-xs">
      <thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400 backdrop-blur-xl"><tr>
        {showUser && <th className="px-3 py-2.5">用户</th>}
        <th className="px-3 py-2.5">店铺</th>
        <SortableMetricHeader label="消耗" metric="adSpend" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="成交金额" metric="gmv" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="ROI" metric="roi" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="净成交 ROI" metric="netDealRoi" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="支付订单数" metric="paidOrders" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="发货率" metric="overallShippingRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} title="由本期商品汇总计算" />
        <SortableMetricHeader label="净成交发货率" metric="netShippingRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="签收率" metric="signRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="利润率" metric="profitMargin" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="1H 退款率" metric="oneHourRefundRate" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <SortableMetricHeader label="真实利润" metric="actualProfit" sort={sort} onSort={(metric) => setSort(nextMetricSort(sort, metric))} />
        <th className="px-3 py-2.5 text-right">利润波动</th>
        <th className="px-3 py-2.5">状态</th>
      </tr></thead>
      <tbody className="divide-y divide-white/[0.055]">
        {rows.map((store) => <tr key={store.key} onClick={() => onSelect(store)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]">
          {showUser && <td className="px-3 py-2.5 text-cyan-100/72">{store.username}</td>}
          <td className="px-3 py-2.5 font-bold text-slate-100">{store.storeName}</td><td className="px-3 py-2.5 text-right">¥{money(store.adSpend)}</td><td className="px-3 py-2.5 text-right">¥{money(store.gmv)}</td><td className="px-3 py-2.5 text-right text-cyan-100">{store.roi.toFixed(2)}</td><td className="px-3 py-2.5 text-right font-bold text-cyan-100">{store.netDealRoi.toFixed(2)}</td><td className="px-3 py-2.5 text-right">{store.paidOrders}</td><td className="px-3 py-2.5 text-right">{percentOrDash(store.overallShippingRate)}</td><td className="px-3 py-2.5 text-right">{percentOrDash(store.netShippingRate)}</td><td className="px-3 py-2.5 text-right">{percentOrDash(store.signRate)}</td><td className="px-3 py-2.5 text-right">{percent(store.profitMargin)}</td><td className="px-3 py-2.5 text-right">{percentOrDash(store.oneHourRefundRate)}</td><td className={`px-3 py-2.5 text-right font-bold ${valueTone(store.actualProfit)}`}>¥{money(store.actualProfit)}</td><td className={`px-3 py-2.5 text-right font-bold ${valueTone(store.profitChange)}`}>{moneyChange(store.hasPreviousData, store.profitChange)}</td><td className="px-3 py-2.5"><StoreStatus status={store.status} /></td>
        </tr>)}
        {!rows.length && <tr><td colSpan={showUser ? 15 : 14} className="px-4 py-12 text-center text-slate-500">当前筛选范围没有店铺数据</td></tr>}
      </tbody>
    </table>
  </div>;
}

/* Legacy grouped table retained temporarily for source-history readability.
type OperatingProductSort =
  | "profit_asc" | "profit_desc"
  | "latest_desc" | "latest_asc"
  | "spend_desc" | "spend_asc"
  | "gmv_desc" | "gmv_asc"
  | "roi_desc" | "roi_asc"
  | "shipping_desc" | "shipping_asc"
  | "sign_desc" | "sign_asc"
  | "refund_desc" | "refund_asc";

function OperatingProductTable({ products, showUser, onSelect }: { products: ProductSummary[]; showUser: boolean; onSelect: (product: ProductSummary) => void }) {
  const [sort, setSort] = useState<OperatingProductSort>("profit_asc");
  const sortedProducts = [...products].sort((left, right) => {
    const fallback = () => left.storeName.localeCompare(right.storeName, "zh-CN") || left.productName.localeCompare(right.productName, "zh-CN") || left.productId.localeCompare(right.productId);
    const numberOrder = (leftValue: number, rightValue: number, descending: boolean) => (descending ? rightValue - leftValue : leftValue - rightValue) || fallback();
    if (sort === "latest_desc") return (right.latestMetricDate ?? "").localeCompare(left.latestMetricDate ?? "") || fallback();
    if (sort === "latest_asc") return (left.latestMetricDate ?? "").localeCompare(right.latestMetricDate ?? "") || fallback();
    if (sort === "spend_desc") return numberOrder(left.adSpend, right.adSpend, true);
    if (sort === "spend_asc") return numberOrder(left.adSpend, right.adSpend, false);
    if (sort === "gmv_desc") return numberOrder(left.gmv, right.gmv, true);
    if (sort === "gmv_asc") return numberOrder(left.gmv, right.gmv, false);
    if (sort === "profit_desc") return numberOrder(left.actualProfit, right.actualProfit, true);
    if (sort === "roi_desc") return numberOrder(left.netDealRoi, right.netDealRoi, true);
    if (sort === "roi_asc") return numberOrder(left.netDealRoi, right.netDealRoi, false);
    if (sort === "shipping_desc") return numberOrder(left.netShippingRate, right.netShippingRate, true);
    if (sort === "shipping_asc") return numberOrder(left.netShippingRate, right.netShippingRate, false);
    if (sort === "sign_desc") return numberOrder(left.signRate, right.signRate, true);
    if (sort === "sign_asc") return numberOrder(left.signRate, right.signRate, false);
    if (sort === "refund_desc") return numberOrder(left.oneHourRefundRate, right.oneHourRefundRate, true);
    if (sort === "refund_asc") return numberOrder(left.oneHourRefundRate, right.oneHourRefundRate, false);
    return numberOrder(left.actualProfit, right.actualProfit, false);
  });

  return <div className="grid h-full min-h-0 grid-rows-[48px_minmax(0,1fr)] overflow-hidden">
    <div className="flex items-center gap-2 border-b border-cyan-100/10 px-3">
      <p className="min-w-0 flex-1 truncate text-[10px] text-slate-500">仅保留当前范围内有经营数据的商品；点击商品可查看右侧经营诊断。</p>
      <select aria-label="经营商品排序" value={sort} onChange={(event) => setSort(event.target.value as OperatingProductSort)} className="h-8 shrink-0 rounded-lg border border-white/10 bg-[#0b1821]/78 px-2.5 text-xs text-slate-100 outline-none">
        <option value="profit_asc">真实利润最低</option><option value="profit_desc">真实利润最高</option>
        <option value="latest_desc">最近经营日期</option><option value="latest_asc">最早经营日期</option>
        <option value="spend_desc">消耗最高</option><option value="spend_asc">消耗最低</option>
        <option value="gmv_desc">成交最高</option><option value="gmv_asc">成交最低</option>
        <option value="roi_desc">净成交 ROI 最高</option><option value="roi_asc">净成交 ROI 最低</option>
        <option value="shipping_desc">净成交发货率最高</option><option value="shipping_asc">净成交发货率最低</option>
        <option value="sign_desc">签收率最高</option><option value="sign_asc">签收率最低</option>
        <option value="refund_desc">1 小时退款率最高</option><option value="refund_asc">1 小时退款率最低</option>
      </select>
      <button type="button" onClick={() => setSort("profit_asc")} title="重置经营商品排序" aria-label="重置经营商品排序" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.035] text-slate-300 transition hover:bg-white/[0.07]"><FilterX className="h-3.5 w-3.5" /></button>
    </div>
    <div className="h-full overflow-auto">
      <table className="w-full min-w-[1230px] border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400 backdrop-blur-xl"><tr>{showUser && <th className="px-3 py-2.5">用户</th>}<th className="px-3 py-2.5">商品信息</th><th className="px-3 py-2.5">计划 / 最新经营日</th><th className="px-3 py-2.5 text-right">投放 / 成交</th><th className="px-3 py-2.5 text-right">利润 / 净成交 ROI</th><th className="px-3 py-2.5 text-right">净发货 / 签收</th><th className="px-3 py-2.5">售后 / 经营判断</th></tr></thead>
        <tbody className="divide-y divide-white/[0.055]">
          {sortedProducts.map((product) => <tr key={product.key} onClick={() => onSelect(product)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]">
            {showUser && <td className="px-3 py-2.5 text-cyan-100/72">{product.username}</td>}
            <td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{product.productName}</span><span className="mt-1 block text-[10px] text-slate-400">{product.storeName} · {product.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {product.productId}</span></td>
            <td className="px-3 py-2.5"><span className="block font-mono text-[10px] text-cyan-100/75">{product.planId || "计划待关联"}</span><span className="mt-1 block text-[10px] text-slate-400">最新 {product.latestMetricDate || "—"}</span></td>
            <td className="px-3 py-2.5 text-right"><span className="block">消耗 ¥{money(product.adSpend)}</span><span className="mt-1 block text-[10px] text-slate-400">成交 ¥{money(product.gmv)}</span></td>
            <td className="px-3 py-2.5 text-right"><span className={`block font-bold ${product.profitAvailable ? valueTone(product.actualProfit) : "text-slate-500"}`}>{productProfit(product)}</span><span className="mt-1 block text-[10px] text-cyan-100/75">净成交 ROI {product.netDealRoi.toFixed(2)}</span></td>
            <td className="px-3 py-2.5 text-right"><span className="block">发货 {productPercent(product, "netShippingRate")}</span><span className="mt-1 block text-[10px] text-slate-400">签收 {productPercent(product, "signRate")}</span></td>
            <td className="px-3 py-2.5"><span className="block text-[10px] text-slate-400">1H 退款 {productPercent(product, "oneHourRefundRate")}</span><span className="mt-1.5 inline-flex"><DecisionBadge decision={product.decision} /></span></td>
          </tr>)}
          {!sortedProducts.length && <tr><td colSpan={showUser ? 7 : 6} className="px-4 py-12 text-center text-slate-500">当前日期和店铺范围内没有经营商品</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

*/
function AnalysisSummary({ label, value, detail, tone = "text-slate-50", className = "" }: { label: string; value: string; detail: string; tone?: string; className?: string }) {
  return <div className={`flex h-full min-h-[88px] min-w-0 flex-col rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 ${className}`}><p className="text-[10px] text-slate-500">{label}</p><p className={`mt-1 truncate text-lg font-black ${tone}`}>{value}</p><p className="mt-auto truncate text-[10px] text-slate-500">{detail}</p></div>;
}

/* Legacy store table retained temporarily for source-history readability.
function StoreTable({ stores, showUser, onSelect, compact = false }: { stores: StoreSummary[]; showUser: boolean; onSelect: (store: StoreSummary) => void; compact?: boolean }) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full min-w-[1040px] border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] uppercase text-slate-400 backdrop-blur-xl"><tr>{showUser && <th className="px-3 py-2.5">用户</th>}<th className="px-3 py-2.5">店铺</th><th className="px-3 py-2.5 text-right">Excel GMV</th><th className="px-3 py-2.5 text-right">GMV波动</th><th className="px-3 py-2.5 text-right">消耗</th><th className="px-3 py-2.5 text-right">消耗波动</th><th className="px-3 py-2.5 text-right">Excel 利润</th><th className="px-3 py-2.5 text-right">利润波动</th><th className="px-3 py-2.5 text-right">利润率</th><th className="px-3 py-2.5 text-right">ROI</th><th className="px-3 py-2.5 text-right">退款波动</th><th className="px-3 py-2.5">状态</th></tr></thead>
        <tbody className="divide-y divide-white/[0.055]">
          {stores.map((store) => <tr key={store.key} onClick={() => onSelect(store)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]">{showUser && <td className="px-3 py-2.5 text-cyan-100/72">{store.username}</td>}<td className="px-3 py-2.5 font-bold text-slate-100">{store.storeName}</td><td className="px-3 py-2.5 text-right">¥{money(store.gmv)}</td><td className={`px-3 py-2.5 text-right ${valueTone(store.gmvChange)}`}>{moneyChange(store.hasPreviousData, store.gmvChange)}</td><td className="px-3 py-2.5 text-right">¥{money(store.adSpend)}</td><td className={`px-3 py-2.5 text-right ${valueTone(-store.adSpendChange)}`}>{moneyChange(store.hasPreviousData, store.adSpendChange)}</td><td className={`px-3 py-2.5 text-right font-bold ${valueTone(store.actualProfit)}`}>¥{money(store.actualProfit)}</td><td className={`px-3 py-2.5 text-right font-bold ${valueTone(store.profitChange)}`}>{moneyChange(store.hasPreviousData, store.profitChange)}</td><td className="px-3 py-2.5 text-right">{percent(store.profitMargin)}</td><td className="px-3 py-2.5 text-right">{store.roi.toFixed(2)}</td><td className={`px-3 py-2.5 text-right ${valueTone(-store.refundChange)}`}>{moneyChange(store.hasPreviousData, store.refundChange)}</td><td className="px-3 py-2.5"><StoreStatus status={store.status} /></td></tr>)}
          {!stores.length && <tr><td colSpan={showUser ? 12 : 11} className="px-4 py-12 text-center text-slate-500">当前筛选范围没有店铺数据</td></tr>}
        </tbody>
      </table>
      {compact && stores.length > 0 && <div className="sr-only">点击店铺查看诊断详情</div>}
    </div>
  );
}

*/
function StoreStatus({ status }: { status: StoreSummary["status"] }) {
  const meta = status === "profit"
    ? ["重点经营", "border-emerald-200/20 bg-emerald-300/10 text-emerald-100"]
    : status === "thin"
      ? ["利润偏薄", "border-amber-200/20 bg-amber-300/10 text-amber-100"]
      : status === "loss"
        ? ["经营亏损", "border-rose-200/20 bg-rose-300/10 text-rose-100"]
        : status === "gmv_variance"
          ? ["GMV 口径差异", "border-amber-200/20 bg-amber-300/10 text-amber-100"]
          : ["数据异常", "border-violet-200/20 bg-violet-300/10 text-violet-100"];
  return <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${meta[1]}`}>{meta[0]}</span>;
}

function DecisionBadge({ decision }: { decision: AnalyticsDecision }) {
  const meta = decisionMeta[decision];
  return <span className={`inline-flex whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-bold ${meta.className}`}>{meta.label}</span>;
}

function MaturityBadge({ maturity }: { maturity: ProductSummary["maturity"] }) {
  const meta = maturity === "stable" ? ["相对稳定", "border-emerald-200/20 bg-emerald-300/10 text-emerald-100"] : maturity === "settling" ? ["趋于稳定", "border-amber-200/20 bg-amber-300/10 text-amber-100"] : ["观察中", "border-cyan-200/20 bg-cyan-300/10 text-cyan-100"];
  return <span className={`inline-flex whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-bold ${meta[1]}`}>{meta[0]}</span>;
}

function VersionComparisonGrid({
  rows,
  sort,
  onSort,
  currentPage,
  pageCount,
  total,
  onPageChange,
}: {
  rows: RevisionRow[];
  sort: MetricSort<RevisionMetricSortKey>;
  onSort: (metric: RevisionMetricSortKey) => void;
  currentPage: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const leftPaneRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const syncVerticalScroll = (source: "left" | "right", scrollTop: number) => {
    const target = source === "left" ? rightPaneRef.current : leftPaneRef.current;
    if (target && Math.abs(target.scrollTop - scrollTop) > 1) target.scrollTop = scrollTop;
  };
  const changeLabel = (previous: number, current: number, value: number, formatter: (item: number) => string) => {
    if (Math.abs(value) < 0.000001) return "持平";
    if (formatter === percent) {
      const points = `${Math.abs(value * 100).toFixed(1)} 个点`;
      return previous < 0 || current < 0 ? `利润率${value > 0 ? "改善" : "转差"} ${points}` : `${value > 0 ? "上升" : "下降"} ${points}`;
    }
    const formatted = formatter(Math.abs(value));
    if (formatted.startsWith("¥")) return `${value > 0 ? "增加" : "减少"} ${formatted}`;
    return `${value > 0 ? "上升" : "下降"} ${formatted}`;
  };
  const metricCell = (previous: number, current: number, change: number, formatter: (item: number) => string, tone = valueTone(change)) => <td className="px-3 py-2.5 text-right"><span className="block whitespace-nowrap text-slate-200">{formatter(previous)} <span className="text-slate-600">→</span> {formatter(current)}</span><span className={`mt-1 block whitespace-nowrap text-[10px] font-bold ${tone}`}>{changeLabel(previous, current, change, formatter)}</span></td>;
  const leftRowClass = "h-[66px] border-b border-white/[0.055] text-slate-300";
  const rightRowClass = "h-[66px] border-b border-white/[0.055] text-slate-300";

  return <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_34px] overflow-hidden">
    <div className="grid min-h-0 grid-cols-[530px_minmax(0,1fr)] overflow-hidden">
      <div ref={leftPaneRef} onScroll={(event) => syncVerticalScroll("left", event.currentTarget.scrollTop)} className="min-h-0 overflow-y-auto overflow-x-hidden border-r border-cyan-100/14 bg-[#061119]/92">
        <table className="w-full table-fixed text-left text-xs">
          <colgroup><col className="w-[190px]" /><col /></colgroup>
          <thead className="sticky top-0 z-10 bg-[#0a1720]/98 text-[10px] text-slate-400"><tr className="h-11"><th className="px-3 py-2.5">业务日期 / 版本</th><th className="px-3 py-2.5">店铺 / 商品 / 计划</th></tr></thead>
          <tbody>{rows.map((item) => <tr key={item.key} className={leftRowClass}><td className="px-3 py-2.5"><span className="block whitespace-nowrap font-bold text-slate-100">{item.metricDate}</span><span className="mt-1 block whitespace-nowrap text-[10px] text-slate-500">{item.previousSnapshotDate} → {item.currentSnapshotDate}</span></td><td className="px-3 py-2.5"><span className="block truncate font-bold text-slate-100">{item.storeName} · {item.categoryName}</span><span className="mt-1 block truncate font-mono text-[10px] text-slate-500">商品 {item.productId} · 计划 {item.planId || "未匹配"}</span></td></tr>)}{!rows.length && <tr className={leftRowClass}><td colSpan={2} className="px-4 py-12 text-center text-slate-500">当前范围没有历史修订</td></tr>}</tbody>
        </table>
      </div>
      <div ref={rightPaneRef} onScroll={(event) => syncVerticalScroll("right", event.currentTarget.scrollTop)} className="min-h-0 overflow-auto bg-[#061019]/34">
        <table className="w-full min-w-[2080px] table-fixed text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[#0a1720]/98 text-[10px] text-slate-400"><tr className="h-11"><SortableMetricHeader label="消耗" metric="adSpend" sort={sort} onSort={onSort} /><SortableMetricHeader label="成交金额" metric="gmv" sort={sort} onSort={onSort} /><SortableMetricHeader label="ROI" metric="roi" sort={sort} onSort={onSort} title="按目标版本 ROI 排序" /><SortableMetricHeader label="净成交 ROI" metric="netDealRoi" sort={sort} onSort={onSort} /><SortableMetricHeader label="支付订单数" metric="paidOrders" sort={sort} onSort={onSort} /><SortableMetricHeader label="发货率" metric="overallShippingRate" sort={sort} onSort={onSort} /><SortableMetricHeader label="净成交发货率" metric="netShippingRate" sort={sort} onSort={onSort} /><SortableMetricHeader label="签收率" metric="signRate" sort={sort} onSort={onSort} /><SortableMetricHeader label="利润率" metric="profitMargin" sort={sort} onSort={onSort} /><SortableMetricHeader label="1H 退款率" metric="oneHourRefundRate" sort={sort} onSort={onSort} /><SortableMetricHeader label="真实利润" metric="actualProfit" sort={sort} onSort={onSort} /></tr></thead>
          <tbody>{rows.map((item) => <tr key={item.key} className={rightRowClass}>{metricCell(item.previousAdSpend, item.currentAdSpend, item.adSpendChange, (value) => `¥${money(value)}`)}{metricCell(item.previousGmv, item.currentGmv, item.gmvChange, (value) => `¥${money(value)}`)}{metricCell(item.previousRoi, item.currentRoi, item.roiChange, (value) => value.toFixed(2))}{metricCell(item.previousNetDealRoi, item.currentNetDealRoi, item.netDealRoiChange, (value) => value.toFixed(2))}{metricCell(item.previousPaidOrders, item.currentPaidOrders, item.paidOrdersChange, (value) => `${Math.round(value)}`)}{metricCell(item.previousOverallShippingRate, item.currentOverallShippingRate, item.overallShippingRateChange, percent)}{metricCell(item.previousNetShippingRate, item.currentNetShippingRate, item.netShippingRateChange, percent)}{metricCell(item.previousSignRate, item.currentSignRate, item.signRateChange, percent)}{metricCell(item.previousProfitMargin, item.currentProfitMargin, item.profitMarginChange, percent)}{metricCell(item.previousOneHourRefundRate, item.currentOneHourRefundRate, item.oneHourRefundRateChange, percent, valueTone(-item.oneHourRefundRateChange))}{metricCell(item.previousActualProfit, item.currentActualProfit, item.actualProfitChange, (value) => `¥${money(value)}`)}</tr>)}{!rows.length && <tr className={rightRowClass}><td colSpan={11} className="px-4 py-12 text-center text-slate-500">选择其他版本对比或调整日期范围后重试</td></tr>}</tbody>
        </table>
      </div>
    </div>
    {pageCount > 1 && <div className="flex items-center justify-end gap-2 border-t border-cyan-100/10 bg-[#07151e]/94 px-3 py-2 text-[10px] text-slate-400"><span className="mr-auto">第 {currentPage + 1} / {pageCount} 页 · 共 {total} 条历史修订</span><button type="button" disabled={currentPage === 0} onClick={() => onPageChange(Math.max(0, currentPage - 1))} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 disabled:opacity-35">上一页</button><button type="button" disabled={currentPage >= pageCount - 1} onClick={() => onPageChange(Math.min(pageCount - 1, currentPage + 1))} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 disabled:opacity-35">下一页</button></div>}
  </div>;
}

/*
function RevisionSignalsView({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const statusLabel = (status: AnalyticsDashboard["revisionSignals"][number]["status"]) => status === "initial_low" ? "初始偏低" : status === "worsening" ? "后续恶化" : status === "improving" ? "逐步改善" : status === "stable" ? "相对稳定" : "观察中";
  const initialLow = dashboard.revisionSignals.filter((item) => item.initialLow).length;
  const worsening = dashboard.revisionSignals.filter((item) => item.worsening).length;
  const improving = dashboard.revisionSignals.filter((item) => item.status === "improving").length;
  return <div className="grid h-full min-h-0 grid-rows-[88px_minmax(0,1fr)] overflow-hidden"><div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3"><AnalysisSummary label="快照信号" value={`${dashboard.revisionSignals.length}`} detail="同一业务日期跨批次比较" /><AnalysisSummary label="初始偏低" value={`${initialLow}`} detail="首次快照已经偏低" tone={initialLow ? "text-rose-200" : "text-emerald-200"} /><AnalysisSummary label="继续恶化" value={`${worsening}`} detail="最新快照进一步下降" tone={worsening ? "text-amber-100" : "text-emerald-200"} /><AnalysisSummary label="逐步改善" value={`${improving}`} detail="最新发货或签收回升" tone="text-emerald-200" /></div><div className="overflow-auto"><table className="w-full min-w-[1480px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">业务日期 / 快照</th><th className="px-3 py-2.5">店铺 / 商品 / 计划</th><th className="px-3 py-2.5">类目</th><th className="px-3 py-2.5 text-right">首次净发货</th><th className="px-3 py-2.5 text-right">最新净发货</th><th className="px-3 py-2.5 text-right">变化</th><th className="px-3 py-2.5 text-right">首次签收</th><th className="px-3 py-2.5 text-right">最新签收</th><th className="px-3 py-2.5 text-right">变化</th><th className="px-3 py-2.5">成熟度</th><th className="px-3 py-2.5">判断</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{dashboard.revisionSignals.map((item) => <tr key={item.key} className="text-slate-300"><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.metricDate}</span><span className="mt-1 block text-[10px] text-slate-500">{item.firstSnapshotDate} → {item.latestSnapshotDate}</span></td><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.storeName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {item.productId} · 计划 {item.planId || "未匹配"}</span></td><td className="px-3 py-2.5">{item.categoryName}</td><td className="px-3 py-2.5 text-right">{percent(item.firstNetShippingRate)}</td><td className="px-3 py-2.5 text-right">{percent(item.latestNetShippingRate)}</td><td className={`px-3 py-2.5 text-right ${valueTone(item.netShippingRateChange)}`}>{item.netShippingRateChange >= 0 ? "+" : ""}{percent(item.netShippingRateChange)}</td><td className="px-3 py-2.5 text-right">{percent(item.firstSignRate)}</td><td className="px-3 py-2.5 text-right">{percent(item.latestSignRate)}</td><td className={`px-3 py-2.5 text-right ${valueTone(item.signRateChange)}`}>{item.signRateChange >= 0 ? "+" : ""}{percent(item.signRateChange)}</td><td className="px-3 py-2.5">{item.maturity === "stable" ? "相对稳定" : item.maturity === "settling" ? "趋于稳定" : "观察中"}</td><td className="px-3 py-2.5"><span className={`rounded-md border px-2 py-1 text-[10px] font-bold ${item.initialLow ? "border-rose-200/20 bg-rose-300/10 text-rose-100" : item.worsening ? "border-amber-200/20 bg-amber-300/10 text-amber-100" : "border-cyan-200/20 bg-cyan-300/10 text-cyan-100"}`}>{statusLabel(item.status)}</span>{item.initialLow && item.worsening && <span className="ml-1 text-[10px] text-rose-200">且继续下降</span>}</td></tr>)}{!dashboard.revisionSignals.length && <tr><td colSpan={11} className="px-4 py-12 text-center text-slate-500">新快照基线建立后，这里会显示同一业务日期在历次上传中的发货与签收变化。</td></tr>}</tbody></table></div></div>;
}

*/

type TraceRow = {
  sourceRow: number;
  storeName: string;
  mainOrderId: string;
  productName: string;
  productId: string;
  storeProductKey: string;
  metricDate: string;
  orderAmount: number;
  orderStatus: string;
  aftersaleStatus: string;
  productCost: number | null;
  isFakeOrder: boolean;
};

function TraceView({ importId, onNotice, onError }: { importId: string | null; onNotice: (value: string) => void; onError: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function searchTrace() {
    if (!importId) return;
    setLoading(true);
    onError("");
    try {
      const params = new URLSearchParams({ importId, query });
      const response = await fetch(`/api/analytics/trace?${params}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "原始行追溯失败");
      setRows(Array.isArray(body.rows) ? body.rows : []);
      onNotice(`已找到 ${body.resultCount ?? 0} 条原始订单记录。`);
    } catch (error) {
      onError(error instanceof Error ? error.message : "原始行追溯失败");
    } finally {
      setLoading(false);
    }
  }

  if (!importId) return <div className="flex h-full items-center justify-center text-sm text-slate-500">请先确认并正式导入一个利润表批次</div>;
  return <div className="h-full min-h-0 overflow-hidden">
    <section className="h-full min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-cyan-100/10 p-3"><ScanSearch className="h-4 w-4 text-cyan-100" /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") searchTrace(); }} placeholder="订单号、商品ID、店铺商品键或日期" className="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.035] px-3 text-xs text-slate-100 outline-none" /><button type="button" onClick={searchTrace} disabled={loading} className="h-8 rounded-lg border border-cyan-100/18 bg-cyan-200/9 px-3 text-xs font-bold text-cyan-50">{loading ? "查找中" : "追溯原始行"}</button></div>
      <div className="h-[calc(100%-57px)] overflow-auto"><table className="w-full min-w-[1080px] text-left text-xs"><thead className="sticky top-0 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">来源行</th><th className="px-3 py-2.5">日期 / 店铺</th><th className="px-3 py-2.5">订单号</th><th className="px-3 py-2.5">商品</th><th className="px-3 py-2.5 text-right">实付</th><th className="px-3 py-2.5 text-right">Excel 成本</th><th className="px-3 py-2.5">订单 / 售后</th><th className="px-3 py-2.5">原表规则</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{rows.map((row) => <tr key={`${row.sourceRow}:${row.mainOrderId}`} className="text-slate-300"><td className="px-3 py-2.5 font-mono text-cyan-100/65">{row.sourceRow}</td><td className="px-3 py-2.5"><span className="block">{row.metricDate}</span><span className="text-[10px] text-slate-500">{row.storeName}</span></td><td className="px-3 py-2.5 font-mono text-[10px]">{row.mainOrderId}</td><td className="max-w-[300px] px-3 py-2.5"><span className="block truncate text-slate-100">{row.productName}</span><span className="mt-1 block max-w-full truncate font-mono text-[10px] text-cyan-100/55">{row.storeProductKey}</span></td><td className="px-3 py-2.5 text-right">¥{money(row.orderAmount)}</td><td className="px-3 py-2.5 text-right">{row.productCost === null ? <span className="text-rose-100">缺失</span> : `¥${money(row.productCost)}`}</td><td className="px-3 py-2.5"><span className="block">{row.orderStatus || "--"}</span><span className="text-[10px] text-slate-500">{row.aftersaleStatus || "--"}</span></td><td className="px-3 py-2.5">{row.isFakeOrder ? <span className="text-violet-100">应付小于20</span> : <span className="text-slate-300">普通订单</span>}</td></tr>)}{!rows.length && <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">输入条件后可追溯到原始 Excel 行；手机号和地址不会返回页面，也不会修改利润表。</td></tr>}</tbody></table></div>
    </section>
  </div>;
}

/* Legacy compact comparison table retained temporarily for source-history readability.
function RevisionSignalsView({ dashboard, baselineId, targetId, canSelectPair, onPairChange, onResetPair }: {
  dashboard: AnalyticsDashboard;
  baselineId: string;
  targetId: string;
  canSelectPair: boolean;
  onPairChange: (baselineId: string, targetId: string) => void;
  onResetPair: () => void;
}) {
  const [page, setPage] = useState(0);
  const pageSize = 60;
  const comparison = dashboard.versionComparison;
  const completedVersions = dashboard.history.filter((item) => item.status === "completed" && item.snapshotDate);
  const activeBaselineId = baselineId || comparison.baseline?.id || "";
  const activeTargetId = targetId || comparison.target?.id || "";
  const total = dashboard.revisionSignals.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = dashboard.revisionSignals.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const summary = comparison.summary;
  const profitChange = summary.currentActualProfit - summary.previousActualProfit;
  const addedDateLabel = summary.addedBusinessDates.length ? summary.addedBusinessDates.slice(0, 2).join("、") + (summary.addedBusinessDates.length > 2 ? ` 等 ${summary.addedBusinessDates.length} 天` : "") : "无新增业务日期";
  const missingDateLabel = summary.missingBusinessDates.length ? summary.missingBusinessDates.slice(0, 2).join("、") + (summary.missingBusinessDates.length > 2 ? ` 等 ${summary.missingBusinessDates.length} 天` : "") : "无整日缺失";

  const changeLabel = (value: number, formatter: (item: number) => string) => `${value >= 0 ? "+" : ""}${formatter(value)}`;
  const metricCell = (previous: number, current: number, change: number, formatter: (item: number) => string, tone = valueTone(change)) => (
    <td className="px-3 py-2.5 text-right"><span className="block text-slate-200">{formatter(previous)} <span className="text-slate-600">→</span> {formatter(current)}</span><span className={`mt-1 block text-[10px] font-bold ${tone}`}>{changeLabel(change, formatter)}</span></td>
  );
  const updatePair = (nextBaselineId: string, nextTargetId: string) => {
    if (!nextBaselineId || !nextTargetId || nextBaselineId === nextTargetId) return;
    const baselineIndex = completedVersions.findIndex((item) => item.id === nextBaselineId);
    const targetIndex = completedVersions.findIndex((item) => item.id === nextTargetId);
    if (baselineIndex < 0 || targetIndex < 0) return;
    const [normalizedBaseline, normalizedTarget] = baselineIndex > targetIndex ? [nextBaselineId, nextTargetId] : [nextTargetId, nextBaselineId];
    setPage(0);
    onPairChange(normalizedBaseline, normalizedTarget);
  };

  if (!comparison.available) {
    return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md text-center"><GitCompareArrows className="mx-auto h-7 w-7 text-cyan-100/70" /><h3 className="mt-3 text-lg font-black text-slate-50">利润表版本对比</h3><p className="mt-2 text-xs leading-6 text-slate-400">{comparison.message || "至少需要两份正式利润表，才能查看版本之间的历史修订与新增经营数据。"}</p></div></div>;
  }

  return <div className="grid h-full min-h-0 grid-rows-[188px_minmax(0,1fr)] overflow-hidden">
    <div className="border-b border-cyan-100/10 p-3">
      <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-slate-100">利润表版本对比</p><p className="mt-1 text-[10px] text-slate-500">主表始终只显示基准版 → 目标版；新增第三份及以后版本可在右侧选择任意两份，不增加表格列。</p></div>{canSelectPair && completedVersions.length >= 2 ? <div className="flex items-center gap-2"><select aria-label="基准利润表版本" value={activeBaselineId} onChange={(event) => updatePair(event.target.value, activeTargetId)} className="h-8 max-w-[230px] rounded-lg border border-white/10 bg-[#0b1821]/78 px-2 text-[10px] text-slate-100 outline-none">{completedVersions.map((item) => <option key={item.id} value={item.id}>{item.snapshotDate || item.periodEnd || "日期未知"} · {item.fileName}</option>)}</select><span className="text-slate-500">→</span><select aria-label="目标利润表版本" value={activeTargetId} onChange={(event) => updatePair(activeBaselineId, event.target.value)} className="h-8 max-w-[230px] rounded-lg border border-white/10 bg-[#0b1821]/78 px-2 text-[10px] text-slate-100 outline-none">{completedVersions.map((item) => <option key={item.id} value={item.id}>{item.snapshotDate || item.periodEnd || "日期未知"} · {item.fileName}</option>)}</select>{(baselineId || targetId) && <button type="button" onClick={() => { setPage(0); onResetPair(); }} className="h-8 rounded-lg border border-white/10 bg-white/[0.035] px-2 text-[10px] text-slate-300 transition hover:bg-white/[0.07]">恢复相邻版本</button>}</div> : <span className="text-[10px] text-slate-500">{comparison.mode === "per_owner" ? "当前为全部账户视图，分别比较各账户相邻版本" : "当前账户暂不可选择版本"}</span>}</div>
      <div className="mt-3 grid grid-cols-4 gap-2"><AnalysisSummary label="历史修订" value={`${summary.changedRows}`} detail={`重叠记录 ${summary.overlapRows} · 未变 ${summary.unchangedRows}`} tone={summary.changedRows ? "text-cyan-100" : "text-emerald-200"} /><AnalysisSummary label="重叠范围利润" value={`¥${compactMoney(profitChange)}`} detail={`¥${compactMoney(summary.previousActualProfit)} → ¥${compactMoney(summary.currentActualProfit)}`} tone={valueTone(profitChange)} /><AnalysisSummary label="新增经营数据" value={`${summary.addedRows}`} detail={`${addedDateLabel} · GMV ¥${compactMoney(summary.addedGmv)}`} tone={summary.addedRows ? "text-cyan-100" : "text-slate-300"} /><AnalysisSummary label="本版未出现" value={`${summary.missingRows}`} detail={missingDateLabel} tone={summary.missingRows ? "text-amber-100" : "text-emerald-200"} /></div>
      <details className="mt-2 text-[10px] text-slate-400"><summary className="cursor-pointer font-semibold text-cyan-100/80">字段说明与阅读方式</summary><p className="mt-1 leading-5">每格“左值 → 右值”表示基准版本到目标版本；比例字段的变化用“个点”表示。发货率、净成交发货率、签收率、1H 退款率均采用 Excel 原表口径；利润率为真实利润在 GMV 中的占比；真实利润为 Excel 商品利润(Y)。</p></details>
    </div>
    <div className="min-h-0 overflow-hidden">
      <table className="w-full min-w-[1510px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">业务日期 / 版本</th><th className="px-3 py-2.5">店铺 / 商品 / 计划</th><th className="px-3 py-2.5 text-right">净成交发货率</th><th className="px-3 py-2.5 text-right">签收率</th><th className="px-3 py-2.5 text-right">真实利润</th><th className="px-3 py-2.5 text-right">GMV / 消耗</th><th className="px-3 py-2.5 text-right">1H 退款率</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{rows.map((item) => <tr key={item.key} className="text-slate-300"><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.metricDate}</span><span className="mt-1 block text-[10px] text-slate-500">{item.previousSnapshotDate} → {item.currentSnapshotDate}</span></td><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.storeName} · {item.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {item.productId} · 计划 {item.planId || "未匹配"}</span></td>{metricCell(item.previousNetShippingRate, item.currentNetShippingRate, item.netShippingRateChange, percent)}{metricCell(item.previousSignRate, item.currentSignRate, item.signRateChange, percent)}{metricCell(item.previousActualProfit, item.currentActualProfit, item.actualProfitChange, (value) => `¥${money(value)}`)}<td className="px-3 py-2.5 text-right"><span className="block text-slate-200">¥{money(item.previousGmv)} <span className="text-slate-600">→</span> ¥{money(item.currentGmv)}</span><span className={`mt-1 block text-[10px] font-bold ${valueTone(item.gmvChange)}`}>{changeLabel(item.gmvChange, (value) => `¥${money(value)}`)}</span><span className="mt-1 block text-[10px] text-slate-500">消耗 ¥{money(item.previousAdSpend)} → ¥{money(item.currentAdSpend)} <span className={valueTone(item.adSpendChange)}>{changeLabel(item.adSpendChange, (value) => `¥${money(value)}`)}</span></span></td>{metricCell(item.previousOneHourRefundRate, item.currentOneHourRefundRate, item.oneHourRefundRateChange, percent, valueTone(-item.oneHourRefundRateChange))}</tr>)}{!rows.length && <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">所选两份利润表在当前范围内没有历史修订。新增经营数据和本版未出现记录已在上方单独统计。</td></tr>}</tbody></table>
      {pageCount > 1 && <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-cyan-100/10 bg-[#07151e]/94 px-3 py-2 text-[10px] text-slate-400"><span className="mr-auto">第 {currentPage + 1} / {pageCount} 页 · 共 {total} 条历史修订</span><button type="button" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 disabled:opacity-35">上一页</button><button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 disabled:opacity-35">下一页</button></div>}
    </div>
  </div>;
}
*/

type RevisionMetricSortKey = "adSpend" | "gmv" | "roi" | "netDealRoi" | "paidOrders" | "overallShippingRate" | "netShippingRate" | "signRate" | "profitMargin" | "oneHourRefundRate" | "actualProfit";
type RevisionRow = AnalyticsDashboard["revisionSignals"][number];

function revisionMetricValue(item: RevisionRow, key: RevisionMetricSortKey) {
  const values: Record<RevisionMetricSortKey, number> = {
    adSpend: item.currentAdSpend,
    gmv: item.currentGmv,
    roi: item.currentRoi,
    netDealRoi: item.currentNetDealRoi,
    paidOrders: item.currentPaidOrders,
    overallShippingRate: item.currentOverallShippingRate,
    netShippingRate: item.currentNetShippingRate,
    signRate: item.currentSignRate,
    profitMargin: item.currentProfitMargin,
    oneHourRefundRate: item.currentOneHourRefundRate,
    actualProfit: item.currentActualProfit,
  };
  return values[key];
}

function revisionFallback(left: RevisionRow, right: RevisionRow) {
  return right.metricDate.localeCompare(left.metricDate)
    || left.storeName.localeCompare(right.storeName, "zh-CN")
    || left.productId.localeCompare(right.productId);
}

function RevisionSignalsView({ dashboard, baselineId, targetId, canSelectPair, onPairChange, onResetPair }: {
  dashboard: AnalyticsDashboard;
  baselineId: string;
  targetId: string;
  canSelectPair: boolean;
  onPairChange: (baselineId: string, targetId: string) => void;
  onResetPair: () => void;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<MetricSort<RevisionMetricSortKey>>({ key: "actualProfit", direction: "asc" });
  const pageSize = 60;
  const comparison = dashboard.versionComparison;
  const completedVersions = dashboard.history.filter((item) => item.status === "completed" && item.snapshotDate);
  const activeBaselineId = baselineId || comparison.baseline?.id || "";
  const activeTargetId = targetId || comparison.target?.id || "";
  const sortedSignals = sortByMetric(dashboard.revisionSignals, sort, revisionMetricValue, revisionFallback);
  const total = sortedSignals.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = sortedSignals.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const summary = comparison.summary;
  const profitChange = summary.currentActualProfit - summary.previousActualProfit;
  const addedDateLabel = summary.addedBusinessDates.length
    ? `${summary.addedBusinessDates.slice(0, 2).join("、")}${summary.addedBusinessDates.length > 2 ? ` 等 ${summary.addedBusinessDates.length} 天` : ""}`
    : "无新增业务日期";
  const missingDateLabel = summary.missingBusinessDates.length
    ? `${summary.missingBusinessDates.slice(0, 2).join("、")}${summary.missingBusinessDates.length > 2 ? ` 等 ${summary.missingBusinessDates.length} 天` : ""}`
    : "无整日缺失";
  const changeLabel = (previous: number, current: number, value: number, formatter: (item: number) => string) => {
    if (Math.abs(value) < 0.000001) return "持平";
    if (formatter === percent) {
      const points = `${Math.abs(value * 100).toFixed(1)} 个点`;
      return previous < 0 || current < 0 ? `利润率${value > 0 ? "改善" : "转差"} ${points}` : `${value > 0 ? "上升" : "下降"} ${points}`;
    }
    const formatted = formatter(Math.abs(value));
    if (formatted.startsWith("¥")) return `${value > 0 ? "增加" : "减少"} ${formatted}`;
    return `${value > 0 ? "上升" : "下降"} ${formatted}`;
  };
  const metricCell = (previous: number, current: number, change: number, formatter: (item: number) => string, tone = valueTone(change)) => (
    <td className="px-3 py-2.5 text-right"><span className="block whitespace-nowrap text-slate-200">{formatter(previous)} <span className="text-slate-600">→</span> {formatter(current)}</span><span className={`mt-1 block whitespace-nowrap text-[10px] font-bold ${tone}`}>{changeLabel(previous, current, change, formatter)}</span></td>
  );
  const handleSort = (metric: RevisionMetricSortKey) => {
    setSort((current) => nextMetricSort(current, metric));
    setPage(0);
  };
  const updatePair = (nextBaselineId: string, nextTargetId: string) => {
    if (!nextBaselineId || !nextTargetId || nextBaselineId === nextTargetId) return;
    const baselineIndex = completedVersions.findIndex((item) => item.id === nextBaselineId);
    const targetIndex = completedVersions.findIndex((item) => item.id === nextTargetId);
    if (baselineIndex < 0 || targetIndex < 0) return;
    const [normalizedBaseline, normalizedTarget] = baselineIndex > targetIndex ? [nextBaselineId, nextTargetId] : [nextTargetId, nextBaselineId];
    setPage(0);
    onPairChange(normalizedBaseline, normalizedTarget);
  };

  if (!comparison.available) {
    return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md text-center"><GitCompareArrows className="mx-auto h-7 w-7 text-cyan-100/70" /><h3 className="mt-3 text-lg font-black text-slate-50">利润表版本对比</h3><p className="mt-2 text-xs leading-6 text-slate-400">{comparison.message || "至少需要两份正式利润表，才能查看版本之间的历史修订与新增经营数据。"}</p></div></div>;
  }

  return <div className="grid h-full min-h-0 grid-rows-[164px_minmax(0,1fr)] overflow-hidden">
    <div className="border-b border-cyan-100/10 p-3">
      <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-slate-100">利润表版本对比</p><p className="mt-1 text-[10px] text-slate-500">重叠业务日期显示历史修订；新增日期与本版未出现记录单独统计。</p></div>{canSelectPair && completedVersions.length >= 2 ? <div className="flex items-center gap-2"><select aria-label="基准利润表版本" value={activeBaselineId} onChange={(event) => updatePair(event.target.value, activeTargetId)} className="h-8 max-w-[230px] rounded-lg border border-white/10 bg-[#0b1821]/78 px-2 text-[10px] text-slate-100 outline-none">{completedVersions.map((item) => <option key={item.id} value={item.id}>{item.snapshotDate || item.periodEnd || "日期未知"} · {item.fileName}</option>)}</select><span className="text-slate-500">→</span><select aria-label="目标利润表版本" value={activeTargetId} onChange={(event) => updatePair(activeBaselineId, event.target.value)} className="h-8 max-w-[230px] rounded-lg border border-white/10 bg-[#0b1821]/78 px-2 text-[10px] text-slate-100 outline-none">{completedVersions.map((item) => <option key={item.id} value={item.id}>{item.snapshotDate || item.periodEnd || "日期未知"} · {item.fileName}</option>)}</select>{(baselineId || targetId) && <button type="button" onClick={() => { setPage(0); onResetPair(); }} className="h-8 rounded-lg border border-white/10 bg-white/[0.035] px-2 text-[10px] text-slate-300 transition hover:bg-white/[0.07]">恢复相邻版本</button>}</div> : <span className="text-[10px] text-slate-500">{comparison.mode === "per_owner" ? "当前为全部账户视图，分别比较各账户相邻版本" : "当前账户暂不可选择版本"}</span>}</div>
      <div className="mt-3 grid grid-cols-4 gap-2"><AnalysisSummary label="历史修订" value={`${summary.changedRows}`} detail={`重叠记录 ${summary.overlapRows} · 未变 ${summary.unchangedRows}`} tone={summary.changedRows ? "text-cyan-100" : "text-emerald-200"} /><AnalysisSummary label="重叠范围利润" value={`¥${compactMoney(profitChange)}`} detail={`¥${compactMoney(summary.previousActualProfit)} → ¥${compactMoney(summary.currentActualProfit)}`} tone={valueTone(profitChange)} /><AnalysisSummary label="新增经营数据" value={`${summary.addedRows}`} detail={`${addedDateLabel} · GMV ¥${compactMoney(summary.addedGmv)}`} tone={summary.addedRows ? "text-cyan-100" : "text-slate-300"} /><AnalysisSummary label="本版未出现" value={`${summary.missingRows}`} detail={missingDateLabel} tone={summary.missingRows ? "text-amber-100" : "text-emerald-200"} /></div>
    </div>
    <div className="min-h-0 overflow-hidden">
      <VersionComparisonGrid rows={rows} sort={sort} onSort={handleSort} currentPage={currentPage} pageCount={pageCount} total={total} onPageChange={setPage} />
      <table className="w-full min-w-[2440px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">业务日期 / 版本</th><th className="px-3 py-2.5">店铺 / 商品 / 计划</th><SortableMetricHeader label="消耗" metric="adSpend" sort={sort} onSort={handleSort} /><SortableMetricHeader label="成交金额" metric="gmv" sort={sort} onSort={handleSort} /><SortableMetricHeader label="ROI" metric="roi" sort={sort} onSort={handleSort} title="按目标版本 ROI 排序" /><SortableMetricHeader label="支付订单数" metric="paidOrders" sort={sort} onSort={handleSort} /><SortableMetricHeader label="发货率" metric="overallShippingRate" sort={sort} onSort={handleSort} /><SortableMetricHeader label="净成交发货率" metric="netShippingRate" sort={sort} onSort={handleSort} /><SortableMetricHeader label="签收率" metric="signRate" sort={sort} onSort={handleSort} /><SortableMetricHeader label="利润率" metric="profitMargin" sort={sort} onSort={handleSort} /><SortableMetricHeader label="1H 退款率" metric="oneHourRefundRate" sort={sort} onSort={handleSort} /><SortableMetricHeader label="真实利润" metric="actualProfit" sort={sort} onSort={handleSort} /></tr></thead><tbody className="divide-y divide-white/[0.055]">{rows.map((item) => <tr key={item.key} className="text-slate-300"><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.metricDate}</span><span className="mt-1 block text-[10px] text-slate-500">{item.previousSnapshotDate} → {item.currentSnapshotDate}</span></td><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.storeName} · {item.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {item.productId} · 计划 {item.planId || "未匹配"}</span></td>{metricCell(item.previousAdSpend, item.currentAdSpend, item.adSpendChange, (value) => `¥${money(value)}`)}{metricCell(item.previousGmv, item.currentGmv, item.gmvChange, (value) => `¥${money(value)}`)}{metricCell(item.previousRoi, item.currentRoi, item.roiChange, (value) => value.toFixed(2))}{metricCell(item.previousPaidOrders, item.currentPaidOrders, item.paidOrdersChange, (value) => `${Math.round(value)}`)}{metricCell(item.previousOverallShippingRate, item.currentOverallShippingRate, item.overallShippingRateChange, percent)}{metricCell(item.previousNetShippingRate, item.currentNetShippingRate, item.netShippingRateChange, percent)}{metricCell(item.previousSignRate, item.currentSignRate, item.signRateChange, percent)}{metricCell(item.previousProfitMargin, item.currentProfitMargin, item.profitMarginChange, percent)}{metricCell(item.previousOneHourRefundRate, item.currentOneHourRefundRate, item.oneHourRefundRateChange, percent, valueTone(-item.oneHourRefundRateChange))}{metricCell(item.previousActualProfit, item.currentActualProfit, item.actualProfitChange, (value) => `¥${money(value)}`)}</tr>)}{!rows.length && <tr><td colSpan={12} className="px-4 py-12 text-center text-slate-500">所选两份利润表在当前范围内没有历史修订。新增经营数据和本版未出现记录已在上方单独统计。</td></tr>}</tbody></table>
      {pageCount > 1 && <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-cyan-100/10 bg-[#07151e]/94 px-3 py-2 text-[10px] text-slate-400"><span className="mr-auto">第 {currentPage + 1} / {pageCount} 页 · 共 {total} 条历史修订</span><button type="button" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 disabled:opacity-35">上一页</button><button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 disabled:opacity-35">下一页</button></div>}
    </div>
  </div>;
}

/*
function ImportHistoryView({ dashboard, onCommit, onDelete }: { dashboard: AnalyticsDashboard; onCommit: (id: string) => Promise<void>; onDelete: (item: AnalyticsDashboard["history"][number]) => void }) {
  const statusLabel = (status: AnalyticsDashboard["history"][number]["status"]) => status === "queued" ? "等待处理" : status === "processing" ? "处理中" : status === "preview_ready" ? "待确认" : status === "completed" ? "已导入" : "失败";
  const completed = dashboard.history.filter((item) => item.status === "completed").length;
  const waiting = dashboard.history.filter((item) => ["queued", "processing", "preview_ready"].includes(item.status)).length;
  const failed = dashboard.history.filter((item) => item.status === "failed").length;
  return <div className="grid h-full min-h-0 grid-rows-[88px_minmax(0,1fr)] overflow-hidden"><div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3"><AnalysisSummary label="全部批次" value={`${dashboard.history.length}`} detail="当前账户范围" /><AnalysisSummary label="正式导入" value={`${completed}`} detail="已成为经营数据" tone="text-emerald-200" /><AnalysisSummary label="等待处理" value={`${waiting}`} detail="处理中或待确认" tone={waiting ? "text-amber-100" : "text-slate-300"} /><AnalysisSummary label="失败批次" value={`${failed}`} detail="可查看具体失败原因" tone={failed ? "text-rose-200" : "text-emerald-200"} /></div><div className="overflow-auto"><table className="w-full min-w-[1200px] text-left text-xs"><thead className="sticky top-0 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">用户 / 文件</th><th className="px-3 py-2.5">状态</th><th className="px-3 py-2.5">店铺 / 商品周期</th><th className="px-3 py-2.5 text-right">店铺</th><th className="px-3 py-2.5 text-right">透视期 / 登记唯一商品</th><th className="px-3 py-2.5 text-right">商品利润(Y)</th><th className="px-3 py-2.5 text-right">异常</th><th className="px-3 py-2.5">创建时间</th><th className="px-3 py-2.5">快照 / 操作</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{dashboard.history.map((item) => <tr key={item.id} className="text-slate-300"><td className="max-w-[300px] px-3 py-2.5"><span className="block font-bold text-slate-100">{item.username}</span><span className="block truncate text-[10px] text-slate-500">{item.fileName}</span></td><td className="px-3 py-2.5"><span className="text-cyan-100">{statusLabel(item.status)}</span><span className="ml-2 text-[10px] text-slate-500">{item.progress}%</span>{item.errorMessage && <span className="mt-1 block max-w-[220px] text-[10px] text-rose-200">{item.errorMessage}</span>}</td><td className="px-3 py-2.5 text-[10px]"><span className="block">店铺 {item.periodStart ?? "--"} 至 {item.periodEnd ?? "--"}</span><span className="mt-1 block text-cyan-100/65">商品 {item.productPeriodStart ?? "--"} 至 {item.productPeriodEnd ?? "--"}</span></td><td className="px-3 py-2.5 text-right">{item.storeCount}</td><td className="px-3 py-2.5 text-right">{item.productCount} / {item.registeredProductCount}</td><td className={`px-3 py-2.5 text-right ${valueTone(item.productProfitTotal)}`}>¥{money(item.productProfitTotal)}</td><td className="px-3 py-2.5 text-right">{item.issueCount}</td><td className="px-3 py-2.5 text-[10px] text-slate-400">{item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "--"}</td><td className="px-3 py-2.5">{item.status === "preview_ready" ? <button type="button" onClick={() => onCommit(item.id)} className="rounded-md border border-cyan-100/18 bg-cyan-200/9 px-2 py-1 text-[10px] text-cyan-50">确认导入</button> : item.status === "completed" ? <span className="text-[10px] text-emerald-100">{item.snapshotDate ? `${item.snapshotDate} · 观察期${item.maturityDays}天` : "旧批次 · 不参与快照"}</span> : <span className="text-[10px] text-slate-500">{item.stage}</span>}</td></tr>)}{!dashboard.history.length && <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-500">暂无导入记录</td></tr>}</tbody></table></div></div>;
}

*/

function ImportHistoryView({ dashboard, onCommit, onDelete }: { dashboard: AnalyticsDashboard; onCommit: (id: string) => Promise<void>; onDelete: (item: AnalyticsDashboard["history"][number]) => void }) {
  const statusLabel = (status: AnalyticsDashboard["history"][number]["status"]) => status === "queued" ? "等待处理" : status === "processing" ? "处理中" : status === "preview_ready" ? "待确认" : status === "completed" ? "已导入" : "失败";
  const completed = dashboard.history.filter((item) => item.status === "completed").length;
  const waiting = dashboard.history.filter((item) => ["queued", "processing", "preview_ready"].includes(item.status)).length;
  const failed = dashboard.history.filter((item) => item.status === "failed").length;

  return <div className="grid h-full min-h-0 grid-rows-[112px_minmax(0,1fr)] overflow-hidden">
    <div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3"><AnalysisSummary label="全部批次" value={`${dashboard.history.length}`} detail="当前账户范围" /><AnalysisSummary label="正式导入" value={`${completed}`} detail="已成为当前或历史经营数据" tone="text-emerald-200" /><AnalysisSummary label="等待处理" value={`${waiting}`} detail="处理中批次不可删除" tone={waiting ? "text-amber-100" : "text-slate-300"} /><AnalysisSummary label="失败批次" value={`${failed}`} detail="可删除后重新上传" tone={failed ? "text-rose-200" : "text-emerald-200"} /></div>
    <div className="overflow-auto">
      <table className="w-full min-w-[1180px] text-left text-xs">
        <thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">用户 / 文件</th><th className="px-3 py-2.5">状态</th><th className="px-3 py-2.5">店铺 / 商品周期</th><th className="px-3 py-2.5 text-right">店铺</th><th className="px-3 py-2.5 text-right">经营商品</th><th className="px-3 py-2.5 text-right">原表校验利润</th><th className="px-3 py-2.5 text-right">异常</th><th className="px-3 py-2.5">创建时间</th><th className="px-3 py-2.5">快照 / 操作</th></tr></thead>
        <tbody className="divide-y divide-white/[0.055]">
          {dashboard.history.map((item) => {
            const canDelete = !["queued", "processing"].includes(item.status);
            return <tr key={item.id} className="text-slate-300">
              <td className="max-w-[300px] px-3 py-2.5"><span className="block font-bold text-slate-100">{item.username}</span><span className="block truncate text-[10px] text-slate-500">{item.fileName}</span></td>
              <td className="px-3 py-2.5"><span className="text-cyan-100">{statusLabel(item.status)}</span><span className="ml-2 text-[10px] text-slate-500">{item.progress}%</span>{item.errorMessage && <span className="mt-1 block max-w-[220px] text-[10px] text-rose-200">{item.errorMessage}</span>}</td>
              <td className="px-3 py-2.5 text-[10px]"><span className="block">店铺 {item.periodStart ?? "--"} 至 {item.periodEnd ?? "--"}</span><span className="mt-1 block text-cyan-100/65">商品 {item.productPeriodStart ?? "--"} 至 {item.productPeriodEnd ?? "--"}</span></td>
              <td className="px-3 py-2.5 text-right">{item.storeCount}</td>
              <td className="px-3 py-2.5 text-right">{item.productCount}</td>
              <td className={`px-3 py-2.5 text-right ${valueTone(item.productProfitTotal)}`}>¥{money(item.productProfitTotal)}</td>
              <td className="px-3 py-2.5 text-right">{item.issueCount}</td>
              <td className="px-3 py-2.5 text-[10px] text-slate-400">{item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "--"}</td>
              <td className="px-3 py-2.5"><div className="flex items-center gap-2">{item.status === "preview_ready" ? <button type="button" onClick={() => void onCommit(item.id)} className="rounded-md border border-cyan-100/18 bg-cyan-200/9 px-2 py-1 text-[10px] text-cyan-50">确认导入</button> : item.status === "completed" ? <span className="text-[10px] text-emerald-100">{item.snapshotDate ? `${item.snapshotDate} · 观察期${item.maturityDays}天` : "正式批次"}</span> : <span className="text-[10px] text-slate-500">{item.stage}</span>}{canDelete && <button type="button" onClick={() => onDelete(item)} title={`删除 ${item.fileName}`} aria-label={`删除 ${item.fileName}`} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rose-200/18 bg-rose-300/[0.06] text-rose-100 transition hover:bg-rose-300/[0.14]"><Trash2 className="h-3.5 w-3.5" /></button>}</div></td>
            </tr>;
          })}
          {!dashboard.history.length && <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-500">暂无导入记录</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

function AdsAnalysisView({ dashboard, products, onSelect }: { dashboard: AnalyticsDashboard; products: ProductSummary[]; onSelect: (product: ProductSummary) => void }) {
  const [sort, setSort] = useState<MetricSort<ProductMetricSortKey>>({ key: "adSpend", direction: "desc" });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const filteredProducts = useMemo(() => filterProducts(products, deferredQuery), [deferredQuery, products]);
  const ranked = useMemo(() => sortByMetric(filteredProducts, sort, productMetricValue, productFallback), [filteredProducts, sort]);
  const unmatched = useMemo(() => ranked.filter((item) => !item.planId), [ranked]);
  const spendWithoutGmv = useMemo(() => ranked.filter((item) => item.adSpend > 0 && item.gmv <= 0), [ranked]);
  const highRoiLoss = useMemo(() => ranked.filter((item) => item.profitAvailable && item.netDealRoi > 0 && item.actualProfit < 0), [ranked]);
  return <div className="grid h-full min-h-0 grid-rows-[auto_116px_minmax(0,1fr)] overflow-hidden">
    <ProductMetricSortToolbar sort={sort} onChange={(next) => startTransition(() => setSort(next))} query={query} onQueryChange={setQuery} resultCount={ranked.length} totalCount={products.length} />
    <div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3"><AnalysisSummary label="Excel 投放消耗" value={`¥${compactMoney(dashboard.kpis.adSpend)}`} detail={`净成交 ROI ${dashboard.kpis.netDealRoi.toFixed(2)}`} /><AnalysisSummary label="有消耗无 GMV" value={`${spendWithoutGmv.length}`} detail="计划对应商品需复核" tone={spendWithoutGmv.length ? "text-rose-200" : "text-emerald-200"} /><AnalysisSummary label="高净成交 ROI 仍亏损" value={`${highRoiLoss.length}`} detail="净成交 ROI 与真实利润不一致" tone={highRoiLoss.length ? "text-amber-100" : "text-emerald-200"} /><AnalysisSummary label="计划未匹配" value={`${unmatched.length}`} detail="产品登记缺少计划 ID" tone={unmatched.length ? "text-violet-200" : "text-emerald-200"} /></div>
    <div className="overflow-auto"><table className="w-full min-w-[1180px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">店铺 / 商品 / 计划</th><th className="px-3 py-2.5 text-right">消耗</th><th className="px-3 py-2.5 text-right">GMV</th><th className="px-3 py-2.5 text-right">净成交 ROI</th><th className="px-3 py-2.5 text-right">Excel 利润(Y)</th><th className="px-3 py-2.5 text-right">利润波动</th><th className="px-3 py-2.5">匹配状态</th><th className="px-3 py-2.5">诊断</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{ranked.map((item) => <tr key={item.key} onClick={() => onSelect(item)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]"><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.storeName} · {item.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {item.productId} · 计划 {item.planId || "未匹配"}</span></td><td className="px-3 py-2.5 text-right">¥{money(item.adSpend)}</td><td className="px-3 py-2.5 text-right">¥{money(item.gmv)}</td><td className="px-3 py-2.5 text-right font-bold text-cyan-100">{item.netDealRoi.toFixed(2)}</td><td className={`px-3 py-2.5 text-right font-bold ${valueTone(item.actualProfit)}`}>¥{money(item.actualProfit)}</td><td className={`px-3 py-2.5 text-right ${valueTone(item.profitChange)}`}>{moneyChange(item.hasPreviousData, item.profitChange)}</td><td className="px-3 py-2.5">{item.planId ? <span className="text-emerald-200">商品与计划已关联</span> : <span className="text-violet-200">缺少计划 ID</span>}</td><td className="px-3 py-2.5"><DecisionBadge decision={item.decision} /></td></tr>)}</tbody></table></div>
  </div>;
}

function weightedProductRate(products: ProductSummary[], getter: (product: ProductSummary) => number) {
  const weight = products.reduce((sum, item) => sum + Math.max(0, item.nonFakeOrders), 0);
  return weight > 0 ? products.reduce((sum, item) => sum + getter(item) * Math.max(0, item.nonFakeOrders), 0) / weight : 0;
}

function filterProducts(products: ProductSummary[], query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return products;
  return products.filter((item) => `${item.productName} ${item.categoryName} ${item.productId} ${item.planId ?? ""} ${item.storeName} ${item.username}`.toLowerCase().includes(keyword));
}

function PlanStrategyView({ insights, accuracy, snapshotDate }: { insights: AnalyticsDashboard["planInsights"]; accuracy: AnalyticsDashboard["accuracy"]["status"]; snapshotDate: string | null }) {
  const [query, setQuery] = useState("");
  const [quotaInput, setQuotaInput] = useState("");
  const [appliedQuota, setAppliedQuota] = useState(0);
  const [showDailyReplay, setShowDailyReplay] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const filteredProducts = useMemo(() => {
    const keyword = deferredQuery.trim().toLowerCase();
    if (!keyword) return insights.products;
    return insights.products.filter((product) => `${product.productName} ${product.priceLabel} ${product.key} ${product.accountBreakdown.map((account) => `${account.accountShortName} ${account.accountName} ${account.accountId}`).join(" ")}`.toLowerCase().includes(keyword));
  }, [deferredQuery, insights.products]);
  const conversionRate = (value: number | null) => value === null ? "--" : `${(value * 100).toFixed(1)}%`;
  const changes = insights.changes;
  const changeStatus = (status: "added" | "removed" | "changed") => status === "added" ? "新增" : status === "removed" ? "移除/疑似关停" : "数值修正";
  const changeTone = (status: "added" | "removed" | "changed") => status === "added" ? "text-emerald-100" : status === "removed" ? "text-rose-100" : "text-amber-100";
  const strategyTotals = useMemo(() => insights.products.reduce((total, product) => {
    for (const account of product.accountBreakdown) {
      total.current += account.eligiblePlans;
      total.recommended += account.recommendedPlans ?? account.eligiblePlans;
      total.newPlans += account.suggestedNewPlans;
      total.retain += account.suggestedRetainPlans;
      total.pause += account.suggestedPausePlans;
    }
    return total;
  }, { current: 0, recommended: 0, newPlans: 0, retain: 0, pause: 0 }), [insights.products]);
  const quotaAllocations = useMemo(() => allocatePlanQuota(insights.products.flatMap((product) => product.accountBreakdown.map((account) => ({ key: account.key, suggestedNewPlans: account.suggestedNewPlans, conversionRate: account.matureCohortRate ?? account.conversionRate, estimatedProfit: account.estimatedProfit, netRoi: account.netRoi }))), appliedQuota), [appliedQuota, insights.products]);
  const allocatedQuota = [...quotaAllocations.values()].reduce((sum, value) => sum + value, 0);
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-cyan-100/10 px-4 py-3">
       <div className="min-w-0"><p className="text-[10px] font-semibold tracking-[0.16em] text-cyan-100/60">计划策略 · 成熟利润与概率</p><h3 className="mt-1 text-base font-black text-slate-50">商品跨账户表现</h3><p className="mt-1 text-[11px] leading-5 text-slate-400">计划 {insights.analysisStart} 至 {insights.analysisEnd ?? "--"} · 成熟利润截至 {insights.matureThrough ?? "--"}（剔除最近 5 天）· 数据快照 {snapshotDate ?? "--"}</p></div>
        <label className="relative flex min-w-[240px] items-center rounded-lg border border-transparent sm:max-w-[360px] focus-within:border-cyan-200/35 focus-within:ring-2 focus-within:ring-cyan-200/10"><Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" /><input aria-label="搜索商品、价格、千川账户或账户ID" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、价格、千川账户或账户ID" className="h-8 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-8 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-200/30" /></label>
      <span className={`rounded-md border px-2 py-1 text-[10px] font-bold ${accuracy === "pass" ? "border-emerald-200/20 bg-emerald-300/8 text-emerald-100" : accuracy === "warning" ? "border-amber-200/20 bg-amber-300/8 text-amber-100" : "border-rose-200/20 bg-rose-300/8 text-rose-100"}`}>{accuracy === "pass" ? "对账通过" : accuracy === "warning" ? "对账有警告" : "数据门禁未通过"}</span>
    </div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-cyan-100/10 bg-black/10 px-3 py-2.5 text-[10px]">
      <span className="font-bold text-slate-100">计划报告</span>
      <span className="text-slate-400">商品 <b className="text-slate-200">{insights.productCount}</b></span>
      <span className="text-slate-400">账户组合 <b className="text-slate-200">{insights.products.reduce((sum, product) => sum + product.accountBreakdown.length, 0)}</b></span>
      <span className="text-slate-400">当前有效 <b className="text-cyan-100">{strategyTotals.current}</b></span>
      <span className="text-slate-400">建议总数 <b className="text-cyan-100">{strategyTotals.recommended}</b></span>
      <span className="text-emerald-100">新增 {strategyTotals.newPlans}</span>
      <span className="text-slate-300">保留 {strategyTotals.retain}</span>
      <span className="text-amber-100">暂停 {strategyTotals.pause}</span>
      <span className="ml-auto flex items-center gap-2 text-slate-400"><span>今日新增配额</span><input type="number" min={0} step={1} value={quotaInput} onChange={(event) => setQuotaInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setAppliedQuota(Math.max(0, Math.floor(Number(quotaInput) || 0))); }} placeholder="如 1000" className="h-7 w-24 rounded-md border border-white/10 bg-white/[0.04] px-2 text-right text-xs font-bold text-slate-100 outline-none focus:border-cyan-200/35" /><button type="button" onClick={() => setAppliedQuota(Math.max(0, Math.floor(Number(quotaInput) || 0)))} className="h-7 rounded-md border border-cyan-100/18 bg-cyan-200/9 px-2.5 font-bold text-cyan-50">应用配额</button>{appliedQuota > 0 && <span className="text-cyan-100">已分配 {allocatedQuota} / {appliedQuota}</span>}</span>
      <span className="text-slate-500">按消耗 ≥ ¥{insights.minimumEligibleSpend} 计入 · 有效净 ROI {insights.netRoi === null ? "--" : insights.netRoi.toFixed(2)}</span>
    </div>
       <section className="border-b border-cyan-100/10 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px]">
        <span className="font-bold text-slate-100">较上一份正式快照</span>
        {changes.available ? <><span className="text-emerald-100">新增 {changes.addedPlans}</span><span className="text-rose-100">移除/疑似关停 {changes.removedPlans}</span><span className="text-amber-100">数值修正 {changes.changedPlans}</span><span className="text-slate-300">消耗 {changes.spendChange >= 0 ? "+" : ""}{money(changes.spendChange)}</span><span className="text-slate-300">有效单 {changes.effectiveOrdersChange >= 0 ? "+" : ""}{changes.effectiveOrdersChange}</span><span className="text-cyan-100">转化率 {changes.conversionRateChange === null ? "--" : `${changes.conversionRateChange >= 0 ? "+" : ""}${(changes.conversionRateChange * 100).toFixed(1)} 个点`}</span><span className="text-slate-500">{changes.previousSnapshotDate ?? "--"} → {changes.currentSnapshotDate ?? "--"}</span></> : <span className="text-slate-500">{changes.notices[0] ?? "当前仅显示最新状态"}</span>}
      </div>
      {changes.available && <div className="mt-2 flex min-w-0 gap-2 overflow-x-auto">{changes.productChanges.slice(0, 5).map((change) => <div key={change.key} className="min-w-[190px] rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 py-1.5"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-bold text-slate-200" title={change.productName}>{change.productName}</span><span className={`shrink-0 text-[9px] font-bold ${changeTone(change.status)}`}>{changeStatus(change.status)}</span></div><div className="mt-1 text-[9px] text-slate-500">消耗 {change.spendChange >= 0 ? "+" : ""}{money(change.spendChange)} · 有效单 {change.effectiveOrdersChange >= 0 ? "+" : ""}{change.effectiveOrdersChange}</div></div>)}</div>}
     </section>
     <PlanExecutionTable key={deferredQuery} products={filteredProducts} accuracy={accuracy} quotaAllocations={quotaAllocations} appliedQuota={appliedQuota} />
    {(() => { const latestDay = insights.daily.at(-1); return <section className={`shrink-0 overflow-hidden border-t border-cyan-100/10 ${showDailyReplay ? "max-h-[270px]" : "h-[58px]"}`}><div className="flex h-[58px] items-center justify-between gap-3 bg-[#07141d]/96 px-3"><div className="min-w-0"><h4 className="text-xs font-bold text-slate-100">每日计划规划 · 历史回放</h4><p className="mt-1 truncate text-[10px] text-slate-500">按日报重放新建/老计划转化与停投规则命中；仅作回放估算，不代表脚本已执行</p></div><div className="flex shrink-0 items-center gap-3 text-[10px] text-slate-400">{latestDay && <span>最新 {latestDay.date} · 新建 {latestDay.newPlans} · 老计划 {latestDay.oldPlans} · 规则命中 {latestDay.roiHitPlans + latestDay.lowOrderStopPlans}</span>}<button type="button" onClick={() => setShowDailyReplay((value) => !value)} className="rounded-md border border-cyan-100/16 bg-cyan-200/[0.06] px-2.5 py-1.5 font-semibold text-cyan-50 transition hover:bg-cyan-200/[0.12]">{showDailyReplay ? "收起回放" : "展开回放"}</button></div></div>{showDailyReplay && <div className="max-h-[212px] overflow-auto"><table className="w-full min-w-[1240px] text-left text-[10px]"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-slate-400"><tr><th className="px-3 py-2">日期</th><th className="px-2 py-2 text-right">新建计划 / 有效成交</th><th className="px-2 py-2 text-right">新建转化率</th><th className="px-2 py-2 text-right">老计划 / 有效成交</th><th className="px-2 py-2 text-right">老计划转化率</th><th className="px-2 py-2 text-right">新建数（回放）</th><th className="px-2 py-2 text-right">老计划有单（回放）</th><th className="px-2 py-2 text-right">老计划无单（规则参考）</th><th className="px-2 py-2 text-right">当日消耗</th><th className="px-2 py-2 text-right">净单 / 有效单</th><th className="px-2 py-2 text-right">规则命中 ROI / 低单</th></tr></thead><tbody className="divide-y divide-white/[0.045]">{[...insights.daily].reverse().map((day) => <tr key={day.date} className="text-slate-300"><td className="px-3 py-2 font-mono">{day.date}</td><td className="px-2 py-2 text-right">{day.newPlans} / {day.newConvertedPlans}</td><td className="px-2 py-2 text-right text-cyan-100">{conversionRate(day.newConversionRate)}</td><td className="px-2 py-2 text-right">{day.oldPlans} / {day.oldConvertedPlans}</td><td className="px-2 py-2 text-right">{conversionRate(day.oldConversionRate)}</td><td className="px-2 py-2 text-right text-cyan-100">{day.suggestedNewPlans}</td><td className="px-2 py-2 text-right text-emerald-100">{day.suggestedRetainPlans}</td><td className="px-2 py-2 text-right text-amber-100">{day.suggestedPausePlans}</td><td className="px-2 py-2 text-right">{money(day.spend)}</td><td className="px-2 py-2 text-right">{day.netOrders} / {day.effectiveOrders}</td><td className="px-2 py-2 text-right">{day.roiHitPlans} / {day.lowOrderStopPlans}</td></tr>)}</tbody></table></div>}</section>; })()}
     <details className="max-h-32 shrink-0 overflow-auto border-t border-cyan-100/10 px-3 py-2 text-[10px] text-slate-400"><summary className="cursor-pointer text-[11px] font-bold text-slate-200">统计边界与数据口径</summary><div className="mt-1 space-y-1 leading-4">{insights.notices.map((notice) => <p key={notice}>{notice}</p>)}<p>{insights.minimumMatureAgeDays} 天 cohort 下限；建议数要求至少 10 条成熟计划。赔付跟随最新完整工作簿批次，数据频率以导入批次时间为准。</p></div></details>
  </div>;
}

function PlanExecutionTable({ products, accuracy, quotaAllocations, appliedQuota }: { products: AnalyticsDashboard["planInsights"]["products"]; accuracy: AnalyticsDashboard["accuracy"]["status"]; quotaAllocations: Map<string, number>; appliedQuota: number }) {
  const conversionRate = (value: number | null) => value === null ? "--" : `${(value * 100).toFixed(1)}%`;
  const currency = (value: number | null) => value === null ? "--" : `¥${money(value)}`;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [accountAction, setAccountAction] = useState<"all" | "add" | "retain" | "pause" | "pending">("all");
  const [recommendationStatus, setRecommendationStatus] = useState<"all" | "known" | "pending">("all");
  const selectedProduct = products.find((product) => product.key === selectedKey) ?? products[0] ?? null;
  const selectedAccounts = useMemo(() => selectedProduct?.accountBreakdown ?? [], [selectedProduct]);
  const filteredAccounts = useMemo(() => {
    const keyword = accountQuery.trim().toLowerCase();
    return selectedAccounts.filter((account) => {
      const matchesQuery = !keyword || `${account.accountShortName} ${account.accountName} ${account.accountId}`.toLowerCase().includes(keyword);
      const matchesAction = accountAction === "all"
        || (accountAction === "add" && account.suggestedNewPlans > 0)
        || (accountAction === "retain" && account.suggestedRetainPlans > 0 && account.suggestedNewPlans === 0 && account.suggestedPausePlans === 0)
        || (accountAction === "pause" && account.suggestedPausePlans > 0)
        || (accountAction === "pending" && account.recommendedPlans === null);
      const matchesStatus = recommendationStatus === "all"
        || (recommendationStatus === "known" && account.recommendedPlans !== null)
        || (recommendationStatus === "pending" && account.recommendedPlans === null);
      return matchesQuery && matchesAction && matchesStatus;
    });
  }, [accountAction, accountQuery, recommendationStatus, selectedAccounts]);
  const knownRecommended = (product: AnalyticsDashboard["planInsights"]["products"][number]) => product.accountBreakdown.reduce((sum, account) => sum + (account.recommendedPlans ?? 0), 0);
  const knownAccountCount = selectedAccounts.filter((account) => account.recommendedPlans !== null).length;
  const pendingAccountCount = selectedAccounts.length - knownAccountCount;
  const quotaForProduct = (product: AnalyticsDashboard["planInsights"]["products"][number]) => product.accountBreakdown.reduce((sum, account) => sum + (quotaAllocations.get(account.key) ?? 0), 0);
  return <section className="grid min-h-[360px] min-w-0 flex-1 grid-cols-[minmax(240px,27%)_minmax(0,1fr)] overflow-hidden border-b border-cyan-100/10">
    <aside className="min-h-0 overflow-y-auto border-r border-cyan-100/10">
      <div className="sticky top-0 z-10 border-b border-cyan-100/10 bg-[#07141d]/96 px-3 py-3 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-2"><div><h4 className="text-xs font-bold text-slate-100">计划报告 · 商品</h4><p className="mt-1 text-[10px] text-slate-500">点击商品查看各千川账户执行分配</p></div><span className="shrink-0 text-[10px] text-slate-500">{products.length} 个</span></div>
      </div>
      <div className="divide-y divide-white/[0.055]">
        {products.map((product) => { const isSelected = product.key === selectedProduct?.key; const recommendation = knownRecommended(product); const allocated = quotaForProduct(product); return <button key={product.key} type="button" onClick={() => setSelectedKey(product.key)} className={`block w-full px-3 py-3 text-left transition ${isSelected ? "bg-cyan-300/[0.10]" : "hover:bg-cyan-200/[0.045]"}`}>
          <div className="flex items-start justify-between gap-2"><span className={`min-w-0 truncate text-xs font-bold ${isSelected ? "text-cyan-50" : "text-slate-200"}`} title={product.productName}>{product.productName}</span><span className="shrink-0 text-[10px] text-slate-500">{product.priceLabel}</span></div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]"><span className="text-slate-500">概率建议 <b className="text-cyan-100">{recommendation ? `${recommendation} 条` : "待观察"}</b></span><span className="text-right text-slate-500">当前 <b className="text-slate-200">{product.eligiblePlans}</b> 条</span>{appliedQuota > 0 && <span className="col-span-2 text-emerald-100">本次配额新增 <b>{allocated}</b> 条</span>}<span className="text-slate-500">消耗 <b className="text-slate-300">¥{money(product.totalSpend)}</b></span><span className="text-right text-slate-500">有效成交 <b className="text-slate-300">{product.netOrders}</b> 单</span></div>
          <div className="mt-2 flex items-center justify-between text-[10px]"><span className="text-cyan-100/70">{product.accounts} 个千川账户</span><span className="font-bold text-cyan-100">ROI {product.netRoi === null ? "--" : product.netRoi.toFixed(2)}</span></div>
        </button>; })}
        {!products.length && <div className="px-4 py-12 text-center text-xs text-slate-500">当前搜索范围没有商品计划</div>}
      </div>
    </aside>
    <div className="min-w-0 overflow-y-auto">
      {!selectedProduct ? <div className="flex h-full items-center justify-center text-xs text-slate-500">选择商品后查看账户执行明细</div> : <>
        <div className="border-b border-cyan-100/10 px-4 py-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-semibold tracking-[0.12em] text-cyan-100/60">商品跨账户总览</p><h4 className="mt-1 truncate text-base font-black text-cyan-50" title={selectedProduct.productName}>{selectedProduct.productName}</h4><p className="mt-1 text-[10px] text-slate-500">{selectedProduct.priceLabel} · {selectedProduct.productCount} 个商品 ID · 覆盖 {selectedProduct.accounts} 个千川账户 · {selectedProduct.firstBuildDate ?? "--"} 起投</p></div><div className="text-right text-[10px] text-slate-500">建议合计 <b className="text-lg text-cyan-100">{knownRecommended(selectedProduct) || "待观察"}</b>{knownRecommended(selectedProduct) ? " 条" : ""}<div className="mt-1">{knownAccountCount} 户有建议{pendingAccountCount ? ` · ${pendingAccountCount} 户待观察` : ""}</div></div></div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"><PlanReportMetric label="当前有效" value={`${selectedProduct.eligiblePlans} 条`} /><PlanReportMetric label="累计消耗" value={`¥${money(selectedProduct.totalSpend)}`} /><PlanReportMetric label="有效成交" value={`${selectedProduct.netOrders} 单`} /><PlanReportMetric label="有效 ROI" value={selectedProduct.netRoi === null ? "--" : selectedProduct.netRoi.toFixed(2)} tone="text-cyan-100" /><PlanReportMetric label="发货率" value={conversionRate(selectedProduct.estimatedShippingRate)} /><PlanReportMetric label="签收率" value={conversionRate(selectedProduct.estimatedSignRate)} /><PlanReportMetric label="预估签收单" value={selectedProduct.estimatedSignedOrders === null ? "--" : money(selectedProduct.estimatedSignedOrders)} /><PlanReportMetric label="预估利润" value={selectedProduct.matureProfit === null ? "原表利润不完整" : currency(selectedProduct.matureProfit)} detail={selectedProduct.matureProfit === null ? `覆盖 ${selectedProduct.matureProfitKnownRows}/${selectedProduct.matureProfitTotalRows} 行 · 已知 ${currency(selectedProduct.matureKnownProfit)}` : undefined} tone={selectedProduct.matureProfit === null ? "text-amber-100" : valueTone(selectedProduct.matureProfit)} /></div>
        </div>
        <div className="border-b border-cyan-100/10 px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h5 className="text-xs font-bold text-slate-100">千川账户执行分配</h5><p className="mt-1 text-[10px] text-slate-500">每行是同一商品在一个账户内的全部计划合计，建议条数就是该账户应搭建的计划数</p></div><span className="text-[10px] text-slate-500">显示 {filteredAccounts.length} / {selectedAccounts.length} 个账户</span></div><div className="mt-3 flex flex-wrap items-center gap-2"><label className="relative min-w-[220px] flex-1 sm:max-w-[300px]"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" /><input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="筛选账户名称或账户 ID" aria-label="筛选账户名称或账户 ID" className="h-8 w-full rounded-md border border-white/10 bg-white/[0.035] pl-8 pr-3 text-[11px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-200/30" /></label><select value={accountAction} onChange={(event) => setAccountAction(event.target.value as typeof accountAction)} aria-label="按执行动作筛选" className="h-8 rounded-md border border-white/10 bg-[#0b1a24] px-2 text-[11px] text-slate-200 outline-none focus:border-cyan-200/30"><option value="all">全部动作</option><option value="add">需要新增</option><option value="retain">仅保留</option><option value="pause">需要暂停</option><option value="pending">待观察</option></select><select value={recommendationStatus} onChange={(event) => setRecommendationStatus(event.target.value as typeof recommendationStatus)} aria-label="按建议状态筛选" className="h-8 rounded-md border border-white/10 bg-[#0b1a24] px-2 text-[11px] text-slate-200 outline-none focus:border-cyan-200/30"><option value="all">全部建议状态</option><option value="known">已有建议</option><option value="pending">建议待观察</option></select>{(accountQuery || accountAction !== "all" || recommendationStatus !== "all") && <button type="button" onClick={() => { setAccountQuery(""); setAccountAction("all"); setRecommendationStatus("all"); }} className="h-8 rounded-md border border-white/10 px-2.5 text-[11px] text-slate-300 transition hover:bg-white/[0.06]">清除筛选</button>}</div></div>
        <div className="divide-y divide-white/[0.055]">{filteredAccounts.map((account) => <PlanAccountExecutionRow key={account.key} account={account} accuracy={accuracy} allocatedQuota={appliedQuota > 0 ? quotaAllocations.get(account.key) ?? 0 : null} />)}{!filteredAccounts.length && <div className="px-4 py-10 text-center text-xs text-slate-500">没有匹配的账户，请清除筛选后重试</div>}</div>
      </>}
    </div>
  </section>;
}

function PlanAccountExecutionRow({ account, accuracy, allocatedQuota }: { account: AnalyticsDashboard["planInsights"]["products"][number]["accountBreakdown"][number]; accuracy: AnalyticsDashboard["accuracy"]["status"]; allocatedQuota: number | null }) {
  const rate = (value: number | null) => value === null ? "--" : `${(value * 100).toFixed(1)}%`;
  const profitComplete = account.estimatedProfit !== null;
  return <div className="transition hover:bg-cyan-200/[0.035]">
    <div className="grid gap-3 px-4 py-3 text-[10px] lg:grid-cols-3 xl:grid-cols-[minmax(165px,1.15fr)_minmax(100px,.65fr)_minmax(145px,.95fr)_minmax(125px,.8fr)_minmax(140px,.9fr)]">
      <div className="min-w-0"><div className="text-[9px] text-slate-500">千川账户</div><div className="mt-1 truncate font-bold text-slate-100" title={account.accountName}>{account.accountShortName}</div><div className="mt-1 break-all font-mono text-[9px] text-slate-500">{account.accountId} · {account.accountName}</div><div className="mt-1 text-[9px] text-cyan-100/65">{account.firstBuildDate ?? "--"} 起 · 最新 {account.latestPlanDate ?? "--"}</div></div>
      <div><div className="text-[9px] text-slate-500">建议搭建</div>{allocatedQuota !== null && <div className="mt-1 text-emerald-100"><b className="text-base">{allocatedQuota}</b> 条配额新增</div>}{accuracy === "fail" ? <div className="mt-1 font-bold text-rose-100">禁止建议</div> : account.recommendedPlans === null ? <div className="mt-1 font-bold text-slate-300">待观察</div> : <div className="mt-1"><b className="text-lg text-cyan-100">{account.recommendedPlans}</b><span className="ml-1 text-cyan-100">条</span><div className="text-[9px] text-slate-500">区间 {account.recommendationRange ? `${account.recommendationRange.low}–${account.recommendationRange.high} 条` : "--"}</div></div>}</div>
      <div><div className="text-[9px] text-slate-500">计划与成交</div><div className="mt-1 text-slate-300">当前 <b className="text-slate-100">{account.eligiblePlans}</b> 条 · 新增 <b className="text-emerald-100">{account.suggestedNewPlans}</b> · 暂停 <b className="text-amber-100">{account.suggestedPausePlans}</b></div><div className="mt-1 text-slate-300">消耗 ¥{money(account.totalSpend)}</div><div className="mt-1 text-slate-300">成交 ¥{money(account.netAmount)} · {account.netOrders} 单</div><div className="mt-1 font-bold text-cyan-100">有效 ROI {account.netRoi === null ? "--" : account.netRoi.toFixed(2)}</div></div>
      <div><div className="text-[9px] text-slate-500">发货与签收</div><div className="mt-1 text-slate-300">发货 {rate(account.estimatedShippingRate)} · 签收 {rate(account.estimatedSignRate)}</div><div className="mt-1 text-slate-300">预估签收 {account.estimatedSignedOrders === null ? "--" : money(account.estimatedSignedOrders)} 单</div><div className={`mt-1 text-[9px] ${account.fulfillmentBasis === "direct" ? "text-emerald-100" : account.fulfillmentBasis === "allocated" ? "text-amber-100" : "text-slate-500"}`} title={account.fulfillmentBasisNote}>{account.fulfillmentBasis === "direct" ? "商品链接直接汇总" : account.fulfillmentBasis === "allocated" ? "共享链接估算" : "暂无可归属数据"}</div></div>
      <div><div className="text-[9px] text-slate-500">预估利润</div><div className={`mt-1 text-sm font-black ${account.estimatedProfit === null ? "text-amber-100" : valueTone(account.estimatedProfit)}`}>{account.estimatedProfit === null ? "原表利润不完整" : `¥${money(account.estimatedProfit)}`}</div>{!profitComplete && <div className="mt-1 text-[9px] leading-4 text-amber-100/80">覆盖 {account.profitKnownRows}/{account.profitTotalRows} 行<br />已知部分 ¥{money(account.estimatedKnownProfit)}</div>}<div className="mt-1 text-[9px] text-slate-500">成熟 {account.matureCohortPlans} 条 · 转化 {rate(account.matureCohortRate)}</div></div>
    </div>
    <details className="mx-4 mb-3 rounded-md border border-white/[0.07] bg-white/[0.018] text-[10px] text-slate-300 open:bg-[#07141d]/70">
      <summary className="cursor-pointer px-3 py-2 font-semibold text-slate-300">保留计划明细 {account.suggestedRetainPlans} 条</summary>
      <div className="grid max-h-48 gap-2 overflow-y-auto border-t border-white/[0.06] p-3 md:grid-cols-2 2xl:grid-cols-3">{account.retainItems.map((item) => <div key={item.planId} className="min-w-0 rounded border border-white/[0.06] bg-white/[0.02] p-2"><div className="break-all font-mono text-[9px] text-slate-200">商品 {item.productIds.join("、") || "未识别"}</div><div className="mt-1 break-all font-mono text-[9px] text-slate-500">计划 {item.planId}</div><div className="mt-1 text-[9px] text-slate-400">消耗 ¥{money(item.spend)} · {item.effectiveOrders} 单 · ROI {item.netRoi === null ? "--" : item.netRoi.toFixed(2)}</div></div>)}{!account.retainItems.length && <span className="text-slate-500">无保留计划</span>}</div>
    </details>
  </div>;
}

function PlanReportMetric({ label, value, detail, tone = "text-slate-100" }: { label: string; value: string; detail?: string; tone?: string }) {
  return <div className="rounded-md border border-white/[0.07] bg-white/[0.025] px-2.5 py-2"><div className="text-[9px] text-slate-500">{label}</div><div className={`mt-1 text-xs font-bold ${tone}`}>{value}</div>{detail && <div className="mt-1 text-[9px] leading-4 text-slate-500">{detail}</div>}</div>;
}

function FulfillmentAnalysisView({ dashboard, products, onSelect }: { dashboard: AnalyticsDashboard; products: ProductSummary[]; onSelect: (product: ProductSummary) => void }) {
  const [sort, setSort] = useState<MetricSort<ProductMetricSortKey>>({ key: "signRate", direction: "asc" });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const filteredProducts = useMemo(() => filterProducts(products, deferredQuery), [deferredQuery, products]);
  const lowShipping = useMemo(() => filteredProducts.filter((item) => item.netShippingRate < 0.9), [filteredProducts]);
  const lowSign = useMemo(() => filteredProducts.filter((item) => item.signRate < 0.8), [filteredProducts]);
  const refundRisk = useMemo(() => filteredProducts.filter((item) => item.oneHourRefundRate >= 0.15), [filteredProducts]);
  const ranked = useMemo(() => sortByMetric(filteredProducts, sort, productMetricValue, productFallback), [filteredProducts, sort]);
  return <div className="grid h-full min-h-0 grid-rows-[auto_116px_minmax(0,1fr)] overflow-hidden">
    <ProductMetricSortToolbar sort={sort} onChange={(next) => startTransition(() => setSort(next))} query={query} onQueryChange={setQuery} resultCount={ranked.length} totalCount={products.length} />
    <div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3"><AnalysisSummary label="加权净发货率" value={percent(weightedProductRate(products, (item) => item.netShippingRate))} detail={`${lowShipping.length} 个低于 90%`} tone={lowShipping.length ? "text-amber-100" : "text-emerald-200"} /><AnalysisSummary label="加权签收率" value={percent(weightedProductRate(products, (item) => item.signRate))} detail={`${lowSign.length} 个低于 80%`} tone={lowSign.length ? "text-amber-100" : "text-emerald-200"} /><AnalysisSummary label="Excel 总退款" value={`¥${compactMoney(dashboard.kpis.totalRefund)}`} detail={`刷单占比 ${percent(dashboard.kpis.fakeOrderRate)}`} /><AnalysisSummary label="1H 退款风险" value={`${refundRisk.length}`} detail="1 小时退款率不低于 15%" tone={refundRisk.length ? "text-rose-200" : "text-emerald-200"} /></div>
    <div className="overflow-auto"><table className="w-full min-w-[1400px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">店铺 / 商品</th><th className="px-3 py-2.5 text-right">净成交 ROI</th><th className="px-3 py-2.5 text-right">净发货率</th><th className="px-3 py-2.5 text-right">同店类目中位</th><th className="px-3 py-2.5 text-right">签收率</th><th className="px-3 py-2.5 text-right">全店类目中位</th><th className="px-3 py-2.5 text-right">1H 退款</th><th className="px-3 py-2.5 text-right">刷单占比</th><th className="px-3 py-2.5">成熟度</th><th className="px-3 py-2.5">诊断</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{ranked.map((item) => <tr key={item.key} onClick={() => onSelect(item)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]"><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.storeName} · {item.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {item.productId}</span></td><td className="px-3 py-2.5 text-right font-bold text-cyan-100">{item.netDealRoi.toFixed(2)}</td><td className={`px-3 py-2.5 text-right font-bold ${productRateValue(item, "netShippingRate") !== null && item.netShippingRate < 0.9 ? "text-amber-100" : "text-emerald-200"}`}>{productPercent(item, "netShippingRate")}</td><td className="px-3 py-2.5 text-right text-cyan-100/70">{item.storeCategoryNetShippingMedian === null ? "--" : percent(item.storeCategoryNetShippingMedian)}</td><td className={`px-3 py-2.5 text-right font-bold ${productRateValue(item, "signRate") !== null && item.signRate < 0.8 ? "text-rose-200" : "text-emerald-200"}`}>{productPercent(item, "signRate")}</td><td className="px-3 py-2.5 text-right text-cyan-100/70">{item.globalCategorySignMedian === null ? "--" : percent(item.globalCategorySignMedian)}</td><td className="px-3 py-2.5 text-right">{productPercent(item, "oneHourRefundRate")}</td><td className="px-3 py-2.5 text-right">{percent(item.fakeOrderRate)}</td><td className="px-3 py-2.5"><MaturityBadge maturity={item.maturity} /></td><td className="px-3 py-2.5"><DecisionBadge decision={item.decision} /></td></tr>)}</tbody></table></div>
  </div>;
}

function CostAnalysisView({ dashboard, products, onSelect }: { dashboard: AnalyticsDashboard; products: ProductSummary[]; onSelect: (product: ProductSummary) => void }) {
  const [sort, setSort] = useState<MetricSort<ProductMetricSortKey>>({ key: "actualProfit", direction: "asc" });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const filteredProducts = useMemo(() => filterProducts(products, deferredQuery), [deferredQuery, products]);
  const costIssues = useMemo(() => dashboard.issues.filter((item) => ["missing_cost", "missing_price", "spend_without_gmv"].includes(item.issueType)), [dashboard.issues]);
  const loss = useMemo(() => sortByMetric(filteredProducts.filter((item) => item.profitAvailable && item.actualProfit < 0), sort, productMetricValue, productFallback), [filteredProducts, sort]);
  return <div className="grid h-full min-h-0 grid-rows-[auto_116px_minmax(0,1fr)] overflow-hidden">
    <ProductMetricSortToolbar sort={sort} onChange={(next) => startTransition(() => setSort(next))} query={query} onQueryChange={setQuery} resultCount={loss.length} totalCount={products.length} />
    <div className="grid grid-cols-4 gap-2 border-b border-cyan-100/10 p-3"><AnalysisSummary label="Excel 赔付" value={`¥${compactMoney(dashboard.kpis.compensation)}`} detail="读取赔付金额原表" /><AnalysisSummary label="成本/售价异常" value={`${costIssues.length}`} detail="缺失成本、售价或关联" tone={costIssues.length ? "text-rose-200" : "text-emerald-200"} /><AnalysisSummary label="亏损商品" value={`${loss.length}`} detail={`合计亏损 ¥${money(loss.reduce((sum, item) => sum + Math.max(0, -item.actualProfit), 0))}`} tone={loss.length ? "text-rose-200" : "text-emerald-200"} /><AnalysisSummary label="当前范围商品利润" value={`¥${compactMoney(dashboard.kpis.productProfitTotal)}`} detail="原始记录按所选日期汇总" tone={valueTone(dashboard.kpis.productProfitTotal)} /></div>
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_340px] overflow-hidden"><div className="overflow-auto"><table className="w-full min-w-[1020px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr><th className="px-3 py-2.5">店铺 / 商品</th><th className="px-3 py-2.5 text-right">Excel 利润(Y)</th><th className="px-3 py-2.5 text-right">利润率</th><th className="px-3 py-2.5 text-right">消耗</th><th className="px-3 py-2.5 text-right">GMV</th><th className="px-3 py-2.5 text-right">净成交 ROI</th><th className="px-3 py-2.5">诊断</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{loss.map((item) => <tr key={item.key} onClick={() => onSelect(item)} className="cursor-pointer text-slate-300 transition hover:bg-cyan-200/[0.055]"><td className="px-3 py-2.5"><span className="block font-bold text-slate-100">{item.storeName} · {item.categoryName}</span><span className="mt-1 block font-mono text-[10px] text-slate-500">商品 {item.productId}</span></td><td className="px-3 py-2.5 text-right font-bold text-rose-200">{productProfit(item)}</td><td className="px-3 py-2.5 text-right">{productPercent(item, "profitMargin")}</td><td className="px-3 py-2.5 text-right">¥{money(item.adSpend)}</td><td className="px-3 py-2.5 text-right">¥{money(item.gmv)}</td><td className="px-3 py-2.5 text-right font-bold text-cyan-100">{item.netDealRoi.toFixed(2)}</td><td className="px-3 py-2.5"><DecisionBadge decision={item.decision} /></td></tr>)}</tbody></table></div><div className="overflow-y-auto border-l border-cyan-100/10 p-3"><h3 className="text-sm font-bold text-slate-100">成本与关联异常</h3><div className="mt-3 space-y-2">{costIssues.map((issue) => <div key={issue.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3"><div className="flex items-center justify-between"><span className="text-[10px] font-bold text-amber-100">{issue.issueType}</span><span className="text-[9px] text-slate-500">{issue.scope === "product" ? "商品" : issue.scope === "store" ? "店铺" : "导入"}</span></div><p className="mt-2 text-xs leading-5 text-slate-300">{issue.message}</p></div>)}{!costIssues.length && <p className="rounded-lg border border-emerald-200/14 bg-emerald-300/7 p-3 text-xs text-emerald-100">当前范围未发现已定义的成本与关联异常。</p>}</div></div></div>
  </div>;
}

function ScenarioAnalysisView({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const [extraCost, setExtraCost] = useState(0);
  const [extraRefund, setExtraRefund] = useState(0);
  const [extraCompensation, setExtraCompensation] = useState(0);
  const scenarioProfit = dashboard.kpis.actualProfit - extraCost - extraRefund - extraCompensation;
  return <div className="grid h-full min-h-0 grid-cols-[390px_minmax(0,1fr)] overflow-hidden"><section className="border-r border-violet-100/14 p-4"><p className="text-[10px] font-bold uppercase text-violet-200/70">Scenario Inputs</p><h3 className="mt-1 text-lg font-black text-slate-50">经营情景测算</h3><p className="mt-2 text-xs leading-5 text-slate-400">只调整额外金额，不修改 Excel、数据库或正式经营结论。</p><div className="mt-5 space-y-4"><ScenarioInput label="额外产品成本" value={extraCost} onChange={setExtraCost} /><ScenarioInput label="额外退款金额" value={extraRefund} onChange={setExtraRefund} /><ScenarioInput label="额外赔付金额" value={extraCompensation} onChange={setExtraCompensation} /></div><button type="button" onClick={() => { setExtraCost(0); setExtraRefund(0); setExtraCompensation(0); }} className="mt-5 h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] text-xs font-bold text-slate-300">重置情景参数</button></section><section className="flex min-w-0 flex-col justify-center p-8"><div className="grid grid-cols-2 gap-3"><AnalysisSummary label="Excel 当前利润" value={`¥${money(dashboard.kpis.actualProfit)}`} detail={`净成交 ROI ${dashboard.kpis.netDealRoi.toFixed(2)} · 原表正式结果`} tone={valueTone(dashboard.kpis.actualProfit)} /><AnalysisSummary label="情景利润" value={`¥${money(scenarioProfit)}`} detail="仅供假设比较" tone={valueTone(scenarioProfit)} /><AnalysisSummary label="额外影响合计" value={`-¥${money(extraCost + extraRefund + extraCompensation)}`} detail="成本 + 退款 + 赔付" tone="text-amber-100" /><AnalysisSummary label="情景利润率" value={percent(dashboard.kpis.gmv > 0 ? scenarioProfit / dashboard.kpis.gmv : 0)} detail={`Excel GMV ¥${money(dashboard.kpis.gmv)}`} tone={valueTone(scenarioProfit)} /></div><div className="mt-5 rounded-lg border border-violet-200/14 bg-violet-300/[0.055] p-4 text-xs leading-6 text-slate-300"><p className="font-bold text-violet-100">计算关系</p><p className="mt-2 font-mono text-[11px] text-violet-100/75">情景利润 = Excel 当前利润 - 额外产品成本 - 额外退款 - 额外赔付</p><p className="mt-2 text-slate-500">不对签收率、发货率或 ROI 做未经原表定义的利润推算。</p></div></section></div>;
}

function ScenarioInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="block text-xs text-slate-400"><span>{label}</span><span className="mt-1 flex h-10 items-center rounded-lg border border-white/10 bg-black/18 px-3"><span className="mr-2 text-slate-500">¥</span><input type="number" min={0} step={100} value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} className="min-w-0 flex-1 bg-transparent text-sm font-bold text-slate-100 outline-none" /></span></label>;
}

function AuditStatus({ status }: { status: "pass" | "warning" | "fail" }) {
  return <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${status === "pass" ? "border-emerald-200/20 bg-emerald-300/10 text-emerald-100" : status === "warning" ? "border-amber-200/20 bg-amber-300/10 text-amber-100" : "border-rose-200/20 bg-rose-300/10 text-rose-100"}`}>{status === "pass" ? "通过" : status === "warning" ? "需注意" : "失败"}</span>;
}

function LineageView({ dashboard, showUser }: { dashboard: AnalyticsDashboard; showUser: boolean }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const keyword = deferredQuery.trim().toLowerCase();
  const orderedSheets = [...dashboard.sheetAudits].filter((item) => !keyword || `${item.sheetName} ${item.businessPurpose} ${item.dependencies.join(" ")}`.toLowerCase().includes(keyword)).sort((a, b) => ["source", "lookup", "transform", "decision", "documentation"].indexOf(a.sheetRole) - ["source", "lookup", "transform", "decision", "documentation"].indexOf(b.sheetRole));
  const orderedFormulas = [...dashboard.formulaAudits].filter((item) => !keyword || `${item.sheetName} ${item.columnHeader} ${item.businessMeaning} ${item.sampleFormula}`.toLowerCase().includes(keyword)).sort((a, b) => Number(b.hasFormulaError) - Number(a.hasFormulaError) || Number(b.hasFixedRangeRisk) - Number(a.hasFixedRangeRisk) || b.formulaCount - a.formulaCount);
  const filteredIssues = useMemo(() => dashboard.issues.filter((item) => !keyword || `${item.username} ${item.issueType} ${item.message} ${item.entityKey ?? ""}`.toLowerCase().includes(keyword)), [dashboard.issues, keyword]);
  return (
    <div className="grid h-full min-h-0 grid-rows-[170px_minmax(0,1fr)_190px] overflow-hidden">
      <section className="overflow-y-auto border-b border-cyan-100/10 p-3">
        <div className="mb-3 flex items-center justify-end"><label className="relative flex min-w-[250px] items-center"><Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、计划、字段或异常" className="h-8 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-8 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-200/30" /></label></div>
        <div className="flex items-center justify-between"><div><h3 className="text-sm font-bold text-slate-100">准确性门禁</h3><p className="mt-1 text-[10px] text-slate-500">失败项阻止相关数据进入经营建议，警告项保留但明确标注</p></div><div className="flex gap-2 text-[10px]"><span className="text-emerald-200">通过 {dashboard.accuracy.passedChecks}</span><span className="text-amber-200">警告 {dashboard.accuracy.warningChecks}</span><span className="text-rose-200">失败 {dashboard.accuracy.failedChecks}</span></div></div>
        <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-3">{dashboard.reconciliations.map((check) => <div key={check.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3"><div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-100">{check.label}</span><AuditStatus status={check.status} /></div><p className="mt-2 text-[10px] leading-4 text-slate-400">{check.message}</p>{check.actualValue !== null && <p className="mt-2 font-mono text-[9px] text-cyan-100/55">实际 {money(check.actualValue)}{check.expectedValue !== null ? ` · 期望 ${money(check.expectedValue)}` : ""}</p>}</div>)}</div>
      </section>
      <section className="min-h-0 overflow-y-auto border-b border-cyan-100/10 p-3"><div className="sticky top-0 z-10 mb-3 flex items-center justify-between bg-[#07141d]/96 py-1"><h3 className="text-sm font-bold text-slate-100">工作表数据血缘</h3><span className="text-[10px] text-slate-500">{dashboard.sheetAudits.length} 张表 · {dashboard.accuracy.formulaCount.toLocaleString("zh-CN")} 个公式单元格</span></div><div className="space-y-2">{orderedSheets.map((sheet) => <div key={sheet.id} className="grid grid-cols-[160px_100px_minmax(0,1fr)_220px_80px] items-center gap-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2"><div className="truncate text-xs font-bold text-slate-100">{sheet.sheetName}</div><span className="text-[10px] text-cyan-100/65">{sheet.sheetRole === "source" ? "原始数据" : sheet.sheetRole === "lookup" ? "基础映射" : sheet.sheetRole === "transform" ? "中间计算" : sheet.sheetRole === "decision" ? "决策测算" : "说明资料"}</span><p className="truncate text-[10px] text-slate-400">{sheet.businessPurpose}</p><p className="truncate text-[10px] text-slate-500">{sheet.dependencies.length ? `${sheet.dependencies.join(" + ")} → 本表` : "人工/平台数据 → 本表"}</p><AuditStatus status={sheet.status} /></div>)}</div><div className="mb-2 mt-4 flex items-center justify-between"><h4 className="text-xs font-bold text-slate-200">公式字段与引用范围</h4><span className="text-[9px] text-slate-500">{orderedFormulas.length} 个公式模式</span></div><div className="space-y-1.5">{orderedFormulas.map((formula) => <div key={formula.id} className="grid grid-cols-[180px_160px_minmax(0,1fr)_100px] items-center gap-3 rounded-lg border border-white/[0.07] bg-black/12 px-3 py-2 text-[10px]"><span className="truncate font-bold text-slate-200">{formula.sheetName} · {formula.columnRef}</span><span className="truncate text-cyan-100/65">{formula.columnHeader || "派生列"}</span><span className="truncate text-slate-500" title={formula.sampleFormula}>{formula.businessMeaning} · {formula.sampleFormula}</span><span className={formula.hasFormulaError ? "text-rose-200" : formula.hasFixedRangeRisk ? "text-amber-200" : "text-emerald-200"}>{formula.hasFormulaError ? "公式错误" : formula.hasFixedRangeRisk ? "范围将满" : "可追溯"}</span></div>)}</div></section>
       <section className="min-h-0 border-b border-cyan-100/10"><IssuesView issues={filteredIssues} showUser={showUser} /></section>
    </div>
  );
}

function IssuesView({ issues, showUser }: { issues: AnalyticsDashboard["issues"]; showUser: boolean }) {
  return <div className="h-full overflow-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="sticky top-0 bg-[#0a1720]/96 text-[10px] text-slate-400"><tr>{showUser && <th className="px-3 py-2.5">用户</th>}<th className="px-3 py-2.5">级别</th><th className="px-3 py-2.5">范围</th><th className="px-3 py-2.5">异常类型</th><th className="px-3 py-2.5">说明</th></tr></thead><tbody className="divide-y divide-white/[0.055]">{issues.map((issue) => <tr key={issue.id} className="text-slate-300">{showUser && <td className="px-3 py-2.5 text-cyan-100/72">{issue.username}</td>}<td className="px-3 py-2.5"><span className={`rounded-md border px-2 py-1 text-[10px] font-bold ${issue.severity === "critical" ? "border-rose-200/20 bg-rose-300/10 text-rose-100" : issue.severity === "warning" ? "border-amber-200/20 bg-amber-300/10 text-amber-100" : "border-cyan-200/20 bg-cyan-300/10 text-cyan-100"}`}>{issue.severity === "critical" ? "严重" : issue.severity === "warning" ? "警告" : "提示"}</span></td><td className="px-3 py-2.5">{issue.scope === "product" ? "商品" : issue.scope === "store" ? "店铺" : "导入"}</td><td className="px-3 py-2.5 font-mono text-[10px] text-slate-400">{issue.issueType}</td><td className="px-3 py-2.5 text-slate-200">{issue.message}</td></tr>)}{!issues.length && <tr><td colSpan={showUser ? 5 : 4} className="px-4 py-12 text-center text-emerald-200/72">当前导入未发现已定义的数据异常</td></tr>}</tbody></table></div>;
}

type QueueFilter = "all" | "loss" | "fulfillment" | "refund" | "optimize" | "data";

type QueueTag = { key: Exclude<QueueFilter, "all"> | "high_roi" | "decline"; label: string; className: string };
type QueueItem = { product: ProductSummary; tags: QueueTag[]; impact: number };

function productQueueTags(product: ProductSummary): QueueTag[] {
  const tags: QueueTag[] = [];
  if (product.actualProfit < 0) tags.push({ key: "loss", label: "亏损", className: "border-rose-200/22 bg-rose-300/10 text-rose-100" });
  if (product.decision === "high_roi_loss") tags.push({ key: "high_roi", label: "高 ROI 偏差", className: "border-violet-200/22 bg-violet-300/10 text-violet-100" });
  if (product.netShippingRate < 0.9) tags.push({ key: "fulfillment", label: "净发货低", className: "border-amber-200/22 bg-amber-300/10 text-amber-100" });
  if (product.signRate < 0.8) tags.push({ key: "fulfillment", label: "签收低", className: "border-amber-200/22 bg-amber-300/10 text-amber-100" });
  if (product.oneHourRefundRate >= 0.15) tags.push({ key: "refund", label: "1H 退款高", className: "border-orange-200/22 bg-orange-300/10 text-orange-100" });
  if (product.decision === "optimize") tags.push({ key: "optimize", label: "待优化", className: "border-slate-200/18 bg-white/[0.055] text-slate-200" });
  if (product.decision === "data_issue") tags.push({ key: "data", label: "数据待核验", className: "border-cyan-200/22 bg-cyan-300/10 text-cyan-100" });
  if (product.hasPreviousData && product.profitChange < 0) tags.push({ key: "decline", label: "利润下降", className: "border-slate-200/18 bg-white/[0.055] text-slate-200" });
  return tags;
}

function actionImpact(product: ProductSummary) {
  return Math.max(0, -product.actualProfit) + (product.hasPreviousData ? Math.max(0, -product.profitChange) : 0);
}

function queuePriority(product: ProductSummary, filter: QueueFilter, impact: number) {
  if (filter === "loss") return Math.max(0, -product.actualProfit);
  if (filter === "fulfillment") return (Math.max(0, 0.9 - product.netShippingRate) + Math.max(0, 0.8 - product.signRate)) * 1_000_000 + impact;
  if (filter === "refund") return Math.max(0, product.oneHourRefundRate - 0.15) * 1_000_000 + impact;
  if (filter === "optimize") return Math.max(0, -product.profitChange) + Math.max(0, -product.actualProfit);
  return impact;
}

function queueDisplayMetric(product: ProductSummary, filter: QueueFilter, impact: number) {
  if (filter === "loss") {
    return { value: `-¥${money(Math.max(0, -product.actualProfit))}`, label: "真实利润", tone: "text-rose-100" };
  }
  if (filter === "fulfillment") {
    const shippingGap = Math.max(0, 0.9 - product.netShippingRate);
    const signGap = Math.max(0, 0.8 - product.signRate);
    return shippingGap >= signGap
      ? { value: `${(shippingGap * 100).toFixed(1)} 个点`, label: "净发货缺口", tone: "text-amber-100" }
      : { value: `${(signGap * 100).toFixed(1)} 个点`, label: "签收缺口", tone: "text-amber-100" };
  }
  if (filter === "refund") {
    return { value: percent(product.oneHourRefundRate), label: "1H 退款率", tone: "text-orange-100" };
  }
  if (filter === "optimize") {
    const decline = Math.max(0, -product.profitChange);
    return decline > 0
      ? { value: `¥${money(decline)}`, label: "利润下滑", tone: "text-amber-100" }
      : { value: "待优化", label: "经营状态", tone: "text-amber-100" };
  }
  if (filter === "data") {
    return { value: "待核验", label: "数据状态", tone: "text-cyan-100" };
  }
  return { value: impact > 0 ? `¥${money(impact)}` : "待复核", label: impact > 0 ? "影响金额" : "无金额变化", tone: impact > 0 ? "text-rose-100" : "text-amber-100" };
}

function ActionPanel({ dashboard, queueItems, onSelectProduct }: { dashboard: AnalyticsDashboard | null; queueItems: QueueItem[]; onSelectProduct: (product: ProductSummary) => void }) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  const currentImport = dashboard?.imports[0];
  const blocked = dashboard?.accuracy.status === "fail";
  const queue = useMemo(() => queueItems
    .filter((item) => filter === "all" || item.tags.some((tag) => tag.key === filter))
    .sort((left, right) => queuePriority(right.product, filter, right.impact) - queuePriority(left.product, filter, left.impact) || right.impact - left.impact || left.product.storeName.localeCompare(right.product.storeName, "zh-CN") || left.product.productId.localeCompare(right.product.productId)), [queueItems, filter]);
  const totalQueue = queueItems.length;
  const filterOptions: Array<{ key: QueueFilter; label: string; count: number }> = [
    { key: "all", label: "全部", count: totalQueue },
    { key: "loss", label: "亏损", count: queueItems.filter((item) => item.tags.some((tag) => tag.key === "loss")).length },
    { key: "fulfillment", label: "履约", count: queueItems.filter((item) => item.tags.some((tag) => tag.key === "fulfillment")).length },
    { key: "refund", label: "退款", count: queueItems.filter((item) => item.tags.some((tag) => tag.key === "refund")).length },
    { key: "optimize", label: "优化", count: queueItems.filter((item) => item.tags.some((tag) => tag.key === "optimize")).length },
    { key: "data", label: "数据", count: queueItems.filter((item) => item.tags.some((tag) => tag.key === "data")).length },
  ];
  const activeFilter = filterOptions.find((option) => option.key === filter) ?? filterOptions[0];
  const priorityLabel: Record<QueueFilter, string> = { all: "综合影响金额", loss: "亏损金额", fulfillment: "履约缺口", refund: "1H 退款率", optimize: "利润下滑与亏损金额", data: "综合影响金额" };

  return <>
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[10px] font-semibold tracking-[0.16em] text-cyan-100/60">行动队列</p><h3 className="mt-1 text-lg font-black text-slate-50">待处理诊断</h3></div>
      {dashboard && <AccuracyBadge status={dashboard.accuracy.status} />}
    </div>
    <p className="mt-1 text-xs leading-5 text-slate-400">一件商品只出现一次，可同时带多个问题标签；切换后按当前问题的严重程度重排。</p>
    {dashboard?.dataWindows.productAnalysis.message && <div className="mt-3 rounded-lg border border-amber-200/16 bg-amber-300/[0.07] px-3 py-2.5 text-[11px] leading-5 text-amber-50/80">{dashboard.dataWindows.productAnalysis.message}</div>}
    {blocked && <div className="mt-4 rounded-lg border border-rose-200/18 bg-rose-300/9 px-3 py-3 text-xs leading-5 text-rose-100">当前批次存在未通过的准确性检查，系统暂停经营诊断。请先到“数据血缘”查看失败原因。</div>}
    {!blocked && <>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="待处理诊断筛选">
        {filterOptions.map((option) => <button key={option.key} type="button" onClick={() => startTransition(() => setFilter(option.key))} aria-pressed={filter === option.key} className={`inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[10px] font-bold transition ${filter === option.key ? "border-cyan-200/40 bg-cyan-300/18 text-cyan-50 shadow-[0_0_16px_rgba(103,232,249,0.12)]" : "border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.07] hover:text-slate-200"}`}><span>{option.label}</span><span className={`rounded-sm px-1 py-0.5 text-[9px] ${filter === option.key ? "bg-cyan-100/14 text-cyan-50" : "bg-white/[0.06] text-slate-500"}`}>{option.count}</span></button>)}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500"><span className="min-w-0 flex-1 truncate" title={`当前筛选：${activeFilter.label} · 按${priorityLabel[filter]}排序`}>当前：<b className="text-cyan-100">{activeFilter.label}</b> · 按{priorityLabel[filter]}排序</span><span className="shrink-0 whitespace-nowrap">显示 {queue.length} / {totalQueue} 条</span></div>
      <div className="luma-diagnostic-queue mt-2 space-y-2">
        {queue.slice(0, 80).map(({ product, tags, impact }) => {
          const visibleTags = filter === "all" ? tags : tags.filter((tag) => tag.key === filter);
          const displayMetric = queueDisplayMetric(product, filter, impact);
          return <button key={product.key} type="button" onClick={() => onSelectProduct(product)} data-border-glow className="w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2.5 text-left transition hover:border-cyan-200/24 hover:bg-cyan-200/[0.055] focus:outline-none">
          <span className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0"><span className="block truncate text-xs font-bold text-slate-100">{product.storeName} · {product.categoryName}</span><span className="mt-1 block truncate font-mono text-[10px] text-slate-500">商品 {product.productId}{product.planId ? ` · 计划 ${product.planId}` : ""}</span></span><span className={`shrink-0 text-right text-xs font-black ${displayMetric.tone}`}>{displayMetric.value}<span className="mt-1 block text-[9px] font-normal text-slate-500">{displayMetric.label}</span></span></span>
          <span className="mt-2 flex flex-wrap gap-1">{visibleTags.map((tag, index) => <span key={`${tag.key}:${tag.label}:${index}`} className={`rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${tag.className}`}>{tag.label}</span>)}</span>
        </button>;
        })}
        {!queue.length && <div className="rounded-lg border border-emerald-200/14 bg-emerald-300/7 px-3 py-3 text-xs text-emerald-100/80">当前筛选范围没有待复核商品。</div>}
      </div>
      {queue.length > 80 && <p className="mt-3 text-center text-[10px] text-slate-500">已按优先级展示前 80 条，切换筛选可缩小范围。</p>}
    </>}
    <details className="mt-4 rounded-lg border border-cyan-100/10 bg-black/12 px-3 py-2.5 text-[10px] text-slate-400">
      <summary className="cursor-pointer font-bold text-slate-200">诊断规则与数据口径</summary>
      <div className="mt-2 space-y-1.5 leading-5"><p>利润、GMV、消耗、发货和签收均读取 Excel 原表，不在诊断层重算。</p><p>履约标签：净发货率低于 90% 或签收率低于 80%；退款标签：1H 退款率不低于 15%。</p><p>观察期仅用于复核提示，不会改写 Excel 数值。</p></div>
    </details>
    <details className="mt-3 border-t border-cyan-100/10 pt-3 text-[11px] text-slate-400"><summary className="cursor-pointer text-xs font-bold text-slate-200">当前数据批次</summary>{currentImport ? <div className="mt-2 space-y-1.5"><p className="truncate text-slate-200">{currentImport.fileName}</p><p>店铺：{currentImport.periodStart} 至 {currentImport.periodEnd}</p><p>商品：{currentImport.productPeriodStart} 至 {currentImport.productPeriodEnd} · {currentImport.productCount} 个经营商品</p><p>{currentImport.formulaCount.toLocaleString("zh-CN")} 个公式 · {currentImport.issueCount} 条数据异常</p></div> : <p className="mt-2 text-slate-500">尚未导入</p>}</details>
  </>;
}

function StoreReconciliationPanel({ store }: { store: StoreSummary }) {
  const gapTone = store.gmvGap < 0 ? "text-rose-200" : store.gmvGap > 0 ? "text-emerald-200" : "text-slate-300";
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.035] p-3 text-xs text-slate-300">
      <div className="flex items-center justify-between gap-2">
        <StoreStatus status={store.status} />
        <span className="text-[10px] text-slate-500">差额占比 {store.gmvGapRate === null ? "--" : percent(store.gmvGapRate)}</span>
      </div>
      <p className="mt-2 leading-5">净成交 ROI：<b className="text-cyan-100">{store.netDealRoi.toFixed(2)}</b></p>
      {store.status === "data_issue" && store.dataIssueReasons.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-violet-100/10 pt-2 text-[10px] leading-4 text-violet-100/80">
          {store.dataIssueReasons.map((reason) => <li key={reason}>· {reason}</li>)}
        </ul>
      )}
      {store.hasGmvVariance && (
        <p className="mt-2 border-t border-amber-100/10 pt-2 text-[10px] leading-4 text-amber-100/70">店铺营业额与千川净成交的归因、退款或自然流量口径存在差异，不直接代表源数据错误。</p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-white/[0.07] pt-3">
        <div><p className="text-[9px] text-slate-500">店铺 GMV</p><p className="mt-0.5 font-bold text-slate-100">¥{money(store.gmv)}</p></div>
        <div><p className="text-[9px] text-slate-500">千川净成交合计</p><p className="mt-0.5 font-bold text-cyan-100">¥{money(store.qianchuanGmv)}</p></div>
        <div><p className="text-[9px] text-slate-500">GMV 口径差额</p><p className={"mt-0.5 font-bold " + gapTone}>{store.gmvGap > 0 ? "+" : ""}¥{money(store.gmvGap)}</p></div>
        <div><p className="text-[9px] text-slate-500">投放消耗</p><p className="mt-0.5 font-bold text-slate-100">¥{money(store.adSpend)}</p></div>
      </div>
      <div className="mt-3 border-t border-white/[0.07] pt-3">
        <div className="flex items-center justify-between"><p className="font-bold text-slate-200">千川账户合计</p><span className="text-[9px] text-slate-500">{store.qianchuanAccounts.length} 个账户</span></div>
        <div className="mt-2 divide-y divide-white/[0.06]">
          {store.qianchuanAccounts.map((account) => (
            <div key={account.accountId} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate font-bold text-slate-200" title={account.accountName}>{account.accountName}</span><span className="shrink-0 text-[9px] text-slate-500">{account.planCount} 条计划</span></div>
              <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">{account.accountId}</p>
              <p className="mt-1 text-[10px] text-slate-400">消耗 ¥{money(account.spend)} · 净成交 ¥{money(account.netAmount)} · {money(account.netOrders)} 单</p>
            </div>
          ))}
          {!store.qianchuanAccounts.length && <p className="py-2 text-[10px] text-violet-100/75">当前周期没有可归属的千川账户明细。</p>}
        </div>
      </div>
      {store.gmvVarianceDays.length > 0 && (
        <div className="mt-3 border-t border-white/[0.07] pt-3">
          <div className="flex items-center justify-between"><p className="font-bold text-slate-200">主要差额日期</p><span className="text-[9px] text-slate-500">按差额绝对值</span></div>
          <div className="mt-2 divide-y divide-white/[0.06]">
            {store.gmvVarianceDays.map((day) => (
              <div key={day.date} className="grid grid-cols-[46px_minmax(0,1fr)_auto] items-center gap-2 py-1.5 text-[10px]">
                <span className="text-slate-400">{shortDate(day.date)}</span>
                <span className="truncate text-slate-500">店铺 ¥{money(day.storeGmv)} · 千川 ¥{money(day.qianchuanGmv)}</span>
                <span className={day.gap < 0 ? "text-rose-200" : "text-emerald-200"}>{day.gap > 0 ? "+" : ""}¥{money(day.gap)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectionPanel({ selection, onOpenStoreProducts }: { selection: Exclude<Selection, null>; onOpenStoreProducts: (storeName: string) => void }) {
  if (selection.type === "store") {
    const store = selection.value;
    return <><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100/60">Store Diagnosis</p><h3 className="mt-2 text-lg font-black text-slate-50">{store.storeName}</h3><p className="mt-1 text-xs text-slate-400">{store.username} · {store.hasPreviousData ? "当前周期对比前一等长周期" : "前一等长周期暂无数据"}</p><div className="mt-4 grid grid-cols-2 gap-2"><DetailMetric label="Excel 店铺利润" value={`¥${money(store.actualProfit)}`} tone={valueTone(store.actualProfit)} /><DetailMetric label="利润波动" value={moneyChange(store.hasPreviousData, store.profitChange)} tone={valueTone(store.profitChange)} /><DetailMetric label="Excel GMV" value={`¥${money(store.gmv)}`} /><DetailMetric label="GMV波动" value={moneyChange(store.hasPreviousData, store.gmvChange)} tone={valueTone(store.gmvChange)} /><DetailMetric label="投放消耗" value={`¥${money(store.adSpend)}`} /><DetailMetric label="消耗波动" value={moneyChange(store.hasPreviousData, store.adSpendChange)} tone={valueTone(-store.adSpendChange)} /></div><button type="button" onClick={() => onOpenStoreProducts(store.storeName)} data-border-glow className="mt-4 h-9 w-full rounded-lg border border-cyan-200/20 bg-cyan-300/10 text-xs font-bold text-cyan-50">查看该店商品波动</button><StoreReconciliationPanel store={store} /></>;
  }
  const product = selection.value;
  return <><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100/60">Product Diagnosis</p><h3 className="mt-2 text-lg font-black text-slate-50">{product.categoryName}</h3><p className="mt-1 text-xs text-slate-400">{product.storeName} · 商品 {product.productId}</p><p className="mt-1 font-mono text-[10px] text-slate-500">计划 {product.planId || "未匹配"}</p><div className="mt-3 flex items-center gap-2"><DecisionBadge decision={product.decision} /><MaturityBadge maturity={product.maturity} /><span className="text-xs font-bold text-cyan-100">净成交 ROI {product.netDealRoi.toFixed(2)}</span></div><div className="mt-4 grid grid-cols-2 gap-2"><DetailMetric label="Excel 利润(Y)" value={productProfit(product)} tone={product.profitAvailable ? valueTone(product.actualProfit) : "text-slate-500"} /><DetailMetric label="利润波动" value={product.profitAvailable ? moneyChange(product.hasPreviousData, product.profitChange) : "--"} tone={valueTone(product.profitChange)} /><DetailMetric label="净发货率" value={productPercent(product, "netShippingRate")} /><DetailMetric label="同店同类中位" value={product.storeCategoryNetShippingMedian === null ? "--" : percent(product.storeCategoryNetShippingMedian)} /><DetailMetric label="签收率" value={productPercent(product, "signRate")} /><DetailMetric label="全店同类中位" value={product.globalCategorySignMedian === null ? "--" : percent(product.globalCategorySignMedian)} /></div><div className="mt-4 border-t border-cyan-100/10 pt-3"><p className="text-xs font-bold text-slate-200">判断原因</p><ul className="mt-2 space-y-2">{product.reasons.map((reason) => <li key={reason} className="flex gap-2 text-xs leading-5 text-slate-300"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-cyan-200" />{reason}</li>)}</ul></div></>;
}

function DetailMetric({ label, value, tone = "text-slate-100" }: { label: string; value: string; tone?: string }) {
  return <div className="flex min-h-[64px] min-w-0 flex-col rounded-lg border border-white/9 bg-white/[0.035] px-3 py-2"><p className="text-[10px] text-slate-500">{label}</p><p className={`mt-auto truncate text-sm font-bold ${tone}`}>{value}</p></div>;
}
