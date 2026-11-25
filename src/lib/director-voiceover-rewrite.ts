import type { TimestampedVoiceoverPhrase } from "@/lib/voiceover-task-allocation";

export type DirectorVoiceoverMode = "none" | "rewrite_reference" | "use_exact";

type ReturnedVoiceoverPhrase = {
  phraseIndex?: unknown;
  sourceTimeRange?: unknown;
  spokenLine?: unknown;
};

function compact(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function comparable(value: unknown) {
  return compact(value).replace(/[，。！？、；：“”‘’,.!?;:'"()[\]{}]/g, "");
}

function spokenCharacterCount(value: unknown) {
  return comparable(value).length;
}

export function directorVoiceoverCharacterLimit(source: TimestampedVoiceoverPhrase) {
  const sourceCharacters = spokenCharacterCount(source.text);
  const durationSeconds = Math.max(0, source.sourceEnd - source.sourceStart);
  // The source ASR boundary is approximate and often cuts tightly around the
  // last syllable. Keep a generous validation ceiling while the prompt still
  // asks the model to stay close to the original spoken length.
  return Math.max(sourceCharacters + 6, Math.ceil(durationSeconds * 9));
}

export function validateDirectorVoiceoverRewrite(
  fullTextValue: unknown,
  returnedValue: unknown,
  sourcePhrases: TimestampedVoiceoverPhrase[],
  mode: DirectorVoiceoverMode,
) {
  const returned = Array.isArray(returnedValue) ? returnedValue as ReturnedVoiceoverPhrase[] : [];
  if (returned.length !== sourcePhrases.length) {
    throw new Error(`完整导演稿返回了 ${returned.length} 句中文口播，但当前口播时间槽严格需要 ${sourcePhrases.length} 句。`);
  }
  if (sourcePhrases.length === 0) {
    if (compact(fullTextValue) || returned.length > 0) {
      throw new Error("当前没有参考口播，完整导演稿不得自行添加台词。");
    }
    return { fullText: "", phrases: [] as TimestampedVoiceoverPhrase[] };
  }

  const phrases = sourcePhrases.map((source, offset) => {
    // The returned array order is the only model-owned ordering. The server
    // attaches the index and time slot, so a model typo cannot remap speech.
    const item = returned[offset];
    const spokenLine = compact(item?.spokenLine);
    if (!spokenLine || !/[\u3400-\u9fff]/.test(spokenLine)) {
      throw new Error(`完整导演稿的中文口播第 ${offset + 1} 句为空或不是中文。`);
    }
    if (item?.phraseIndex !== undefined && Number(item.phraseIndex) !== offset + 1) {
      throw new Error(`完整导演稿的中文口播第 ${offset + 1} 句改变了服务端句序。`);
    }
    if (item?.sourceTimeRange !== undefined && compact(item.sourceTimeRange) !== source.sourceTimeRange) {
      throw new Error(`完整导演稿的中文口播第 ${offset + 1} 句改变了服务端口播时间槽。`);
    }
    if (mode === "use_exact" && comparable(spokenLine) !== comparable(source.text)) {
      throw new Error(`完整导演稿没有原样保留用户提供的第 ${offset + 1} 句中文口播。`);
    }
    if (mode === "rewrite_reference") {
      if (comparable(spokenLine) === comparable(source.text)) {
        throw new Error(`完整导演稿的第 ${offset + 1} 句仍与参考口播相同，未完成仿写。`);
      }
      const maxCharacters = directorVoiceoverCharacterLimit(source);
      if (spokenCharacterCount(spokenLine) > maxCharacters) {
        throw new Error(`完整导演稿仿写的第 ${offset + 1} 句超过当前时间槽允许的 ${maxCharacters} 个口播字。`);
      }
    }
    return { ...source, text: spokenLine };
  });

  const returnedFullText = compact(fullTextValue);
  if (returnedFullText && comparable(returnedFullText) !== comparable(phrases.map((phrase) => phrase.text).join(""))) {
    throw new Error("完整导演稿的中文口播全文与分句结果不一致。");
  }
  const fullText = returnedFullText || `${phrases.map((phrase) => phrase.text.replace(/[。！？]+$/g, "")).join("。")}${phrases.length ? "。" : ""}`;
  return { fullText, phrases };
}
