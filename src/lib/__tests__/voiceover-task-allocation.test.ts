import { describe, expect, it } from "vitest";
import { splitTargetDurationIntoVideoSegments } from "@/lib/video-shot-segments";
import {
  allocateVoiceoverPhrases,
  parseTimestampedVoiceoverPhrases,
  voiceoverAllocationPrompt,
} from "@/lib/voiceover-task-allocation";

describe("voiceover task allocation", () => {
  it("accepts both MM:SS and HH:MM:SS timecodes", () => {
    const phrases = parseTimestampedVoiceoverPhrases([
      "[00:00-00:03] 第一段",
      "[00:00:03.000-00:00:04.500] 第二段",
    ].join("\n"));
    expect(phrases.map((phrase) => [phrase.sourceStart, phrase.sourceEnd])).toEqual([
      [0, 3],
      [3, 4.5],
    ]);
  });

  it("keeps a boundary-crossing line whole and moves the next overflow line forward", () => {
    const phrases = parseTimestampedVoiceoverPhrases([
      "[00:00:00.000-00:00:01.400] 第一段",
      "[00:00:01.400-00:00:03.600] 第二段",
      "[00:00:03.600-00:00:05.300] 第三段",
      "[00:00:05.300-00:00:06.500] 第四段",
      "[00:00:06.500-00:00:07.500] 第五段",
      "[00:00:07.500-00:00:09.100] 第六段",
      "[00:00:09.100-00:00:10.700] 第七段",
      "[00:00:10.700-00:00:11.800] 第八段",
      "[00:00:11.800-00:00:12.800] 第九段",
      "[00:00:12.800-00:00:13.800] 第十段",
      "[00:00:13.800-00:00:14.400] 第十一段",
    ].join("\n"));
    const allocation = allocateVoiceoverPhrases(splitTargetDurationIntoVideoSegments(15, 6), phrases);

    expect(allocation.map((task) => task.phrases.map((phrase) => phrase.text))).toEqual([
      ["第一段", "第二段", "第三段"],
      ["第四段", "第五段", "第六段", "第七段"],
      ["第八段", "第九段", "第十段", "第十一段"],
    ]);
    expect(allocation.map((task) => task.allocatedDuration)).toEqual([5.3, 5.4, 3.7]);
    expect(voiceoverAllocationPrompt(allocation)).toContain("Task 2, local 0.0-6.0s:");
    expect(voiceoverAllocationPrompt(allocation)).toContain("keep 0.6s for natural breath");
  });
});
