"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ImageIcon, RotateCcw, Save, Upload } from "lucide-react";
import { LumaGalaxyBackground } from "@/components/luma-galaxy-background";

export type BackgroundType = "shader" | "image" | "video";
export type HomeBackgroundPreset = "galaxy" | "planet" | "luma";

export type HomeBackgroundSettings = {
  type: BackgroundType;
  dataUrl?: string;
  brightness: number;
  blur: number;
  overlay: number;
  speed: number;
};

type HomeBackgroundStore = {
  currentPreset: HomeBackgroundPreset;
  useDefaultAnimation: boolean;
  defaultAnimationSettings: HomeBackgroundSettings;
  presets: Record<HomeBackgroundPreset, HomeBackgroundSettings>;
};

export const HOME_BACKGROUND_KEY = "luma-home-background-settings";
export const HOME_BACKGROUND_EVENT = "luma-home-background-change";
const ADMIN_BACKGROUND_ACCOUNT_ID = "LUMA-000001";

export const homeBackgroundPresetLabels: Record<HomeBackgroundPreset, string> = {
  galaxy: "银河",
  planet: "星球",
  luma: "流光",
};

const defaultPresetSettings: Record<HomeBackgroundPreset, HomeBackgroundSettings> = {
  galaxy: {
    type: "shader",
    brightness: 1,
    blur: 0,
    overlay: 0.38,
    speed: 1,
  },
  planet: {
    type: "shader",
    brightness: 1.08,
    blur: 0,
    overlay: 0.32,
    speed: 0.62,
  },
  luma: {
    type: "shader",
    brightness: 1.18,
    blur: 0,
    overlay: 0.3,
    speed: 1.55,
  },
};

const defaultStore: HomeBackgroundStore = {
  currentPreset: "galaxy",
  useDefaultAnimation: true,
  defaultAnimationSettings: defaultPresetSettings.galaxy,
  presets: defaultPresetSettings,
};

const MAX_BACKGROUND_VIDEO_SIZE = 500 * 1024 * 1024;

function normalizeStore(saved: unknown): HomeBackgroundStore {
  if (!saved || typeof saved !== "object") return defaultStore;

  const maybeStore = saved as Partial<HomeBackgroundStore>;
  if (maybeStore.presets) {
    const nextCurrentPreset = maybeStore.currentPreset || "galaxy";
    const nextPresets = {
      galaxy: { ...defaultPresetSettings.galaxy, ...maybeStore.presets.galaxy },
      planet: { ...defaultPresetSettings.planet, ...maybeStore.presets.planet },
      luma: { ...defaultPresetSettings.luma, ...maybeStore.presets.luma },
    };
    const savedDefaultMode =
      typeof maybeStore.useDefaultAnimation === "boolean"
        ? maybeStore.useDefaultAnimation
        : nextPresets[nextCurrentPreset].type === "shader" && !nextPresets[nextCurrentPreset].dataUrl;

    return {
      currentPreset: nextCurrentPreset,
      useDefaultAnimation: savedDefaultMode,
      defaultAnimationSettings: {
        ...defaultPresetSettings.galaxy,
        ...maybeStore.defaultAnimationSettings,
        type: "shader",
        dataUrl: undefined,
      },
      presets: nextPresets,
    };
  }

  const oldSettings = saved as Partial<HomeBackgroundSettings>;
  return {
    currentPreset: "galaxy",
    useDefaultAnimation: false,
    defaultAnimationSettings: defaultPresetSettings.galaxy,
    presets: {
      ...defaultPresetSettings,
      galaxy: { ...defaultPresetSettings.galaxy, ...oldSettings },
    },
  };
}

function scopedBackgroundKey(accountId: string) {
  return `${HOME_BACKGROUND_KEY}:${accountId}`;
}

function persistStore(storageKey: string, store: HomeBackgroundStore) {
  window.localStorage.setItem(storageKey, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(HOME_BACKGROUND_EVENT, { detail: { storageKey, store } }));
}

