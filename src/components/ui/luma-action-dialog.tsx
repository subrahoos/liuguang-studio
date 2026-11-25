"use client";

import { useState, type ReactNode } from "react";
import { LuCheck, LuCircleAlert, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type LumaConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  confirmDisabled?: boolean;
  tone?: "danger" | "default";
};

export function LumaConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  confirmDisabled = false,
  tone = "danger",
}: LumaConfirmDialogProps) {
  const isDanger = tone === "danger";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(32rem,calc(100%-2rem))] gap-0 overflow-hidden border border-cyan-100/20 !bg-[#08171d]/95 p-0 text-slate-100 shadow-[0_28px_100px_rgba(0,0,0,0.52)] backdrop-blur-2xl sm:max-w-[520px]"
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-cyan-100/12 px-5 py-4 sm:px-6">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${isDanger ? "border-red-300/25 bg-red-400/10 text-red-200" : "border-cyan-300/25 bg-cyan-300/10 text-cyan-100"}`}>
            <LuCircleAlert className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold tracking-[0.01em] text-white">{title}</DialogTitle>
            <DialogDescription className="mt-1 leading-5 text-slate-300/75">{description}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="border-cyan-100/10 !bg-black/15 px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" className="border-cyan-100/20 bg-white/[0.04] text-slate-100 hover:bg-white/[0.1] hover:text-white" onClick={() => onOpenChange(false)} disabled={pending}>
            <LuX className="mr-1.5 h-4 w-4" />
            取消
          </Button>
          <Button type="button" variant={isDanger ? "destructive" : "default"} onClick={onConfirm} disabled={pending || confirmDisabled}>
            <LuCheck className="mr-1.5 h-4 w-4" />
            {pending ? "处理中…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type LumaPromptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  label: string;
  defaultValue: string;
  placeholder?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  pending?: boolean;
};

export function LumaPromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  defaultValue,
  placeholder,
  confirmLabel,
  onConfirm,
  pending = false,
}: LumaPromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  function submit() {
    const cleanValue = value.trim();
    if (!cleanValue || pending) return;
    onConfirm(cleanValue);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(32rem,calc(100%-2rem))] gap-0 overflow-hidden border border-cyan-100/20 !bg-[#08171d]/95 p-0 text-slate-100 shadow-[0_28px_100px_rgba(0,0,0,0.52)] backdrop-blur-2xl sm:max-w-[520px]"
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-cyan-100/12 px-5 py-4 sm:px-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-100">
            <LuCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold tracking-[0.01em] text-white">{title}</DialogTitle>
            <DialogDescription className="mt-1 leading-5 text-slate-300/75">{description}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="space-y-2 px-5 py-5 sm:px-6">
          <label htmlFor="luma-prompt-value" className="text-xs font-medium text-slate-200">{label}</label>
          <Input
            id="luma-prompt-value"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            autoFocus
            className="border-cyan-100/15 bg-black/20 text-slate-100 placeholder:text-slate-400/70"
          />
        </div>
        <DialogFooter className="border-cyan-100/10 !bg-black/15 px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" className="border-cyan-100/20 bg-white/[0.04] text-slate-100 hover:bg-white/[0.1] hover:text-white" onClick={() => onOpenChange(false)} disabled={pending}>
            <LuX className="mr-1.5 h-4 w-4" />
            取消
          </Button>
          <Button type="button" onClick={submit} disabled={pending || !value.trim()}>
            <LuCheck className="mr-1.5 h-4 w-4" />
            {pending ? "保存中…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
