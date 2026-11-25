export function normalizeComparableText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[，。；：、,.!?:;'"“”‘’`]+/g, "")
    .trim()
    .toLowerCase();
}

export function uniqueTextSections(values: Array<string | null | undefined | false>, minContainmentChars = 120) {
  const result: string[] = [];
  const normalizedResult: string[] = [];

  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) continue;
    const normalized = normalizeComparableText(text);
    if (!normalized) continue;

    const isDuplicate = normalizedResult.some((existing) => {
      if (existing === normalized) return true;
      if (normalized.length >= minContainmentChars && existing.includes(normalized)) return true;
      if (existing.length >= minContainmentChars && normalized.includes(existing)) return true;
      return false;
    });
    if (isDuplicate) continue;

    result.push(text);
    normalizedResult.push(normalized);
  }

  return result;
}

export function joinUniqueTextSections(values: Array<string | null | undefined | false>, separator = "\n\n") {
  return uniqueTextSections(values).join(separator);
}

export function uniqueStrings<T extends string | undefined | null>(values: T[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function compactPromptExcerpt(value: string, maxChars = 2400) {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const headLength = Math.floor(maxChars * 0.62);
  const tailLength = Math.max(400, maxChars - headLength - 120);
  return [
    text.slice(0, headLength).trim(),
    "[...middle of full director prompt omitted for this segment request...]",
    text.slice(-tailLength).trim(),
  ].join("\n\n");
}
