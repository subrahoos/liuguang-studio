import { describe, expect, it } from "vitest";
import { validateDirectorVoiceoverRewrite } from "@/lib/director-voiceover-rewrite";
import { parseTimestampedVoiceoverPhrases } from "@/lib/voiceover-task-allocation";

const source = parseTimestampedVoiceoverPhrases([
  "[00:00:00.000-00:00:01.400] 你看这个拼接下摆",
  "[00:00:01.400-00:00:03.600] 侧面完全遮肚遮胯",
].join("\n"));

describe("director Mandarin voiceover rewrite", () => {
  it("accepts a one-for-one Mandarin rewrite that keeps server time slots", () => {
    const result = validateDirectorVoiceoverRewrite(
      "先看整体下摆，侧面利落显精神。",
      [
        { phraseIndex: 1, sourceTimeRange: source[0].sourceTimeRange, spokenLine: "先看整体下摆" },
        { phraseIndex: 2, sourceTimeRange: source[1].sourceTimeRange, spokenLine: "侧面利落显精神" },
      ],
      source,
      "rewrite_reference",
    );

    expect(result.phrases.map((phrase) => phrase.text)).toEqual(["先看整体下摆", "侧面利落显精神"]);
  });

  it("attaches phrase indices and time slots on the server when the model returns only ordered lines", () => {
    const result = validateDirectorVoiceoverRewrite(
      undefined,
      [
        { spokenLine: "先看整体下摆" },
        { spokenLine: "侧面利落显精神" },
      ],
      source,
      "rewrite_reference",
    );

    expect(result.phrases.map((phrase) => phrase.sourceTimeRange)).toEqual(source.map((phrase) => phrase.sourceTimeRange));
    expect(result.fullText).toBe("先看整体下摆。侧面利落显精神。");
  });

  it("rejects a rewrite that changes a time slot", () => {
    expect(() => validateDirectorVoiceoverRewrite(
      "先看整体下摆，侧面利落显精神。",
      [
        { phraseIndex: 1, sourceTimeRange: "00:00:00.000-00:00:02.000", spokenLine: "先看整体下摆" },
        { phraseIndex: 2, sourceTimeRange: source[1].sourceTimeRange, spokenLine: "侧面利落显精神" },
      ],
      source,
      "rewrite_reference",
    )).toThrow("改变了服务端口播时间槽");
  });

  it("rejects unchanged reference wording in rewrite mode", () => {
    expect(() => validateDirectorVoiceoverRewrite(
      source.map((phrase) => phrase.text).join(""),
      source.map((phrase, index) => ({
        phraseIndex: index + 1,
        sourceTimeRange: phrase.sourceTimeRange,
        spokenLine: phrase.text,
      })),
      source,
      "rewrite_reference",
    )).toThrow("未完成仿写");
  });

  it("allows a natural rewrite several characters longer than a tightly bounded ASR phrase", () => {
    const shortSource = parseTimestampedVoiceoverPhrases(
      "[00:00:13.800-00:00:15.000] 夏天穿完全不闷热",
    );
    expect(() => validateDirectorVoiceoverRewrite(
      "天气热的时候穿着也清爽不闷",
      [{
        phraseIndex: 1,
        sourceTimeRange: shortSource[0].sourceTimeRange,
        spokenLine: "天气热的时候穿着也清爽不闷",
      }],
      shortSource,
      "rewrite_reference",
    )).not.toThrow();
  });

  it("requires exact wording for a user-provided current-product voiceover", () => {
    expect(() => validateDirectorVoiceoverRewrite(
      "改写台词，侧面完全遮肚遮胯。",
      [
        { phraseIndex: 1, sourceTimeRange: source[0].sourceTimeRange, spokenLine: "改写台词" },
        { phraseIndex: 2, sourceTimeRange: source[1].sourceTimeRange, spokenLine: source[1].text },
      ],
      source,
      "use_exact",
    )).toThrow("原样保留");
  });
});
