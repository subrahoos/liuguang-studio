const ACTIONS = [
  ["leakproof", [
    "不漏",
    "不会漏",
    "防漏",
    "汤水",
    "污水",
    "渗漏",
    "不渗",
    "漏水",
    "漏汤",
    "不会露",
    "热水",
  ]],
  ["thickness", ["加厚", "厚实", "拉扯", "承重", "不容易破", "结实"]],
  ["size", ["加大", "大号", "容量", "能装", "套垃圾桶"]],
  ["handle", ["手提", "马甲", "提手", "打结"]],
  ["scent", [
    "艾草",
    "爱草",
    "清香",
    "香味",
    "异味",
    "味道",
    "香薰",
    "香熏",
  ]],
  ["insect", ["驱虫", "小飞虫", "蚊虫"]],
  ["packaging", ["包装", "一包", "一卷", "数量"]],
];
const CTA_WORDS = ["下单", "链接", "囤", "带回家", "购物车", "赶紧"];

function classifyClause(text) {
  const value = String(text || "").replace(/\s+/g, "");
  for (const [name, words] of ACTIONS) {
    if (words.some((word) => value.includes(word))) {
      return { intent: `action:${name}`, confidence: 1 };
    }
  }
  if (CTA_WORDS.some((word) => value.includes(word))) {
    return { intent: "cta", confidence: 1 };
  }
  return {
    intent: value ? "general-product" : "person-expression",
    confidence: value ? 0.7 : 0,
  };
}

function splitTranscriptClauses(transcript) {
  return (transcript || []).flatMap((segment) => {
    const parts = String(segment.text || "")
      .split(/[，。；！？,.!?;\s]+/)
      .map((text) => text.trim())
      .filter(Boolean);
    const start = Number(segment.start) || 0;
    const duration = Math.max(0, Number(segment.end) - start);
    return parts.map((text, index) => ({
      start: Number((start + duration * index / parts.length).toFixed(3)),
      end: Number((start + duration * (index + 1) / parts.length).toFixed(3)),
      text,
      ...classifyClause(text),
    }));
  });
}

module.exports = {
  ACTIONS,
  classifyClause,
  splitTranscriptClauses,
};
