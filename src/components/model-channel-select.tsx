"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type ModelChannelOption = {
  id: string;
  label: string;
  detail?: string;
  imageUrl?: string;
};

export type LumaSelectOption = {
  value: string;
  label: string;
  detail?: string;
  imageUrl?: string;
};

export function LumaSelect({
  id,
  value,
  options,
  emptyLabel,
  ariaLabel,
  onChange,
  className,
  layout = "compact",
  disabled = false,
}: {
  id?: string;
  value: string;
  options: LumaSelectOption[];
  emptyLabel: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  className?: string;
  layout?: "compact" | "asset";
  disabled?: boolean;
}) {
  return (
    <ModelChannelSelect
      id={id}
      value={value}
      options={options.map((option) => ({
        id: option.value,
        label: option.label,
        detail: option.detail,
        imageUrl: option.imageUrl,
      }))}
      emptyLabel={emptyLabel}
      ariaLabel={ariaLabel}
      onChange={onChange}
      className={className}
      layout={layout}
      disabled={disabled}
    />
  );
}

export function ModelChannelSelect({
  id,
  value,
  options,
  emptyLabel,
  ariaLabel,
  onChange,
  className,
  layout = "compact",
  disabled = false,
}: {
  id?: string;
  value: string;
  options: ModelChannelOption[];
  emptyLabel: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  className?: string;
  layout?: "compact" | "asset";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const selected = options.find((option) => option.id === value) ?? null;
  const displayLabel = selected?.label ?? (options.length ? `请选择${ariaLabel}` : emptyLabel);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const availableBelow = window.innerHeight - rect.bottom;
      const availableAbove = rect.top;
      const openUpward = availableBelow < 190 && availableAbove > availableBelow;
      const menuWidth = layout === "asset"
        ? Math.min(Math.max(rect.width, 400), window.innerWidth - 24)
        : rect.width;
      const menuLeft = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - menuWidth - 12));
      setMenuPosition(openUpward
        ? { left: menuLeft, width: menuWidth, bottom: window.innerHeight - rect.top + 6 }
        : { left: menuLeft, width: menuWidth, top: rect.bottom + 6 });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [layout, open]);

  return (
    <div ref={rootRef} className={cn("relative min-w-0 w-full", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        data-border-glow
        disabled={disabled || !options.length}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title={selected?.label}
        className={cn(
          "inline-flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-cyan-100/30 bg-[#07151e]/[0.18] px-3 text-left text-sm font-semibold text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_10px_28px_rgba(0,0,0,0.14)] backdrop-blur-[18px] transition hover:border-cyan-200/55 hover:bg-cyan-200/[0.10] focus:outline-none focus:ring-2 focus:ring-cyan-200/25 disabled:cursor-not-allowed disabled:opacity-55",
          layout === "asset" ? "min-h-14 py-2" : "h-10",
        )}
      >
        {layout === "asset" && selected?.imageUrl ? (
          <span
            aria-hidden="true"
            className="h-10 w-10 shrink-0 rounded-md border border-cyan-100/20 bg-slate-900 bg-cover bg-center"
            style={{ backgroundImage: `url(${JSON.stringify(selected.imageUrl)})` }}
          />
        ) : null}
        <span className={cn("min-w-0 flex-1", layout === "asset" ? "whitespace-normal break-words leading-5" : "truncate")}>
          <span className="block">{displayLabel}</span>
          {layout === "asset" && selected?.detail ? <span className="mt-0.5 block text-[11px] font-normal text-slate-400">{selected.detail}</span> : null}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-cyan-100/72 transition", open && "rotate-180")} />
      </button>

      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          style={menuPosition}
          className="luma-select-menu fixed z-[100] max-h-60 overflow-y-auto rounded-lg border border-cyan-100/28 bg-[#061019]/[0.42] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_22px_70px_rgba(0,0,0,0.25),0_0_28px_rgba(34,211,238,0.10)] backdrop-blur-[22px]"
        >
          {options.map((option) => {
            const active = option.id === selected?.id;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                title={option.label}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition",
                  active
                    ? "bg-cyan-300/[0.14] text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
                    : "text-slate-200/90 hover:bg-white/[0.10] hover:text-slate-50"
                )}
              >
                {layout === "asset" && option.imageUrl ? (
                  <span
                    aria-hidden="true"
                    className="h-12 w-12 shrink-0 rounded-md border border-cyan-100/20 bg-slate-900 bg-cover bg-center"
                    style={{ backgroundImage: `url(${JSON.stringify(option.imageUrl)})` }}
                  />
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className={cn("block font-semibold", layout === "asset" ? "whitespace-normal break-words leading-5" : "truncate")}>{option.label}</span>
                  {option.detail && <span className={cn("mt-0.5 block text-[11px] text-slate-500", layout === "asset" ? "whitespace-normal break-words leading-4" : "truncate")}>{option.detail}</span>}
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-cyan-100" />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}
