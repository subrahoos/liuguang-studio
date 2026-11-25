export type StoreDiagnosticStatus = "profit" | "thin" | "loss" | "gmv_variance" | "data_issue";

export type StoreGmvVarianceDay = {
  date: string;
  storeGmv: number;
  qianchuanGmv: number;
  gap: number;
  gapRate: number | null;
};

export function storeGmvGapRate(gmv: number, gmvGap: number) {
  return Math.abs(gmv) > 0 ? Math.abs(gmvGap) / Math.abs(gmv) : null;
}

export function isStoreGmvVariance(gmv: number, gmvGap: number) {
  return Math.abs(gmvGap) > Math.max(500, Math.abs(gmv) * 0.05);
}

export function classifyStoreDiagnostic(input: {
  gmv: number;
  gmvGap: number;
  actualProfit: number;
  hasDataIssue: boolean;
}): StoreDiagnosticStatus {
  if (input.hasDataIssue) return "data_issue";
  if (isStoreGmvVariance(input.gmv, input.gmvGap)) return "gmv_variance";
  if (input.actualProfit < 0) return "loss";
  if (input.gmv > 0 && input.actualProfit / input.gmv < 0.05) return "thin";
  return "profit";
}

export function topStoreGmvVarianceDays(
  rows: Array<{ metricDate: string; gmv: number; gmvGap: number }>,
  limit = 5,
): StoreGmvVarianceDay[] {
  return rows
    .filter((row) => Math.abs(row.gmvGap) >= 0.01)
    .sort((left, right) => Math.abs(right.gmvGap) - Math.abs(left.gmvGap) || right.metricDate.localeCompare(left.metricDate))
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      date: row.metricDate,
      storeGmv: row.gmv,
      qianchuanGmv: Number((row.gmv + row.gmvGap).toFixed(2)),
      gap: row.gmvGap,
      gapRate: storeGmvGapRate(row.gmv, row.gmvGap),
    }));
}
