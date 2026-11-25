"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { syncProductLibraryFromServer, useProductLibraryStore } from "@/lib/stores/product-library-store";
import { useTemplateStore } from "@/lib/stores/template-store";
import { useBrandStore } from "@/lib/stores/brand-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { hasAccountScopedStore, setBrowserAccountScope } from "@/lib/stores/account-scoped-storage";

const EMPTY_MODEL_SETTINGS = {
  providers: {},
  llm: { provider: "", baseUrl: "", apiKey: "", model: "", visionModel: "" },
};

function resetBrandStore() {
  useBrandStore.setState({
    brand: {
      id: crypto.randomUUID(),
      name: "我的店铺",
      primaryColor: "#6366f1",
      secondaryColor: "#8b5cf6",
      fontFamily: "默认字体",
      watermark: { enabled: false, position: "bottom-right", opacity: 0.3, scale: 0.15 },
      introEnabled: false,
      outroEnabled: false,
    },
  });
}

async function loadAccountStores() {
  const tasks: Promise<void>[] = [];
  if (hasAccountScopedStore("daihuo-jianshou-products")) tasks.push(Promise.resolve(useProductLibraryStore.persist.rehydrate()));
  else useProductLibraryStore.setState({ products: [] });
  if (hasAccountScopedStore("daihuo-jianshou-templates")) tasks.push(Promise.resolve(useTemplateStore.persist.rehydrate()));
  else useTemplateStore.setState({ templates: [] });
  if (hasAccountScopedStore("daihuo-jianshou-characters")) tasks.push(Promise.resolve(useCharacterStore.persist.rehydrate()));
  else useCharacterStore.setState({ characters: [] });
  if (hasAccountScopedStore("daihuo-jianshou-brand")) tasks.push(Promise.resolve(useBrandStore.persist.rehydrate()));
  else resetBrandStore();
  if (hasAccountScopedStore("daihuo-jianshou-settings")) tasks.push(Promise.resolve(useSettingsStore.persist.rehydrate()));
  else useSettingsStore.getState().replaceSettings(EMPTY_MODEL_SETTINGS);
  await Promise.all([
    ...tasks,
  ]);
}

export function LumaAuthSettingsBridge() {
  const replaceSettings = useSettingsStore((state) => state.replaceSettings);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" }).catch(() => null);
      const meData = await meRes?.json().catch(() => ({}));
      const user = meRes?.ok ? meData?.user : null;
      setBrowserAccountScope(user?.id || "anonymous", user?.role === "admin");
      await loadAccountStores();
      if (cancelled || !user) return;
      await syncProductLibraryFromServer();
      if (cancelled) return;

      const res = await fetch("/api/model-settings", { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (data.settings) {
        replaceSettings(data.settings);
        return;
      }

      if (user.role === "admin") {
        const state = useSettingsStore.getState();
        await fetch("/api/model-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { providers: state.providers, llm: state.llm } }),
        }).catch(() => null);
      } else {
        replaceSettings(EMPTY_MODEL_SETTINGS);
      }
    }
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [pathname, replaceSettings]);

  return null;
}