export function useHomeBackgroundSettings() {
  const [store, setStore] = useState<HomeBackgroundStore>(defaultStore);
  const [isReady, setIsReady] = useState(false);
  const [storageKey, setStorageKey] = useState(scopedBackgroundKey("anonymous"));
  const [message, setMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settings = store.useDefaultAnimation ? store.defaultAnimationSettings : store.presets[store.currentPreset];

  useEffect(() => {
    let mounted = true;

    async function resolveStorageKey() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          return scopedBackgroundKey(data.user?.accountId || "anonymous");
        }
      } catch {
        // Public pages use defaults, never another account's saved media.
      }
      return scopedBackgroundKey("anonymous");
    }

    function readSavedStore(nextKey: string) {
      const saved = nextKey === scopedBackgroundKey("anonymous") ? null
        : window.localStorage.getItem(nextKey)
          || (nextKey === scopedBackgroundKey(ADMIN_BACKGROUND_ACCOUNT_ID) ? window.localStorage.getItem(HOME_BACKGROUND_KEY) : null);
      let nextStore = defaultStore;
      try {
        if (saved) nextStore = normalizeStore(JSON.parse(saved));
      } catch {
        window.localStorage.removeItem(nextKey);
      }
      queueMicrotask(() => {
        if (!mounted) return;
        setStore(nextStore);
        setIsReady(true);
      });
    }

    function onStorage(event: StorageEvent) {
      if (event.key === storageKey) readSavedStore(storageKey);
    }

    function onLocalChange(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.storageKey && detail.storageKey !== storageKey) return;
      const nextStore = normalizeStore(detail?.store ?? detail);
      setStore(nextStore);
      setIsReady(true);
    }

    void resolveStorageKey().then((nextKey) => {
      if (!mounted) return;
      setStorageKey(nextKey);
      readSavedStore(nextKey);
    });
    window.addEventListener("storage", onStorage);
    window.addEventListener(HOME_BACKGROUND_EVENT, onLocalChange);
    return () => {
      mounted = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(HOME_BACKGROUND_EVENT, onLocalChange);
    };
  }, [storageKey]);

  function updateStore(nextStore: HomeBackgroundStore, nextMessage = "") {
    setStore(nextStore);
    persistStore(storageKey, nextStore);
    setMessage(nextMessage);
  }

  function update(next: Partial<HomeBackgroundSettings>) {
    const nextStore = store.useDefaultAnimation
      ? {
          ...store,
          defaultAnimationSettings: {
            ...store.defaultAnimationSettings,
            ...next,
            type: "shader" as const,
            dataUrl: undefined,
          },
        }
      : {
          ...store,
          presets: {
            ...store.presets,
            [store.currentPreset]: { ...settings, ...next },
          },
        };
    updateStore(nextStore);
  }

  function selectPreset(preset: HomeBackgroundPreset) {
    updateStore({ ...store, currentPreset: preset, useDefaultAnimation: false });
  }

  function activateDefaultAnimation() {
    updateStore(
      {
        ...store,
        useDefaultAnimation: true,
        defaultAnimationSettings: {
          ...store.defaultAnimationSettings,
          type: "shader",
          dataUrl: undefined,
        },
      },
      "已切换为默认动效，未覆盖底部视频按钮"
    );
  }

  function restore() {
    const nextStore = store.useDefaultAnimation
      ? {
          ...store,
          defaultAnimationSettings: defaultPresetSettings.galaxy,
        }
      : {
          ...store,
          presets: {
            ...store.presets,
            [store.currentPreset]: defaultPresetSettings[store.currentPreset],
          },
        };
    updateStore(
      nextStore,
      store.useDefaultAnimation ? "已恢复默认动效参数" : `已恢复${homeBackgroundPresetLabels[store.currentPreset]}默认背景`
    );
  }

  function save() {
    persistStore(storageKey, store);
    setMessage("首页背景设置已保存");
  }

  function reportVideoPlaybackError() {
    setMessage(`${homeBackgroundPresetLabels[store.currentPreset]}本地视频无法播放，已回退为默认动效。请重新导入完整的 MP4、WebM 或 MOV 文件。`);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const isVideo = file.type.startsWith("video/");
    if (!isVideo) {
      setMessage("请导入本地视频素材");
      return;
    }
    if (file.size > MAX_BACKGROUND_VIDEO_SIZE) {
      setMessage("背景视频超过 500MB，请压缩后重新导入");
      return;
    }

    setIsUploading(true);
    setMessage("正在保存背景素材...");
    try {
      const formData = new FormData();
      // Keep this field before the media part so the server can detect a
      // truncated proxied upload instead of persisting an unplayable video.
      formData.append("expectedSize", String(file.size));
      formData.append("file", file);
      const res = await fetch("/api/home-backgrounds", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "背景素材保存失败");
      if (data.type !== "video" || typeof data.url !== "string" || !data.url) {
        throw new Error("背景素材保存后没有返回可播放地址，请重新导入");
      }

      const nextStore = {
        ...store,
        presets: {
          ...store.presets,
          [store.currentPreset]: {
            ...store.presets[store.currentPreset],
            type: "video",
            dataUrl: data.url,
          },
        },
        useDefaultAnimation: false,
      };
      updateStore(nextStore, `${homeBackgroundPresetLabels[store.currentPreset]}本地视频已保存，刷新后仍会保留`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "背景素材保存失败");
    } finally {
      setIsUploading(false);
    }
  }

  return {
    settings,
    store,
    isReady,
    currentPreset: store.currentPreset,
    isDefaultAnimation: store.useDefaultAnimation,
    message,
    isUploading,
    fileInputRef,
    update,
    selectPreset,
    activateDefaultAnimation,
    restore,
    save,
    reportVideoPlaybackError,
    handleFile,
    pickFile: () => fileInputRef.current?.click(),
  };
}

