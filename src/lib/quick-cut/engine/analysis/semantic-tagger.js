const KEYWORDS = new Map([
  ["hook", ["别再", "千万别", "是不是", "容易破", "烦不烦", "痛点"]],
  ["size", ["加大", "容量", "大号", "超大", "垃圾桶", "能装"]],
  [
    "thickness",
    ["加厚", "厚实", "韧性", "拉扯", "拉伸", "不容易破", "结实"],
  ],
  [
    "leakproof",
    ["防漏", "漏水", "不漏", "污水", "渗漏", "汤水", "装汤", "厨余"],
  ],
  ["handle", ["手提", "马甲", "打结", "一拎就走", "不勒手", "提手"]],
  ["scent", ["艾草", "清香", "异味", "香味"]],
  ["insect", ["小飞虫", "驱虫", "蚊虫"]],
  [
    "usage",
    ["套垃圾桶", "装垃圾", "厨房", "客厅", "卧室", "卫生间"],
  ],
  ["packaging", ["包装", "抽取", "卷装", "数量", "一卷", "一包"]],
  ["cta", ["囤", "链接", "下单", "带回家", "赶紧拍", "购物车"]],
]);

function tagText(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const tags = [];
  for (const [tag, words] of KEYWORDS) {
    if (words.some((word) => normalized.includes(word))) tags.push(tag);
  }
  if (tags.length) {
    return { tags, confidence: 1 };
  }
  return { tags: ["generic-product"], confidence: 0.25 };
}

function textForRange(transcript, start, end) {
  return (transcript || [])
    .filter((segment) =>
      Number(segment.end) > start && Number(segment.start) < end)
    .map((segment) => String(segment.text || "").trim())
    .filter(Boolean)
    .join(" ");
}

function tagShot(shot, transcript) {
  const transcriptText = textForRange(
    transcript,
    Number(shot.start),
    Number(shot.end),
  );
  const tagged = tagText(transcriptText);
  return {
    ...shot,
    transcriptText,
    semanticTags: tagged.tags,
    semanticConfidence: tagged.confidence,
  };
}

module.exports = {
  KEYWORDS,
  tagShot,
  tagText,
  textForRange,
};
