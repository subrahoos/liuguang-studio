export type MetricSortDirection = "asc" | "desc";

export type MetricSort<Key extends string> = {
  key: Key;
  direction: MetricSortDirection;
};

export function nextMetricSort<Key extends string>(current: MetricSort<Key>, key: Key): MetricSort<Key> {
  if (current.key === key) {
    return { key, direction: current.direction === "desc" ? "asc" : "desc" };
  }
  return { key, direction: "desc" };
}

export function sortByMetric<T, Key extends string>(
  items: readonly T[],
  sort: MetricSort<Key>,
  valueFor: (item: T, key: Key) => number | null | undefined,
  fallback: (left: T, right: T) => number,
) {
  return [...items].sort((left, right) => {
    const leftValue = valueFor(left, sort.key);
    const rightValue = valueFor(right, sort.key);
    const leftMissing = !Number.isFinite(leftValue);
    const rightMissing = !Number.isFinite(rightValue);
    if (leftMissing || rightMissing) {
      if (leftMissing && rightMissing) return fallback(left, right);
      return leftMissing ? 1 : -1;
    }
    const difference = sort.direction === "desc"
      ? (rightValue as number) - (leftValue as number)
      : (leftValue as number) - (rightValue as number);
    return difference || fallback(left, right);
  });
}
