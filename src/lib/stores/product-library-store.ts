import { create } from "zustand";
import { persist } from "zustand/middleware";
import { scopedStorageKey } from "@/lib/stores/account-scoped-storage";

// 商品条目
export interface ProductItem {
  id: string;
  name: string;
  category: "beauty" | "food" | "home" | "fashion" | "tech" | "other";
  description?: string;
  images: string[]; // 本地 blob URL 或服务器 URL
  /** @deprecated 商品库不再使用价格字段，仅保留旧数据兼容。 */
  price?: string;
  targetAudience?: string;
  /** @deprecated 结构锁由 LLM 根据商品图自动反推，商品库不再手填。 */
  structureLock?: string;
  usageScenarios?: string;
  negativeConstraints?: string;
  videoCount: number;
  createdAt: Date;
}

export const DEFAULT_PRODUCT_STRUCTURE_LOCK_RULE = [
  "DEFAULT PRODUCT STRUCTURE LOCK RULE:",
  "First perform visual analysis on the current product images, then infer a concrete product structure lock.",
  "The structure lock must cover color, silhouette, cut, material, pattern, key components, detail positions, proportions, product placement, and non-changeable details.",
  "Product images have the highest priority. Script style, method library, reference videos, identity packs, and generic category knowledge must never override the real product structure.",
  "During image and video generation, do not change the product color, style, cut, material, pattern, key structure, or proportions. Do not let the product disappear, deform, switch category, or generate logos, text, watermarks, price tags, or unrelated brand elements.",
].join("\n");

export function buildProductLockInstruction(product: Pick<ProductItem, "name" | "category" | "images">) {
  return [
    DEFAULT_PRODUCT_STRUCTURE_LOCK_RULE,
    `Current product reference image count: ${product.images.length}`,
    "Write the concrete product style, color, material, silhouette, key components, and non-changeable details from the product images into an explicit product structure lock before writing scripts, keyframe prompts, or video director prompts.",
  ].join("\n");
}

// 商品库状态
interface ProductLibraryState {
  products: ProductItem[];
  replaceProducts: (products: ProductItem[]) => void;
  addProduct: (product: ProductItem) => void;
  updateProduct: (id: string, updates: Partial<ProductItem>) => void;
  removeProduct: (id: string) => void;
  incrementVideoCount: (id: string) => void;
}

export const useProductLibraryStore = create<ProductLibraryState>()(
  persist(
    (set) => ({
      products: [],

      replaceProducts: (products) => set({ products }),

      // 添加商品
      addProduct: (product) =>
        set((state) => ({ products: [...state.products, product] })),

      // 更新商品
      updateProduct: (id, updates) =>
        set((state) => ({
          products: state.products.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
        })),

      // 删除商品
      removeProduct: (id) =>
        set((state) => ({
          products: state.products.filter((p) => p.id !== id),
        })),

      // 递增视频生成计数
      incrementVideoCount: (id) =>
        set((state) => ({
          products: state.products.map((p) =>
            p.id === id ? { ...p, videoCount: p.videoCount + 1 } : p
          ),
        })),
    }),
    {
      name: "daihuo-jianshou-products",
      // JSON 序列化会将 Date 转为字符串，读取时需要还原
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(scopedStorageKey(name));
          if (!str) return null;
          const parsed = JSON.parse(str);
          if (parsed?.state?.products) {
            parsed.state.products = parsed.state.products.map(
              (p: Record<string, unknown>) => ({
                ...p,
                createdAt: new Date(p.createdAt as string),
              })
            );
          }
          return parsed;
        },
        setItem: (name, value) => localStorage.setItem(scopedStorageKey(name), JSON.stringify(value)),
        removeItem: (name) => localStorage.removeItem(scopedStorageKey(name)),
      },
      skipHydration: true,
    }
  )
);

function normalizeServerProduct(value: ProductItem) {
  return {
    ...value,
    createdAt: value.createdAt instanceof Date ? value.createdAt : new Date(value.createdAt),
  } as ProductItem;
}

/**
 * The browser store remains a short-lived cache and migration source only.
 * The authenticated server library is the source of truth for product records.
 */
export async function syncProductLibraryFromServer() {
  const localProducts = useProductLibraryStore.getState().products;
  const response = await fetch("/api/products", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return false;
  const payload = await response.json().catch(() => ({}));
  let serverProducts = Array.isArray(payload.products) ? payload.products.map(normalizeServerProduct) : [];

  if (serverProducts.length === 0 && localProducts.length > 0) {
    const migration = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ products: localProducts }),
    }).catch(() => null);
    if (migration?.ok) {
      const migrated = await migration.json().catch(() => ({}));
      serverProducts = Array.isArray(migrated.products) ? migrated.products.map(normalizeServerProduct) : serverProducts;
    }
  }

  useProductLibraryStore.getState().replaceProducts(serverProducts);
  return true;
}
