import { describe, expect, it } from "vitest";
import { nextMetricSort, sortByMetric, type MetricSort } from "@/lib/analytics/metric-sort";

type Row = { id: string; spend: number | null; paidOrders: number };

describe("metric sort", () => {
  const rows: Row[] = [
    { id: "b", spend: 10, paidOrders: 5 },
    { id: "a", spend: 30, paidOrders: 2 },
    { id: "missing", spend: null, paidOrders: 8 },
  ];

  it("starts a new metric in descending order and then reverses it", () => {
    const current: MetricSort<"spend" | "paidOrders"> = { key: "spend", direction: "asc" };
    expect(nextMetricSort(current, "paidOrders")).toEqual({ key: "paidOrders", direction: "desc" });
    expect(nextMetricSort({ key: "paidOrders", direction: "desc" }, "paidOrders")).toEqual({ key: "paidOrders", direction: "asc" });
  });

  it("sorts numeric fields by value and keeps missing values at the bottom", () => {
    const descending = sortByMetric(rows, { key: "spend", direction: "desc" }, (row, key) => row[key], (left, right) => left.id.localeCompare(right.id));
    const ascending = sortByMetric(rows, { key: "spend", direction: "asc" }, (row, key) => row[key], (left, right) => left.id.localeCompare(right.id));
    expect(descending.map((row) => row.id)).toEqual(["a", "b", "missing"]);
    expect(ascending.map((row) => row.id)).toEqual(["b", "a", "missing"]);
  });
});
