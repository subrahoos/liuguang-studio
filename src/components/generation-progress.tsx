"use client";

import { useEffect, useMemo, useState } from "react";
import { LuClock, LuLoaderCircle } from "react-icons/lu";
import { cn } from "@/lib/utils";

export interface EstimatedProgress {
  percentage: number;
  elapsedSeconds: number;
  etaSeconds: number;
  stage: string;
}

interface UseEstimatedProgressOptions {
  active: boolean;
  expectedSeconds: number;
  stages: string[];
  floor?: number;
  ceiling?: number;
}

interface GenerationProgressProps {
  title: string;
  active?: boolean;
  percentage: number;
  elapsedSeconds?: number;
  etaSeconds?: number;
  stage?: string;
  detail?: string;
  className?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function formatDuration(seconds = 0) {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function useEstimatedProgress({
  active,
  expectedSeconds,
  stages,
  floor = 8,
  ceiling = 94,
}: UseEstimatedProgressOptions): EstimatedProgress {
  const [timing, setTiming] = useState<{ startedAt: number | null; now: number }>({
    startedAt: null,
    now: 0,
  });

  useEffect(() => {
    if (!active) {
      const resetTimer = window.setTimeout(() => setTiming({ startedAt: null, now: 0 }), 0);
      return () => window.clearTimeout(resetTimer);
    }

    let startedAt = 0;
    const startTimer = window.setTimeout(() => {
      startedAt = Date.now();
      setTiming({ startedAt, now: startedAt });
    }, 0);

    const timer = window.setInterval(() => {
      const current = Date.now();
      setTiming((previous) => ({
        startedAt: previous.startedAt ?? (startedAt || current),
        now: current,
      }));
    }, 1000);

    return () => {
      window.clearTimeout(startTimer);
      window.clearInterval(timer);
    };
  }, [active]);

  return useMemo(() => {
    if (!active || !timing.startedAt) {
      return {
        percentage: 0,
        elapsedSeconds: 0,
        etaSeconds: expectedSeconds,
        stage: stages[0] ?? "Waiting",
      };
    }

    const elapsedSeconds = Math.max(0, Math.floor((timing.now - timing.startedAt) / 1000));
    const ratio = 1 - Math.exp(-elapsedSeconds / Math.max(1, expectedSeconds * 0.55));
    const percentage = clamp(Math.round(floor + ratio * (ceiling - floor)), floor, ceiling);
    const stageIndex = clamp(
      Math.floor((percentage / 100) * Math.max(1, stages.length)),
      0,
      Math.max(0, stages.length - 1)
    );
    const etaSeconds = Math.max(5, expectedSeconds - elapsedSeconds);

    return {
      percentage,
      elapsedSeconds,
      etaSeconds,
      stage: stages[stageIndex] ?? stages[stages.length - 1] ?? "Processing",
    };
  }, [active, ceiling, expectedSeconds, floor, stages, timing]);
}

export function GenerationProgress({
  title,
  active = true,
  percentage,
  elapsedSeconds = 0,
  etaSeconds = 0,
  stage,
  detail,
  className,
}: GenerationProgressProps) {
  const safePercentage = clamp(Math.round(percentage), 0, 100);

  return (
    <div className={cn("rounded-xl border border-primary/20 bg-primary/5 p-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {active && <LuLoaderCircle className="h-4 w-4 animate-spin text-primary" />}
            <p className="text-sm font-medium">{title}</p>
          </div>
          {stage && <p className="mt-1 text-xs text-muted-foreground">{stage}</p>}
          {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-primary">{safePercentage}%</p>
          <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
            <LuClock className="h-3 w-3" />
            {etaSeconds > 0 ? `预计剩余 ${formatDuration(etaSeconds)}` : "即将完成"}
          </p>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full rounded-full brand-gradient transition-all duration-700"
          style={{ width: `${safePercentage}%` }}
        />
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Elapsed {formatDuration(elapsedSeconds)}. Stages come from real backend/request events; ETA is estimated when the provider does not expose internal percentage.
      </p>
    </div>
  );
}