function BackgroundVideo({ src, onError }: { src: string; onError: () => void }) {
  const [isVideoReady, setIsVideoReady] = useState(false);

  return (
    <div className="relative h-full w-full bg-[#071011]">
      <video
        key={src}
        src={src}
        className={`absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-500 ${
          isVideoReady ? "opacity-100" : "opacity-0"
        }`}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        onCanPlay={() => setIsVideoReady(true)}
        onLoadedData={() => setIsVideoReady(true)}
        onError={() => {
          setIsVideoReady(false);
          onError();
        }}
      />
    </div>
  );
}

export function HomeBackground({
  settings,
  onVideoError,
}: {
  settings: HomeBackgroundSettings;
  onVideoError?: () => void;
}) {
  const [failedVideoSrc, setFailedVideoSrc] = useState("");
  const filter = `brightness(${settings.brightness}) blur(${settings.blur}px)`;
  const backgroundLayerStyle = {
    filter,
    transform: settings.blur > 0 ? "scale(1.035)" : "scale(1)",
  };
  const videoUrl = settings.type === "video" ? settings.dataUrl : undefined;

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 transition-[filter,transform] duration-200" style={backgroundLayerStyle}>
        {settings.type === "image" && settings.dataUrl ? (
          <div
            className="h-full w-full bg-cover bg-center"
            style={{ backgroundImage: `url(${settings.dataUrl})` }}
          />
        ) : videoUrl && failedVideoSrc !== videoUrl ? (
          <BackgroundVideo
            key={videoUrl}
            src={videoUrl}
            onError={() => {
              setFailedVideoSrc(videoUrl);
              onVideoError?.();
            }}
          />
        ) : (
          <LumaGalaxyBackground className="h-full w-full" speed={settings.speed} />
        )}
      </div>
      <div className="absolute inset-0 bg-[#041012]" style={{ opacity: settings.overlay }} />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(103,232,249,0.12),transparent_36%),linear-gradient(to_bottom,rgba(4,16,18,0.04),rgba(4,16,18,0.34))]" />
      <div className="absolute inset-0 opacity-[0.09] [background-image:linear-gradient(to_bottom,rgba(255,255,255,0.18)_1px,transparent_1px)] [background-size:100%_6px]" />
    </div>
  );
}

