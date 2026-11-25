import type { VideoShotSegmentPlan } from "@/lib/video-shot-segments";

export type TimestampedVoiceoverPhrase = {
  sourceStart: number;
  sourceEnd: number;
  sourceTimeRange: string;
  text: string;
};

export type AllocatedVoiceoverPhrase = TimestampedVoiceoverPhrase & {
  localStart: number;
  localEnd: number;
};

export type VoiceoverTaskAllocation = {
  segmentIndex: number;
  outputDuration: number;
  phrases: AllocatedVoiceoverPhrase[];
  allocatedDuration: number;
  pauseDuration: number;
};

function secondsFromTimecode(value: string) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function roundedSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function localRange(start: number, end: number) {
  return `${start.toFixed(1)}-${end.toFixed(1)}s`;
}

/** Parse local transcription lines such as `[00:00:01.400-00:00:03.600] text`. */
export function parseTimestampedVoiceoverPhrases(sourceText: string) {
  const phrases: TimestampedVoiceoverPhrase[] = [];
  const pattern = /^\[([^\]-]+)-([^\]]+)\]\s*(.+)$/gm;
  for (const match of sourceText.matchAll(pattern)) {
    const sourceStart = secondsFromTimecode(match[1]);
    const sourceEnd = secondsFromTimecode(match[2]);
    const text = match[3].trim();
    if (sourceStart === null || sourceEnd === null || sourceEnd <= sourceStart || !text) continue;
    phrases.push({
      sourceStart,
      sourceEnd,
      sourceTimeRange: `${match[1]}-${match[2]}`,
      text,
    });
  }
  return phrases;
}

/**
 * Keep each spoken line whole. A line that no longer fits at a natural source
 * pace moves as a carry to the next delivered task instead of speeding up or
 * being cut mid-sentence.
 */
export function allocateVoiceoverPhrases(
  segments: VideoShotSegmentPlan[],
  phrases: TimestampedVoiceoverPhrase[],
) {
  const allocations: VoiceoverTaskAllocation[] = segments.map((segment) => ({
    segmentIndex: segment.index,
    outputDuration: segment.outputDuration,
    phrases: [],
    allocatedDuration: 0,
    pauseDuration: segment.outputDuration,
  }));
  let allocationIndex = 0;

  for (const phrase of phrases) {
    const duration = roundedSeconds(phrase.sourceEnd - phrase.sourceStart);
    while (
      allocationIndex < allocations.length
      && allocations[allocationIndex].phrases.length > 0
      && allocations[allocationIndex].allocatedDuration + duration > allocations[allocationIndex].outputDuration + 0.001
    ) {
      allocationIndex += 1;
    }
    const allocation = allocations[allocationIndex];
    if (!allocation) {
      throw new Error("成片任务时长不足以容纳完整口播句子；请增加目标时长或选择更长的单任务时长。");
    }
    if (duration > allocation.outputDuration + 0.001) {
      throw new Error(`口播句子“${phrase.text}”超过单任务可用时长，不能在不截断的前提下分配。`);
    }
    const localStart = allocation.allocatedDuration;
    const localEnd = roundedSeconds(localStart + duration);
    allocation.phrases.push({ ...phrase, localStart, localEnd });
    allocation.allocatedDuration = localEnd;
    allocation.pauseDuration = Math.max(0, roundedSeconds(allocation.outputDuration - localEnd));
  }
  return allocations;
}

export function voiceoverAllocationPrompt(allocations: VoiceoverTaskAllocation[]) {
  if (allocations.every((allocation) => allocation.phrases.length === 0)) return "No timestamped spoken lines are available.";
  return allocations.map((allocation) => [
    `Task ${allocation.segmentIndex}, local 0.0-${allocation.outputDuration.toFixed(1)}s:`,
    ...allocation.phrases.map((phrase) =>
      `- local ${localRange(phrase.localStart, phrase.localEnd)}; source ${phrase.sourceTimeRange}; speak exactly “${phrase.text}”`,
    ),
    allocation.pauseDuration > 0.05
      ? `- keep ${allocation.pauseDuration.toFixed(1)}s for natural breath, visible action, or nonverbal continuation; do not add words.`
      : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}
