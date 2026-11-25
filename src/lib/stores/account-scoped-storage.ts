import type { StateStorage } from "zustand/middleware";

const ACTIVE_SCOPE_KEY = "luma-active-account-scope";
const LEGACY_STORE_NAMES = [
  "daihuo-jianshou-products",
  "daihuo-jianshou-templates",
  "daihuo-jianshou-settings",
  "daihuo-jianshou-brand",
  "daihuo-jianshou-characters",
];

function activeScope() {
  if (typeof window === "undefined") return "server";
  return window.localStorage.getItem(ACTIVE_SCOPE_KEY) || "anonymous";
}

export function scopedStorageKey(name: string) {
  return `${name}:${activeScope()}`;
}

export function hasAccountScopedStore(name: string) {
  return typeof window !== "undefined" && window.localStorage.getItem(scopedStorageKey(name)) !== null;
}

export function setBrowserAccountScope(userId: string, migrateLegacy = false) {
  if (typeof window === "undefined") return;
  const scope = userId.trim() || "anonymous";
  window.localStorage.setItem(ACTIVE_SCOPE_KEY, scope);

  if (!migrateLegacy) return;
  for (const name of LEGACY_STORE_NAMES) {
    const scopedKey = `${name}:${scope}`;
    if (window.localStorage.getItem(scopedKey) !== null) continue;
    const legacyValue = window.localStorage.getItem(name);
    if (legacyValue !== null) window.localStorage.setItem(scopedKey, legacyValue);
  }
}

export const accountScopedStateStorage: StateStorage = {
  getItem: (name) => window.localStorage.getItem(scopedStorageKey(name)),
  setItem: (name, value) => window.localStorage.setItem(scopedStorageKey(name), value),
  removeItem: (name) => window.localStorage.removeItem(scopedStorageKey(name)),
};
