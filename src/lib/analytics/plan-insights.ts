import type { analyticsPlanDaily, analyticsProductMetrics } from "@/lib/db/schema";

type PlanRow = typeof analyticsPlanDaily.$inferSelect;
type ProductRow = typeof analyticsProductMetrics.$inferSelect;

const ANALYSIS_START = "2026-10-25";
const MINIMUM_PLAN_SPEND = 1;
const MINIMUM_MATURE_AGE_DAYS = 4;

export type PlanProductInsight = {
  key: string;
  productName: string;
  price: number | null;
  priceLabel: string;
  productCount: number;
  firstBuildDate: string | null;
  latestPlanDate: string | null;
  totalPlans: number;
  eligiblePlans: number;
  convertedPlans: number;
  conversionRate: number | null;
  conversionCiLow: number | null;
  conversionCiHigh: number | null;
  totalSpend: number;
  netOrders: number;
  netAmount: number;
  netRoi: number | null;
  estimatedShippedOrders: number | null;
  estimatedSignedOrders: number | null;
  estimatedShippingRate: number | null;
  estimatedSignRate: number | null;
  matureProfit: number | null;
  matureKnownProfit: number;
  matureProfitKnownRows: number;
  matureProfitTotalRows: number;
  matureProfitPerOrder: number | null;
  matureThrough: string | null;
  matureOrderCount: number;
  accounts: number;
  accountBreakdown: PlanAccountInsight[];
};

export type PlanAccountInsight = {
  key: string;
  productKey: string;
  productName: string;
  price: number | null;
  priceLabel: string;
  accountId: string;
  accountShortName: string;
  accountName: string;
  eligiblePlans: number;
  convertedPlans: number;
  conversionRate: number | null;
  conversionCiLow: number | null;
  conversionCiHigh: number | null;
  recommendedPlans: number | null;
  recommendationRange: { low: number; high: number } | null;
  planCountBasis: string;
  totalSpend: number;
  netOrders: number;
  netAmount: number;
  netRoi: number | null;
  estimatedShippedOrders: number | null;
  estimatedSignedOrders: number | null;
  estimatedShippingRate: number | null;
  estimatedSignRate: number | null;
  estimatedProfit: number | null;
  estimatedKnownProfit: number;
  profitKnownRows: number;
  profitTotalRows: number;
  roiHitPlans: number;
  lowOrderStopPlans: number;
  modeledStoppedSpend: number;
  modeledStoppedPlans: number;
  modeledStopBasis: string;
  matureCohortPlans: number;
  matureCohortConvertedPlans: number;
  matureCohortRate: number | null;
  matureCohortCiLow: number | null;
  matureCohortCiHigh: number | null;
  firstBuildDate: string | null;
  latestPlanDate: string | null;
  suggestedNewPlans: number;
  suggestedRetainPlans: number;
  suggestedPausePlans: number;
  retainItems: PlanExecutionItem[];
  pauseItems: PlanExecutionItem[];
  fulfillmentBasis: "direct" | "allocated" | "unavailable";
  fulfillmentBasisNote: string;
  recommendedAction: "新增" | "保留" | "观察" | "压缩";
  recommendationNote: string;
};

export type PlanExecutionItem = {
  planId: string;
  productIds: string[];
  spend: number;
  effectiveOrders: number;
  netAmount: number;
  netRoi: number | null;
};

export type PlanQuotaInput = {
  key: string;
  suggestedNewPlans: number;
  conversionRate: number | null;
  estimatedProfit: number | null;
  netRoi: number | null;
};

export type PlanDailyFunnel = {
  date: string;
  activePlans: number;
  activePlansWithSpend: number;
  convertedPlans: number;
  newPlans: number;
  newConvertedPlans: number;
  oldPlans: number;
  oldConvertedPlans: number;
  spend: number;
  netOrders: number;
  effectiveOrders: number;
  netAmount: number;
  roiHitPlans: number;
  lowOrderStopPlans: number;
  newConversionRate: number | null;
  oldConversionRate: number | null;
  suggestedNewPlans: number;
  suggestedRetainPlans: number;
  suggestedPausePlans: number;
  recommendationStatus: "历史回放" | "样本不足";
};

export type PlanInsights = {
  analysisStart: string;
  analysisEnd: string | null;
  matureThrough: string | null;
  minimumMatureAgeDays: number;
  minimumEligibleSpend: number;
  productCount: number;
  accountCount: number;
  totalPlans: number;
  eligiblePlans: number;
  convertedPlans: number;
  conversionRate: number | null;
  conversionCiLow: number | null;
  conversionCiHigh: number | null;
  spend: number;
  netOrders: number;
  effectiveOrders: number;
  netAmount: number;
  netRoi: number | null;
  daily: PlanDailyFunnel[];
  products: PlanProductInsight[];
  accounts: PlanAccountInsight[];
  notices: string[];
  changes: PlanChangeInsights;
};

export type PlanChangeRow = {
  key: string;
  productName: string;
  price: number | null;
  accountId: string;
  accountShortName: string;
  status: "added" | "removed" | "changed";
  spendChange: number;
  netOrdersChange: number;
  effectiveOrdersChange: number;
  netAmountChange: number;
  conversionRateBefore: number | null;
  conversionRateAfter: number | null;
  conversionRateChange: number | null;
  currentPlans: number;
  previousPlans: number;
};

export type PlanChangeInsights = {
  available: boolean;
  currentSnapshotDate: string | null;
  previousSnapshotDate: string | null;
  currentImportId: string | null;
  previousImportId: string | null;
  addedPlans: number;
  removedPlans: number;
  changedPlans: number;
  currentPlans: number;
  previousPlans: number;
  spendChange: number;
  netOrdersChange: number;
  effectiveOrdersChange: number;
  netAmountChange: number;
  newConvertedPlans: number;
  conversionRateBefore: number | null;
  conversionRateAfter: number | null;
  conversionRateChange: number | null;
  productChanges: PlanChangeRow[];
  accountChanges: PlanChangeRow[];
  notices: string[];
};

type ProductGroup = {
  key: string;
  name: string;
  price: number | null;
  prices: Set<number>;
};