export function BackgroundSettingsPanel({
  settings,
  currentPreset,
  isDefaultAnimation,
  message,
  isUploading,
  fileInputRef,
  onClose,
  onPickFile,
  onFileChange,
  onSelectPreset,
  onUpdate,
  onUseDefaultAnimation,
  onSave,
  onRestore,
  onVideoError,
}: {
  settings: HomeBackgroundSettings;
  currentPreset: HomeBackgroundPreset;
  isDefaultAnimation: boolean;
  message: string;
  isUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onPickFile: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSelectPreset: (preset: HomeBackgroundPreset) => void;
  onUpdate: (next: Partial<HomeBackgroundSettings>) => void;
  onUseDefaultAnimation: () => void;
  onSave: () => void;
  onRestore: () => void;
  onVideoError: () => void;
}) {
  const sourceLabel = settings.type === "video"
    ? "本地视频"
    : settings.type === "image"
      ? "本地图片"
      : "默认动效";

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/18 p-3 pt-8 backdrop-blur-md sm:p-4 sm:pt-10" role="dialog" aria-modal="true" aria-label="首页背景设置">
      <div className="relative flex max-h-[min(680px,calc(100vh-48px))] w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-white/16 bg-[#071116]/38 text-slate-100 shadow-[0_30px_120px_rgba(0,0,0,0.46)] backdrop-blur-3xl">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(103,232,249,0.14),transparent_34%),radial-gradient(circle_at_86%_18%,rgba(167,139,250,0.12),transparent_38%),linear-gradient(135deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))]" />
        <div className="pointer-events-none absolute inset-px rounded-lg border border-white/[0.06]" />
        <div className="relative flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-white/[0.035] p-4 backdrop-blur-2xl">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.26em] text-cyan-100/62">Background Console</p>
            <h2 className="text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-100 via-white to-violet-200">首页背景设置</h2>
            <p className="mt-2 text-xs leading-5 text-slate-300/68">
              {isDefaultAnimation
                ? "当前正在预览系统默认动效，不会覆盖底部三个本地视频按钮。"
                : `当前正在编辑「${homeBackgroundPresetLabels[currentPreset]}」${sourceLabel}。素材会保存到本地项目目录，16:9 背景会自动铺满适配。`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-300 transition hover:border-cyan-100/28 hover:bg-cyan-200/10 hover:text-cyan-50">
            关闭
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto bg-white/[0.018] p-4 backdrop-blur-2xl [scrollbar-color:rgba(103,232,249,0.42)_rgba(255,255,255,0.06)] [scrollbar-width:thin]">
        <div className="mb-4 rounded-lg border border-white/12 bg-white/[0.04] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] backdrop-blur-3xl">
          <p className="mb-3 text-sm font-semibold text-slate-200">当前背景</p>
          <div className="relative aspect-video overflow-hidden rounded-md bg-black">
            <HomeBackground settings={settings} onVideoError={onVideoError} />
            <div className="absolute bottom-3 left-3 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-xs text-slate-100 backdrop-blur-xl">
              {settings.type === "shader" ? "默认动态背景" : settings.type === "image" ? "本地图片" : "本地视频"}
            </div>
          </div>
        </div>

        <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={onFileChange} />

        <div className="mb-4 rounded-lg border border-white/12 bg-white/[0.038] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.065)] backdrop-blur-3xl">
          <p className="mb-3 text-sm font-semibold text-slate-200">连接到底部按钮</p>
          <div className="grid grid-cols-3 gap-2">
            {(["galaxy", "planet", "luma"] satisfies HomeBackgroundPreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onSelectPreset(preset)}
                className={`rounded-full border px-3 py-2 text-sm font-semibold transition ${
                  !isDefaultAnimation && currentPreset === preset
                    ? "border-cyan-100/35 bg-cyan-200/16 text-cyan-50 shadow-[0_0_22px_rgba(34,211,238,0.16)]"
                    : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-cyan-100"
                }`}
              >
                {homeBackgroundPresetLabels[preset]}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-400/78">
            选择后再导入本地视频，视频会绑定到对应的底部按钮。默认动效只作为独立预览，不会写入这里。
          </p>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onPickFile}
            disabled={isUploading}
            className="flex items-center justify-center gap-2 rounded-lg border border-cyan-100/22 bg-cyan-200/12 px-4 py-3 text-sm font-semibold text-cyan-100 shadow-[0_0_28px_rgba(34,211,238,0.08)] transition hover:bg-cyan-200/18 disabled:cursor-wait disabled:opacity-55"
          >
            <Upload className="h-4 w-4" />
            {isUploading ? "保存中..." : "导入本地视频"}
          </button>
          <button type="button" onClick={onUseDefaultAnimation} className={`flex items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-semibold transition ${
            isDefaultAnimation
              ? "border-cyan-100/28 bg-cyan-200/12 text-cyan-50"
              : "border-white/10 bg-white/[0.055] text-slate-100 hover:bg-white/[0.1]"
          }`}>
            <ImageIcon className="h-4 w-4" />
            使用默认动效
          </button>
        </div>

        <div className="rounded-lg border border-white/12 bg-white/[0.036] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.065)] backdrop-blur-3xl">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-slate-100">视觉参数</p>
              <p className="mt-1 text-xs text-slate-400/78">调整会立即作用在当前首页背景上。</p>
            </div>
          </div>
          <div className="space-y-4">
            <RangeControl label="背景亮度" value={settings.brightness} min={0.25} max={2} step={0.05} display={(value) => `${Math.round(value * 100)}%`} onChange={(value) => onUpdate({ brightness: value })} />
            <RangeControl label="柔化模糊" value={settings.blur} min={0} max={32} step={1} display={(value) => `${Math.round(value)}px`} onChange={(value) => onUpdate({ blur: value })} />
            <RangeControl label="暗场遮罩" value={settings.overlay} min={0} max={0.92} step={0.02} display={(value) => `${Math.round(value * 100)}%`} onChange={(value) => onUpdate({ overlay: value })} />
            <RangeControl label="动效速度" value={settings.speed} min={0.1} max={3} step={0.05} display={(value) => `${value.toFixed(2)}x`} onChange={(value) => onUpdate({ speed: value })} />
          </div>
        </div>

        {message && <p className="mt-4 rounded-md border border-cyan-100/14 bg-cyan-200/8 px-3 py-2 text-xs text-cyan-100">{message}</p>}
        </div>

        <div className="relative flex shrink-0 flex-col gap-3 border-t border-white/10 bg-white/[0.04] p-4 backdrop-blur-3xl sm:flex-row sm:justify-end">
          <button type="button" onClick={onRestore} className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08]">
            <RotateCcw className="h-4 w-4" />
            恢复当前预设
          </button>
          <button type="button" onClick={onSave} className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-100/20 bg-cyan-200/90 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-[0_0_34px_rgba(34,211,238,0.14)] transition hover:bg-cyan-100">
            <Save className="h-4 w-4" />
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <div className="mb-2 flex justify-between text-sm">
        <span className="text-slate-200">{label}</span>
        <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-xs font-semibold text-cyan-100/86">{display(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{
          background: `linear-gradient(to right, rgba(103,232,249,0.85) 0%, rgba(167,139,250,0.8) ${progress}%, rgba(255,255,255,0.12) ${progress}%, rgba(255,255,255,0.12) 100%)`,
        }}
        className="h-2 w-full appearance-none rounded-full accent-cyan-200 outline-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/70 [&::-webkit-slider-thumb]:bg-cyan-100 [&::-webkit-slider-thumb]:shadow-[0_0_20px_rgba(103,232,249,0.55)]"
      />
    </label>
  );
}
