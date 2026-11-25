export type ProductionLocation = { id: string; view: "setup" | "results"; step: "product" | "production" };
const keys = ["productionTaskId", "productionView", "productionStep"];

export function readProductionLocation(href: string): ProductionLocation | null {
  const url = new URL(href);
  const id = url.searchParams.get(keys[0]);
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return { id, view: url.searchParams.get(keys[1]) === "results" ? "results" : "setup", step: url.searchParams.get(keys[2]) === "production" ? "production" : "product" };
}

export function productionLocationUrl(href: string, location: ProductionLocation | null) {
  const url = new URL(href);
  keys.forEach((key) => url.searchParams.delete(key));
  if (location) {
    url.searchParams.set(keys[0], location.id);
    url.searchParams.set(keys[1], location.view);
    url.searchParams.set(keys[2], location.step);
  }
  return url.pathname + url.search + url.hash;
}