type PlanAggregate = {
  key: string;
  group: ProductGroup;
  accountId: string;
  accountShortName: string;
  accountName: string;
  plans: Map<string, { planId: string; productIds: Set<string>; buildDate: string | null; spend: number; effectiveOrders: number; netOrders: number; netAmount: number; roiHit: boolean; lowOrderStop: boolean; stopSpend: number }>;
  productLinks: Set<string>;
  matureEffectiveOrdersByLink: Map<string, number>;
  spend: number;
  netOrders: number;
  effectiveOrders: number;
  matureEffectiveOrders: number;
  netAmount: number;
  roiHitPlans: Set<string>;
  lowOrderStopPlans: Set<string>;
  modeledStoppedSpend: number;
  modeledStoppedPlans: Set<string>;
  daily: Map<string, PlanRow[]>;
};

type MatureProductAggregate = {
  shipped: number;
  pending: number;
  shippedRefunds: number;
  profit: number;
  orders: number;
  profitAvailable: boolean;
  profitKnownRows: number;
  profitTotalRows: number;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function addMoney(left: number, right: number) {
  return roundMoney(left + right);
}

function normalizeEffectivePlanRow(row: PlanRow): PlanRow {
  const averageNetAmount = row.netOrders > 0 ? row.netAmount / row.netOrders : 0;
  const isEffective = row.effectiveOrders > 0 && row.netAmount > 5 && averageNetAmount > 5;
  const effectiveOrders = isEffective ? row.effectiveOrders : 0;
  return {
    ...row,
    netOrders: effectiveOrders,
    effectiveOrders,
    netAmount: isEffective ? row.netAmount : 0,
    brushLike: isEffective ? 0 : row.netOrders > 0 ? 1 : row.brushLike,
    roiHit: isEffective && row.targetRoi > 0 && row.netRoi >= row.targetRoi ? 1 : 0,
    lowOrderStop: row.spend >= 150 && row.spend <= 300 && effectiveOrders < 2 ? 1 : 0,
  };
}

function normalizeName(value: unknown) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function canonicalProductName(value: string) {
  const normalized = normalizeName(value);
  return normalized
    .replace(/^(?:男装|女装|童装|婴装|内衣|鞋靴|鞋包|家居|家具|百货|日用|食品|美妆|数码|家电|运动|母婴|宠物|汽车|珠宝|文具|户外|箱包|配饰|服饰)[-_—–:：]/u, "")
    .replace(/(?:[-_ ]?(?:[A-Za-z]{0,4}\d{1,4}|\d{1,4}))$/u, "")
    .replace(/[\s_-]+$/u, "") || normalized;
}

function productNameAliases(value: string) {
  const normalized = normalizeName(value);
  const withoutPrefix = normalized.replace(/^[\p{L}\p{N}]{1,12}[-_—–:：]\s*/u, "");
  const withoutStyleCode = withoutPrefix.replace(/(?:[-_ ]?(?:[A-Za-z]{0,4}\d{1,4}|\d{1,4}))$/u, "").replace(/[\s_-]+$/u, "");
  return new Set([normalized, withoutPrefix, withoutStyleCode, canonicalProductName(normalized)]);
}

type CatalogIndex = {
  byProductLink: Map<string, string>;
  byAlias: Map<string, string | null>;
};

function catalogProductLinkKey(storeName: string, productId: string) {
  return `${normalizeName(storeName)}::${normalizeName(productId)}`;
}

function catalogProductName(name: string, catalogNames: Map<string, string | null>) {
  for (const alias of productNameAliases(name)) {
    const matched = catalogNames.get(alias);
    if (matched) return matched;
  }
  return canonicalProductName(name);
}

function productKey(name: string, _price: number | null) {
  void _price;
  return canonicalProductName(name);
}

function priceLabel(prices: Set<number>, fallback: number | null) {
  const values = [...prices].sort((left, right) => left - right);
  if (!values.length && fallback === null) return "价格未知";
  if (values.length <= 1) return values.length ? `¥${moneyValue(values[0])}` : `¥${moneyValue(fallback!)}`;
  return `多价格 · ${values.map((value) => `¥${moneyValue(value)}`).join(" / ")}`;
}

function moneyValue(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function ci95(successes: number, trials: number) {
  if (!trials) return { low: null, high: null };
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = (p + z * z / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function dayDistance(end: string, start: string) {
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function eligiblePlans(aggregate: PlanAggregate) {
  return [...aggregate.plans.entries()].filter(([, plan]) => plan.spend >= MINIMUM_PLAN_SPEND);
}

function estimatePlanCount(rate: number | null) {
  if (rate === null || rate <= 0) return null;
  return Math.ceil(Math.log(1 - 0.8) / Math.log(1 - Math.min(rate, 0.999999)));
}

export function allocatePlanQuota(inputs: PlanQuotaInput[], quota: number) {
  const target = Math.max(0, Math.floor(quota));
  const allocations = new Map(inputs.map((item) => [item.key, 0]));
  if (!target || !inputs.length) return allocations;

  const weights = inputs.map((item) => {
    const conversion = Math.max(0.01, item.conversionRate ?? 0.01);
    const roi = Math.max(0.25, Math.min(5, item.netRoi ?? 0.25));
    const profit = item.estimatedProfit === null ? 1 : Math.max(0.25, 1 + item.estimatedProfit / 1_000);
    return Math.max(0.01, (item.suggestedNewPlans + 1) * conversion * roi * profit);
  });
  let remaining = target;
  if (target >= inputs.length) {
    for (const item of inputs) allocations.set(item.key, 1);
    remaining -= inputs.length;
  }
  if (!remaining) return allocations;

  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const shares = inputs.map((item, index) => {
    const exact = remaining * weights[index] / totalWeight;
    const whole = Math.floor(exact);
    allocations.set(item.key, (allocations.get(item.key) ?? 0) + whole);
    return { key: item.key, remainder: exact - whole, weight: weights[index] };
  });
  let assigned = [...allocations.values()].reduce((sum, value) => sum + value, 0);
  shares.sort((left, right) => right.remainder - left.remainder || right.weight - left.weight || left.key.localeCompare(right.key));
  for (let index = 0; assigned < target; index += 1) {
    const item = shares[index % shares.length];
    allocations.set(item.key, (allocations.get(item.key) ?? 0) + 1);
    assigned += 1;
  }
  return allocations;
}

function sourceProductKey(row: ProductRow) {
  return productKey(row.categoryName || row.productName, row.price);
}

export function buildPlanInsights(
  planRows: PlanRow[],
  productRows: ProductRow[],
  snapshots: Array<{ ownerId: string; snapshotDate: string | null }>,
  catalogRows: ProductRow[] = productRows,
): PlanInsights {
  const catalog: CatalogIndex = { byProductLink: new Map(), byAlias: new Map() };
  for (const row of catalogRows) {
    if (row.isSummary) continue;
    const registeredName = normalizeName(row.categoryName || row.productName);
    if (!registeredName) continue;
    if (row.storeName && row.productId) {
      catalog.byProductLink.set(catalogProductLinkKey(row.storeName, row.productId), registeredName);
    }
    for (const alias of productNameAliases(registeredName)) {
      const existing = catalog.byAlias.get(alias);
      if (existing === undefined) catalog.byAlias.set(alias, registeredName);
      else if (existing !== registeredName) catalog.byAlias.set(alias, null);
    }
  }
  const planPeriodRows = planRows
    .filter((row) => row.metricDate >= ANALYSIS_START && row.spend >= 0)
    .map(normalizeEffectivePlanRow);
  const analysisEnd = planPeriodRows.map((row) => row.metricDate).sort().at(-1) ?? null;
  const snapshotByOwner = new Map(snapshots.map((item) => [item.ownerId, item.snapshotDate]));
  const matureThroughByOwner = new Map<string, string>();
  for (const [ownerId, snapshotDate] of snapshotByOwner) {
    if (!snapshotDate) continue;
    const timestamp = Date.parse(`${snapshotDate}T00:00:00Z`) - 5 * 86_400_000;
    matureThroughByOwner.set(ownerId, new Date(timestamp).toISOString().slice(0, 10));
  }
  const matureThrough = [...matureThroughByOwner.values()].sort().at(-1) ?? null;
  const groupByKey = new Map<string, ProductGroup>();
  const aggregates = new Map<string, PlanAggregate>();

  for (const row of planPeriodRows) {
    const name = normalizeName(row.productName || row.productId || "未识别商品");
    const catalogName = catalog.byProductLink.get(catalogProductLinkKey(row.storeName, row.productId))
      ?? catalogProductName(name, catalog.byAlias);
    const key = productKey(catalogName, row.price);
    const group = groupByKey.get(key) ?? { key, name: canonicalProductName(catalogName), price: row.price, prices: new Set<number>() };
    if (row.price !== null) group.prices.add(row.price);
    if (group.price === null && row.price !== null) group.price = row.price;
    groupByKey.set(key, group);
    const accountId = row.accountId || "未知账户";
    const aggregateKey = `${group.key}::${accountId}`;
    let aggregate = aggregates.get(aggregateKey);
    if (!aggregate) {
      aggregate = {
        key: aggregateKey,
        group,
        accountId,
        accountShortName: row.accountShortName || row.accountName || accountId,
        accountName: row.accountName || row.accountShortName || accountId,
        plans: new Map(),
        productLinks: new Set(),
        matureEffectiveOrdersByLink: new Map(),
        spend: 0,
        netOrders: 0,
        effectiveOrders: 0,
        matureEffectiveOrders: 0,
        netAmount: 0,
        roiHitPlans: new Set(),
        lowOrderStopPlans: new Set(),
        modeledStoppedSpend: 0,
        modeledStoppedPlans: new Set(),
        daily: new Map(),
      };
      aggregates.set(aggregateKey, aggregate);
    }
    const planKey = `${row.ownerId}::${accountId}::${row.planId}`;
    const productLinkKey = `${row.ownerId}::${row.storeName}::${row.productId}`;
    const plan = aggregate.plans.get(planKey) ?? { planId: row.planId, productIds: new Set<string>(), buildDate: row.buildDate, spend: 0, effectiveOrders: 0, netOrders: 0, netAmount: 0, roiHit: false, lowOrderStop: false, stopSpend: 0 };
    const effectiveNetAmount = row.netAmount;
    plan.productIds.add(row.productId);
    plan.spend = addMoney(plan.spend, row.spend);
    plan.effectiveOrders += row.effectiveOrders;
    plan.netOrders += row.effectiveOrders;
    plan.netAmount = addMoney(plan.netAmount, effectiveNetAmount);
    if (row.roiHit) {
      plan.roiHit = true;
      plan.stopSpend = addMoney(plan.stopSpend, row.spend);
    }
    if (row.lowOrderStop) {
      plan.lowOrderStop = true;
      plan.stopSpend = addMoney(plan.stopSpend, row.spend);
    }
    aggregate.plans.set(planKey, plan);
    aggregate.productLinks.add(productLinkKey);
    aggregate.spend = addMoney(aggregate.spend, row.spend);
    aggregate.netOrders += row.effectiveOrders;
    aggregate.effectiveOrders += row.effectiveOrders;
    const maturityCutoff = matureThroughByOwner.get(row.ownerId);
    if (maturityCutoff && row.metricDate <= maturityCutoff) {
      aggregate.matureEffectiveOrders += row.effectiveOrders;
      aggregate.matureEffectiveOrdersByLink.set(productLinkKey, (aggregate.matureEffectiveOrdersByLink.get(productLinkKey) ?? 0) + row.effectiveOrders);
    }
    aggregate.netAmount = addMoney(aggregate.netAmount, effectiveNetAmount);
    if (row.roiHit) aggregate.roiHitPlans.add(planKey);
    if (row.lowOrderStop) aggregate.lowOrderStopPlans.add(planKey);
    aggregate.daily.set(row.metricDate, [...(aggregate.daily.get(row.metricDate) ?? []), row]);
  }

  for (const aggregate of aggregates.values()) {
    for (const [planKey] of aggregate.plans) {
      const [ownerId, accountId, planId] = planKey.split("::");
      const dailyRows = [...aggregate.daily.entries()]
        .flatMap(([date, rows]) => rows.filter((row) => row.ownerId === ownerId && row.accountId === accountId && row.planId === planId).map((row) => ({ date, row })))
        .sort((left, right) => left.date.localeCompare(right.date));
      const stopEvent = dailyRows.find(({ row }) => row.roiHit || row.lowOrderStop);
      if (!stopEvent) continue;
      aggregate.modeledStoppedPlans.add(planKey);
      aggregate.modeledStoppedSpend = addMoney(
        aggregate.modeledStoppedSpend,
        dailyRows.filter(({ date }) => date <= stopEvent.date).reduce((total, item) => total + item.row.spend, 0),
      );
    }
  }

  const matureProducts = new Map<string, MatureProductAggregate>();
  const matureProductsByLink = new Map<string, MatureProductAggregate>();
  for (const row of productRows) {
    if (row.isSummary || !row.metricDate || row.metricDate < ANALYSIS_START) continue;
    const ownerCutoff = matureThroughByOwner.get(row.ownerId);
    if (!ownerCutoff || row.metricDate > ownerCutoff) continue;
    const key = sourceProductKey(row);
    const group = groupByKey.get(key) ?? { key, name: canonicalProductName(row.categoryName || row.productName), price: row.price, prices: new Set<number>() };
    if (row.price !== null) group.prices.add(row.price);
    if (group.price === null && row.price !== null) group.price = row.price;
    groupByKey.set(key, group);
    const total = matureProducts.get(key) ?? { shipped: 0, pending: 0, shippedRefunds: 0, profit: 0, orders: 0, profitAvailable: true, profitKnownRows: 0, profitTotalRows: 0 };
    total.shipped += row.shippedOrders;
    total.pending += row.pendingOrders;
    total.shippedRefunds += row.postShipRefundOrders;
    total.profitTotalRows += 1;
    if (row.profitAvailable !== false) {
      total.profit = addMoney(total.profit, row.actualProfit);
      total.profitKnownRows += 1;
    }
    else total.profitAvailable = false;
    total.orders += Math.max(0, row.paidOrders - row.fakeOrders);
    matureProducts.set(key, total);
    const productLinkKey = `${row.ownerId}::${row.storeName}::${row.productId}`;
    const linkTotal = matureProductsByLink.get(productLinkKey) ?? { shipped: 0, pending: 0, shippedRefunds: 0, profit: 0, orders: 0, profitAvailable: true, profitKnownRows: 0, profitTotalRows: 0 };
    linkTotal.shipped += row.shippedOrders;
    linkTotal.pending += row.pendingOrders;
    linkTotal.shippedRefunds += row.postShipRefundOrders;
    linkTotal.profitTotalRows += 1;
    if (row.profitAvailable !== false) {
      linkTotal.profit = addMoney(linkTotal.profit, row.actualProfit);
      linkTotal.profitKnownRows += 1;
    }
    else linkTotal.profitAvailable = false;
    linkTotal.orders += Math.max(0, row.paidOrders - row.fakeOrders);
    matureProductsByLink.set(productLinkKey, linkTotal);
  }

  const accountsByProductLink = new Map<string, Set<string>>();
  for (const aggregate of aggregates.values()) {
    for (const link of aggregate.productLinks) accountsByProductLink.set(link, new Set([...(accountsByProductLink.get(link) ?? []), aggregate.key]));
  }

  const accountBreakdowns: PlanAccountInsight[] = [];
  for (const aggregate of aggregates.values()) {
    const eligible = eligiblePlans(aggregate);
    if (!eligible.length) continue;
    const converted = eligible.filter(([, plan]) => plan.effectiveOrders > 0).length;
    const rate = eligible.length ? converted / eligible.length : null;
    const ci = ci95(converted, eligible.length);
    const maturePlans = eligible.filter(([, plan]) => plan.buildDate && analysisEnd && dayDistance(analysisEnd, plan.buildDate) >= MINIMUM_MATURE_AGE_DAYS);
    const matureConverted = maturePlans.filter(([, plan]) => plan.effectiveOrders > 0).length;
    const matureCi = ci95(matureConverted, maturePlans.length);
    const accountMature = { shipped: 0, pending: 0, shippedRefunds: 0, profit: 0, orders: 0, profitAvailable: true, profitKnownRows: 0, profitTotalRows: 0 };
    let assignedMatureLinks = 0;
    let sharedMatureLinks = 0;
    for (const link of aggregate.productLinks) {
      const linkMature = matureProductsByLink.get(link);
      if (!linkMature) continue;
      const linkedAccounts = accountsByProductLink.get(link) ?? new Set<string>();
      const denominator = [...linkedAccounts].reduce((sum, key) => sum + (aggregates.get(key)?.matureEffectiveOrdersByLink.get(link) ?? 0), 0);
      const share = linkedAccounts.size <= 1 ? 1 : denominator > 0 ? (aggregate.matureEffectiveOrdersByLink.get(link) ?? 0) / denominator : 0;
      if (share <= 0) continue;
      assignedMatureLinks += 1;
      if (linkedAccounts.size > 1) sharedMatureLinks += 1;
      accountMature.shipped += linkMature.shipped * share;
      accountMature.pending += linkMature.pending * share;
      accountMature.shippedRefunds += linkMature.shippedRefunds * share;
      if (linkMature.profitAvailable) accountMature.profit += linkMature.profit * share;
      else accountMature.profitAvailable = false;
      accountMature.profitKnownRows += linkMature.profitKnownRows;
      accountMature.profitTotalRows += linkMature.profitTotalRows;
      accountMature.orders += linkMature.orders * share;
    }
    const signed = assignedMatureLinks && accountMature.shipped + accountMature.pending > 0
      ? Math.max(0, accountMature.shipped + accountMature.pending - accountMature.shippedRefunds)
      : null;
    const matureProfit = assignedMatureLinks && accountMature.profitAvailable ? roundMoney(accountMature.profit) : null;
    const recommendationRange = ci.low !== null && ci.high !== null
      ? { low: estimatePlanCount(ci.high) ?? 0, high: estimatePlanCount(ci.low) ?? 0 }
      : null;
    const recommendedPlans = maturePlans.length >= 10 ? estimatePlanCount(maturePlans.length ? matureConverted / maturePlans.length : null) : null;
    const suggestedNewPlans = recommendedPlans === null ? 0 : Math.max(0, recommendedPlans - eligible.length);
    const suggestedRetainPlans = recommendedPlans === null ? eligible.length : Math.min(eligible.length, recommendedPlans);
    const suggestedPausePlans = recommendedPlans === null ? 0 : Math.max(0, eligible.length - recommendedPlans);
    const rankedPlans = eligible
      .map(([, plan]): PlanExecutionItem => ({
        planId: plan.planId,
        productIds: [...plan.productIds].sort(),
        spend: plan.spend,
        effectiveOrders: plan.effectiveOrders,
        netAmount: plan.netAmount,
        netRoi: plan.spend > 0 ? plan.netAmount / plan.spend : null,
      }))
      .sort((left, right) => Number(right.effectiveOrders > 0) - Number(left.effectiveOrders > 0) || (right.netRoi ?? -1) - (left.netRoi ?? -1) || right.netAmount - left.netAmount || left.spend - right.spend || left.planId.localeCompare(right.planId));
    const retainItems = rankedPlans.slice(0, suggestedRetainPlans);
    const pauseItems = rankedPlans.slice(suggestedRetainPlans);
    const recommendedAction = recommendedPlans === null
      ? "观察"
      : suggestedNewPlans > 0
        ? "新增"
        : suggestedPausePlans > 0
          ? "压缩"
          : "保留";
    const planCountBasis = maturePlans.length >= 10
      ? "成熟 cohort：搭建满 4 天，按历史有效成交率估算达到至少 1 条有效成交的 80% 概率计划数"
      : `成熟 cohort 仅 ${maturePlans.length} 条（至少需要 10 条才显示建议）`;
    accountBreakdowns.push({
      key: aggregate.key,
      productKey: aggregate.group.key,
      productName: aggregate.group.name,
      price: aggregate.group.prices.size === 1 ? [...aggregate.group.prices][0] : null,
      priceLabel: priceLabel(aggregate.group.prices, aggregate.group.price),
      accountId: aggregate.accountId,
      accountShortName: aggregate.accountShortName,
      accountName: aggregate.accountName,
      eligiblePlans: eligible.length,
      convertedPlans: converted,
      conversionRate: rate,
      conversionCiLow: ci.low,
      conversionCiHigh: ci.high,
      recommendedPlans,
      recommendationRange: maturePlans.length >= 10 ? recommendationRange : null,
      planCountBasis,
      totalSpend: aggregate.spend,
      netOrders: aggregate.netOrders,
      netAmount: aggregate.netAmount,
      netRoi: aggregate.spend > 0 ? aggregate.netAmount / aggregate.spend : null,
      estimatedShippedOrders: assignedMatureLinks ? roundMoney(accountMature.shipped) : null,
      estimatedSignedOrders: signed === null ? null : roundMoney(signed),
      estimatedShippingRate: assignedMatureLinks && accountMature.orders > 0 ? accountMature.shipped / accountMature.orders : null,
      estimatedSignRate: assignedMatureLinks && accountMature.shipped + accountMature.pending > 0 ? 1 - accountMature.shippedRefunds / (accountMature.shipped + accountMature.pending) : null,
      estimatedProfit: matureProfit,
      estimatedKnownProfit: roundMoney(accountMature.profit),
      profitKnownRows: accountMature.profitKnownRows,
      profitTotalRows: accountMature.profitTotalRows,
      roiHitPlans: aggregate.roiHitPlans.size,
      lowOrderStopPlans: aggregate.lowOrderStopPlans.size,
      modeledStoppedSpend: aggregate.modeledStoppedSpend,
      modeledStoppedPlans: aggregate.modeledStoppedPlans.size,
      modeledStopBasis: "基于每日 ROI/150–300 元且有效单少于 2 单规则回放，不代表脚本操作日志",
      matureCohortPlans: maturePlans.length,
      matureCohortConvertedPlans: matureConverted,
      matureCohortRate: maturePlans.length ? matureConverted / maturePlans.length : null,
      matureCohortCiLow: matureCi.low,
      matureCohortCiHigh: matureCi.high,
      firstBuildDate: [...aggregate.plans.values()].map((plan) => plan.buildDate).filter((date): date is string => Boolean(date)).sort()[0] ?? null,
      latestPlanDate: [...aggregate.daily.keys()].sort().at(-1) ?? null,
      suggestedNewPlans,
      suggestedRetainPlans,
      suggestedPausePlans,
      retainItems,
      pauseItems,
      fulfillmentBasis: !assignedMatureLinks ? "unavailable" : sharedMatureLinks ? "allocated" : "direct",
      fulfillmentBasisNote: !assignedMatureLinks
        ? "当前账户未匹配到可归属的成熟商品链接"
        : sharedMatureLinks
          ? `其中 ${sharedMatureLinks} 个商品链接被多个千川账户共用，按各账户成熟有效成交占比分摊`
          : `按当前账户匹配的 ${assignedMatureLinks} 个商品链接直接汇总`,
      recommendedAction,
      recommendationNote: recommendedPlans === null
        ? "成熟 cohort 少于 10 条，仅保留现有有效计划并继续观察"
        : `按成熟 cohort 80% 概率参考数 ${recommendedPlans} 条；新增/压缩仅作概率参考，需结合当日规则复核`,
    });
  }

  const products: PlanProductInsight[] = [...groupByKey.values()].map((group) => {
    const accounts = accountBreakdowns.filter((item) => item.productKey === group.key);
    const eligible = accounts.reduce((total, item) => total + item.eligiblePlans, 0);
    const converted = accounts.reduce((total, item) => total + item.convertedPlans, 0);
    const spend = accounts.reduce((total, item) => addMoney(total, item.totalSpend), 0);
    const orders = accounts.reduce((total, item) => total + item.netOrders, 0);
    const amount = accounts.reduce((total, item) => addMoney(total, item.netAmount), 0);
    const mature = matureProducts.get(group.key);
    const signed = mature && mature.shipped + mature.pending > 0 ? Math.max(0, mature.shipped + mature.pending - mature.shippedRefunds) : null;
    const convertedDates = accounts.flatMap((item) => [item.firstBuildDate, item.latestPlanDate]).filter((date): date is string => Boolean(date)).sort();
    const ci = ci95(converted, eligible);
    return {
      key: group.key,
      productName: group.name,
      price: group.prices.size === 1 ? [...group.prices][0] : null,
      priceLabel: priceLabel(group.prices, group.price),
      productCount: new Set(productRows.filter((row) => !row.isSummary && sourceProductKey(row) === group.key).map((row) => `${row.ownerId}:${row.storeName}:${row.productId}`)).size,
      firstBuildDate: accounts.map((item) => item.firstBuildDate).filter((date): date is string => Boolean(date)).sort()[0] ?? null,
      latestPlanDate: convertedDates.at(-1) ?? null,
      totalPlans: accounts.reduce((total, item) => total + item.eligiblePlans, 0),
      eligiblePlans: eligible,
      convertedPlans: converted,
      conversionRate: eligible ? converted / eligible : null,
      conversionCiLow: ci.low,
      conversionCiHigh: ci.high,
      totalSpend: spend,
      netOrders: orders,
      netAmount: amount,
      netRoi: spend > 0 ? amount / spend : null,
      estimatedShippedOrders: mature?.shipped ?? null,
      estimatedSignedOrders: signed,
      estimatedShippingRate: mature && mature.orders > 0 ? mature.shipped / mature.orders : null,
      estimatedSignRate: mature && mature.shipped + mature.pending > 0 ? 1 - mature.shippedRefunds / (mature.shipped + mature.pending) : null,
      matureProfit: mature?.profitAvailable ? mature.profit : null,
      matureKnownProfit: mature?.profit ?? 0,
      matureProfitKnownRows: mature?.profitKnownRows ?? 0,
      matureProfitTotalRows: mature?.profitTotalRows ?? 0,
      matureProfitPerOrder: mature?.profitAvailable && mature.orders > 0 ? mature.profit / mature.orders : null,
      matureThrough: [...matureThroughByOwner.values()].sort().at(-1) ?? null,
      matureOrderCount: mature?.orders ?? 0,
      accounts: accounts.length,
      accountBreakdown: accounts,
    };
  }).filter((item) => item.eligiblePlans > 0).sort((left, right) => (right.matureProfit ?? -Infinity) - (left.matureProfit ?? -Infinity) || right.convertedPlans - left.convertedPlans);

  const dailyMap = new Map<string, PlanRow[]>();
  for (const row of planPeriodRows) dailyMap.set(row.metricDate, [...(dailyMap.get(row.metricDate) ?? []), row]);
  const daily: PlanDailyFunnel[] = [...dailyMap.entries()].map(([date, rows]): PlanDailyFunnel => {
    const plans = new Map<string, PlanRow[]>();
    for (const row of rows) {
      const key = `${row.ownerId}::${row.accountId}::${row.planId}`;
      plans.set(key, [...(plans.get(key) ?? []), row]);
    }
    const values = [...plans.values()];
    const spendPlans = values.filter((items) => items.reduce((total, item) => total + item.spend, 0) >= MINIMUM_PLAN_SPEND);
    const newPlans = spendPlans.filter((items) => items.some((item) => item.buildDate === date));
    const oldPlans = spendPlans.filter((items) => items.every((item) => item.buildDate !== date));
    const converted = (items: PlanRow[]) => items.some((item) => item.effectiveOrders > 0);
    return {
      date,
      activePlans: values.length,
      activePlansWithSpend: spendPlans.length,
      convertedPlans: spendPlans.filter(converted).length,
      newPlans: newPlans.length,
      newConvertedPlans: newPlans.filter(converted).length,
      oldPlans: oldPlans.length,
      oldConvertedPlans: oldPlans.filter(converted).length,
      spend: roundMoney(rows.reduce((total, row) => total + row.spend, 0)),
      netOrders: rows.reduce((total, row) => total + row.effectiveOrders, 0),
      effectiveOrders: rows.reduce((total, row) => total + row.effectiveOrders, 0),
      netAmount: roundMoney(rows.reduce((total, row) => total + row.netAmount, 0)),
      roiHitPlans: new Set(rows.filter((row) => row.roiHit).map((row) => `${row.accountId}:${row.planId}`)).size,
      lowOrderStopPlans: new Set(rows.filter((row) => row.lowOrderStop).map((row) => `${row.accountId}:${row.planId}`)).size,
      newConversionRate: newPlans.length ? newPlans.filter(converted).length / newPlans.length : null,
      oldConversionRate: oldPlans.length ? oldPlans.filter(converted).length / oldPlans.length : null,
      suggestedNewPlans: newPlans.length,
      suggestedRetainPlans: oldPlans.filter(converted).length,
      suggestedPausePlans: Math.max(0, oldPlans.length - oldPlans.filter(converted).length),
      recommendationStatus: newPlans.length || oldPlans.length ? "历史回放" : "样本不足",
    };
  }).sort((left, right) => left.date.localeCompare(right.date));

  const totalSpend = accountBreakdowns.reduce((total, item) => addMoney(total, item.totalSpend), 0);
  const totalNetOrders = accountBreakdowns.reduce((total, item) => total + item.netOrders, 0);
  const totalEffectiveOrders = planPeriodRows.reduce((total, row) => total + row.effectiveOrders, 0);
  const totalNetAmount = accountBreakdowns.reduce((total, item) => addMoney(total, item.netAmount), 0);
  const eligibleTotal = accountBreakdowns.reduce((total, item) => total + item.eligiblePlans, 0);
  const convertedTotal = accountBreakdowns.reduce((total, item) => total + item.convertedPlans, 0);
  const totalCi = ci95(convertedTotal, eligibleTotal);
  const notices = [
    "账户发货、签收和成熟利润优先按商品链接直接归属；同一商品链接被多个千川账户共用时，才按各账户成熟有效成交占比分摊，并在账户行标记为共享链接估算。",
    "计划转化率以消耗达到 1 元的唯一计划为分母；净成交总额不超过 5 元，或多单记录的单均净成交金额不超过 5 元，按赔付刷单处理，不进入有效成交单数、有效成交金额和有效 ROI。",
    "概率计划数表示历史成熟 cohort 下达到至少 1 条有效成交 80% 概率的计划数量，不等同于利润全局最优；没有账户总预算/刷单承载上限时不存在有限的利润最大化计划数。",
    "ROI 达标/150–300 元低有效单停投为按日数据回放，当前文件没有脚本操作日志，不能断言该计划实际由规则关停。",
    "成熟商品利润只累计 2026-10-25 至各批次快照日前 5 天的数据；赔付和售后更新频率可能导致账户分摊值滞后。",
  ];
  return {
    analysisStart: ANALYSIS_START,
    analysisEnd,
    matureThrough,
    minimumMatureAgeDays: MINIMUM_MATURE_AGE_DAYS,
    minimumEligibleSpend: MINIMUM_PLAN_SPEND,
    productCount: products.length,
    accountCount: new Set(accountBreakdowns.map((item) => item.accountId)).size,
    totalPlans: new Set(planPeriodRows.map((row) => `${row.ownerId}::${row.accountId}::${row.planId}`)).size,
    eligiblePlans: eligibleTotal,
    convertedPlans: convertedTotal,
    conversionRate: eligibleTotal ? convertedTotal / eligibleTotal : null,
    conversionCiLow: totalCi.low,
    conversionCiHigh: totalCi.high,
    spend: totalSpend,
    netOrders: totalNetOrders,
    effectiveOrders: totalEffectiveOrders,
    netAmount: totalNetAmount,
    netRoi: totalSpend > 0 ? totalNetAmount / totalSpend : null,
    daily,
    products,
    accounts: accountBreakdowns.sort((left, right) => (right.matureCohortRate ?? -1) - (left.matureCohortRate ?? -1) || right.eligiblePlans - left.eligiblePlans),
    notices,
    changes: emptyPlanChangeInsights(),
  };
}

function emptyPlanChangeInsights(context?: {
  currentSnapshotDate?: string | null;
  previousSnapshotDate?: string | null;
  currentImportId?: string | null;
  previousImportId?: string | null;
  notice?: string;
}): PlanChangeInsights {
  return {
    available: false,
    currentSnapshotDate: context?.currentSnapshotDate ?? null,
    previousSnapshotDate: context?.previousSnapshotDate ?? null,
    currentImportId: context?.currentImportId ?? null,
    previousImportId: context?.previousImportId ?? null,
    addedPlans: 0,
    removedPlans: 0,
    changedPlans: 0,
    currentPlans: 0,
    previousPlans: 0,
    spendChange: 0,
    netOrdersChange: 0,
    effectiveOrdersChange: 0,
    netAmountChange: 0,
    newConvertedPlans: 0,
    conversionRateBefore: null,
    conversionRateAfter: null,
    conversionRateChange: null,
    productChanges: [],
    accountChanges: [],
    notices: [context?.notice ?? "当前没有上一份正式快照，暂时只显示当前经营状态。"],
  };
}

type SnapshotPlanAggregate = {
  key: string;
  productKey: string;
  productName: string;
  price: number | null;
  accountId: string;
  accountShortName: string;
  spend: number;
  netOrders: number;
  effectiveOrders: number;
  netAmount: number;
};

function snapshotPlanKey(row: PlanRow) {
  return `${row.ownerId}::${row.accountId || "未知账户"}::${row.planId}`;
}

function snapshotProductKey(row: PlanRow) {
  return productKey(normalizeName(row.productName || row.productId || "未识别商品"), row.price);
}

function aggregateSnapshotPlans(rows: PlanRow[]) {
  const map = new Map<string, SnapshotPlanAggregate>();
  for (const row of rows.filter((item) => item.metricDate >= ANALYSIS_START).map(normalizeEffectivePlanRow)) {
    const key = snapshotPlanKey(row);
    const current = map.get(key) ?? {
      key,
      productKey: snapshotProductKey(row),
      productName: canonicalProductName(row.productName || row.productId || "未识别商品"),
      price: row.price,
      accountId: row.accountId || "未知账户",
      accountShortName: row.accountShortName || row.accountName || row.accountId || "未知账户",
      spend: 0,
      netOrders: 0,
      effectiveOrders: 0,
      netAmount: 0,
    };
    current.spend = addMoney(current.spend, row.spend);
    current.netOrders += row.netOrders;
    current.effectiveOrders += row.effectiveOrders;
    current.netAmount = addMoney(current.netAmount, row.netAmount);
    map.set(key, current);
  }
  return map;
}

function aggregateChangeRows(rows: PlanChangeRow[], by: "product" | "account") {
  const groups = new Map<string, PlanChangeRow>();
  for (const row of rows) {
    const key = by === "product" ? canonicalProductName(row.productName) : canonicalProductName(row.productName) + "::" + row.accountId;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...row, key });
      continue;
    }
    current.spendChange = addMoney(current.spendChange, row.spendChange);
    if (current.status !== row.status) current.status = "changed";
    current.netOrdersChange += row.netOrdersChange;
    current.effectiveOrdersChange += row.effectiveOrdersChange;
    current.netAmountChange = addMoney(current.netAmountChange, row.netAmountChange);
    current.currentPlans += row.currentPlans;
    current.previousPlans += row.previousPlans;
  }
  return [...groups.values()].sort((left, right) => Math.abs(right.spendChange) + Math.abs(right.netAmountChange) - Math.abs(left.spendChange) - Math.abs(left.netAmountChange)).slice(0, 120);
}

export function buildPlanChangeInsights(input: {
  currentRows: PlanRow[];
  previousRows: PlanRow[];
  currentSnapshotDate: string | null;
  previousSnapshotDate: string | null;
  currentImportId: string | null;
  previousImportId: string | null;
}): PlanChangeInsights {
  if (!input.previousRows.length) {
    const notice = input.previousImportId
      ? "上一份正式快照未包含计划明细，无法建立计划变化基线；当前仅显示最新计划状态，待下一次完整快照后开始比较。"
      : "当前没有上一份正式快照，暂时只显示当前经营状态。";
    return emptyPlanChangeInsights({ ...input, notice });
  }
  const current = aggregateSnapshotPlans(input.currentRows);
  const previous = aggregateSnapshotPlans(input.previousRows);
  const keys = new Set([...current.keys(), ...previous.keys()]);
  const changes: PlanChangeRow[] = [];
  let newConvertedPlans = 0;
  for (const key of keys) {
    const after = current.get(key);
    const before = previous.get(key);
    const status: PlanChangeRow["status"] = !before ? "added" : !after ? "removed" : "changed";
    const currentSpend = after?.spend ?? 0;
    const previousSpend = before?.spend ?? 0;
    const currentRate = after && currentSpend >= MINIMUM_PLAN_SPEND ? (after.effectiveOrders > 0 ? 1 : 0) : null;
    const previousRate = before && previousSpend >= MINIMUM_PLAN_SPEND ? (before.effectiveOrders > 0 ? 1 : 0) : null;
    const spendChange = addMoney(currentSpend, -previousSpend);
    const netOrdersChange = (after?.netOrders ?? 0) - (before?.netOrders ?? 0);
    const effectiveOrdersChange = (after?.effectiveOrders ?? 0) - (before?.effectiveOrders ?? 0);
    const netAmountChange = addMoney(after?.netAmount ?? 0, -(before?.netAmount ?? 0));
    if (status === "added" && (after?.effectiveOrders ?? 0) > 0) newConvertedPlans += 1;
    const source = after ?? before!;
    if (status === "changed" && Math.abs(spendChange) < 0.01 && netOrdersChange === 0 && effectiveOrdersChange === 0 && Math.abs(netAmountChange) < 0.01) continue;
    changes.push({
      key,
      productName: source.productName,
      price: source.price,
      accountId: source.accountId,
      accountShortName: source.accountShortName,
      status,
      spendChange,
      netOrdersChange,
      effectiveOrdersChange,
      netAmountChange,
      conversionRateBefore: previousRate,
      conversionRateAfter: currentRate,
      conversionRateChange: previousRate !== null && currentRate !== null ? currentRate - previousRate : null,
      currentPlans: after ? 1 : 0,
      previousPlans: before ? 1 : 0,
    });
  }
  const eligibleBefore = [...previous.values()].filter((item) => item.spend >= MINIMUM_PLAN_SPEND);
  const eligibleAfter = [...current.values()].filter((item) => item.spend >= MINIMUM_PLAN_SPEND);
  const convertedBefore = eligibleBefore.filter((item) => item.effectiveOrders > 0).length;
  const convertedAfter = eligibleAfter.filter((item) => item.effectiveOrders > 0).length;
  const rateBefore = eligibleBefore.length ? convertedBefore / eligibleBefore.length : null;
  const rateAfter = eligibleAfter.length ? convertedAfter / eligibleAfter.length : null;
  return {
    available: true,
    currentSnapshotDate: input.currentSnapshotDate,
    previousSnapshotDate: input.previousSnapshotDate,
    currentImportId: input.currentImportId,
    previousImportId: input.previousImportId,
    addedPlans: changes.filter((row) => row.status === "added").length,
    removedPlans: changes.filter((row) => row.status === "removed").length,
    changedPlans: changes.filter((row) => row.status === "changed").length,
    currentPlans: current.size,
    previousPlans: previous.size,
    spendChange: addMoney([...current.values()].reduce((sum, row) => sum + row.spend, 0), -[...previous.values()].reduce((sum, row) => sum + row.spend, 0)),
    netOrdersChange: [...current.values()].reduce((sum, row) => sum + row.netOrders, 0) - [...previous.values()].reduce((sum, row) => sum + row.netOrders, 0),
    effectiveOrdersChange: [...current.values()].reduce((sum, row) => sum + row.effectiveOrders, 0) - [...previous.values()].reduce((sum, row) => sum + row.effectiveOrders, 0),
    netAmountChange: addMoney([...current.values()].reduce((sum, row) => sum + row.netAmount, 0), -[...previous.values()].reduce((sum, row) => sum + row.netAmount, 0)),
    newConvertedPlans,
    conversionRateBefore: rateBefore,
    conversionRateAfter: rateAfter,
    conversionRateChange: rateBefore !== null && rateAfter !== null ? rateAfter - rateBefore : null,
    productChanges: aggregateChangeRows(changes, "product"),
    accountChanges: aggregateChangeRows(changes, "account"),
    notices: [
      "变化量按最新完整快照与上一份正式快照比较；当前快照缺失的计划标为移除/疑似关停，不按 0 元处理。",
      "计划变化使用 2026-10-25 起的累计窗口；发货、签收和赔付回补会修正历史数值，但不会伪造新的投放事实。",
    ],
  };
}

export function mergePlanChangeInsights(parts: PlanChangeInsights[]): PlanChangeInsights {
  const available = parts.some((part) => part.available);
  const first = parts.find((part) => part.available) ?? emptyPlanChangeInsights();
  const productChanges = aggregateChangeRows(parts.flatMap((part) => part.productChanges), "product");
  const accountChanges = aggregateChangeRows(parts.flatMap((part) => part.accountChanges), "account");
  const totalCurrent = parts.reduce((sum, part) => sum + part.currentPlans, 0);
  const totalPrevious = parts.reduce((sum, part) => sum + part.previousPlans, 0);
  const beforeRate = totalPrevious ? parts.reduce((sum, part) => sum + (part.conversionRateBefore ?? 0) * part.previousPlans, 0) / totalPrevious : null;
  const afterRate = totalCurrent ? parts.reduce((sum, part) => sum + (part.conversionRateAfter ?? 0) * part.currentPlans, 0) / totalCurrent : null;
  return {
    ...first,
    available,
    currentSnapshotDate: parts.map((part) => part.currentSnapshotDate).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null,
    previousSnapshotDate: parts.map((part) => part.previousSnapshotDate).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null,
    currentImportId: parts.length === 1 ? first.currentImportId : null,
    previousImportId: parts.length === 1 ? first.previousImportId : null,
    addedPlans: parts.reduce((sum, part) => sum + part.addedPlans, 0),
    removedPlans: parts.reduce((sum, part) => sum + part.removedPlans, 0),
    changedPlans: parts.reduce((sum, part) => sum + part.changedPlans, 0),
    currentPlans: totalCurrent,
    previousPlans: totalPrevious,
    spendChange: parts.reduce((sum, part) => addMoney(sum, part.spendChange), 0),
    netOrdersChange: parts.reduce((sum, part) => sum + part.netOrdersChange, 0),
    effectiveOrdersChange: parts.reduce((sum, part) => sum + part.effectiveOrdersChange, 0),
    netAmountChange: parts.reduce((sum, part) => addMoney(sum, part.netAmountChange), 0),
    newConvertedPlans: parts.reduce((sum, part) => sum + part.newConvertedPlans, 0),
    conversionRateBefore: beforeRate,
    conversionRateAfter: afterRate,
    conversionRateChange: beforeRate !== null && afterRate !== null ? afterRate - beforeRate : null,
    productChanges,
    accountChanges,
    notices: [...new Set(parts.flatMap((part) => part.notices))],
  };
}
