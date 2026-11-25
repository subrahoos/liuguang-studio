export type OmniDuration = 4 | 6 | 8 | 10;
export type GrokDuration = 6 | 10;
export type SegmentedVideoDuration = OmniDuration | GrokDuration;

const OMNI_ALLOWED_DURATIONS = [10, 8, 6, 4] as const;
const GROK_ALLOWED_DURATIONS = [10, 6] as const;

export function isOmniVideoModel(model?: string | null) {
  return /omni/i.test(model ?? "");
}

export function isGrokVideoModel(model?: string | null) {
  return /grok.*video|grok-imagine/i.test(model ?? "");
}

export function isSegmentedVideoModel(model?: string | null) {
  return isOmniVideoModel(model) || isGrokVideoModel(model);
}

export function splitOmniDurations(targetDuration: number): OmniDuration[] {
  const target = Math.max(4, Math.ceil(targetDuration || 10));
  if (target <= 4) return [4];
  if (target <= 6) return [6];
  if (target <= 8) return [8];
  if (target <= 10) return [10];
  return splitPreferredDurations(target, OMNI_ALLOWED_DURATIONS);
}

export function splitGrokDurations(targetDuration: number): GrokDuration[] {
  const target = Math.max(6, Math.ceil(targetDuration || 10));
  if (target <= 6) return [6];
  if (target <= 10) return [10];
  return splitPreferredDurations(target, GROK_ALLOWED_DURATIONS);
}

export function splitSegmentedVideoDurations(model: string | null | undefined, targetDuration: number): SegmentedVideoDuration[] {
  return isGrokVideoModel(model) ? splitGrokDurations(targetDuration) : splitOmniDurations(targetDuration);
}

export function sumOmniDurations(durations: SegmentedVideoDuration[]) {
  return durations.reduce((sum, duration) => sum + duration, 0);
}

export function formatOmniDurationPlan(durations: SegmentedVideoDuration[]) {
  return durations.join("+");
}

function splitPreferredDurations<T extends SegmentedVideoDuration>(target: number, allowed: readonly T[]): T[] {
  const maxDuration = Math.max(...allowed);
  let best: T[] | null = null;
  const bestByTotal = new Map<number, T[]>();

  function visit(total: number, parts: T[]) {
    if (total >= target) {
      if (!best || compareDurationPlans(parts, best, target) < 0) {
        best = parts;
      }
      return;
    }
    if (total > target + maxDuration) return;
    const existing = bestByTotal.get(total);
    if (existing && compareDurationPlans(existing, parts, target) <= 0) return;
    bestByTotal.set(total, parts);

    for (const duration of allowed) {
      visit(total + duration, [...parts, duration]);
    }
  }

  visit(0, []);
  return best ?? Array(Math.ceil(target / maxDuration)).fill(maxDuration);
}

function compareDurationPlans<T extends SegmentedVideoDuration>(a: T[], b: T[], target: number) {
  const sumA = a.reduce((sum, duration) => sum + duration, 0);
  const sumB = b.reduce((sum, duration) => sum + duration, 0);
  const overageA = sumA - target;
  const overageB = sumB - target;
  if (overageA !== overageB) return overageA - overageB;
  if (a.length !== b.length) return a.length - b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
