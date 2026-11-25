const SHORTAGES = {
  "action:leakproof": "防漏或装水动作画面",
  "action:thickness": "加厚、拉扯或承重画面",
  "action:size": "展开、容量或套桶画面",
  "action:handle": "提手、提拉或打结画面",
  "action:scent": "艾草、香味或对应产品细节",
  "action:insect": "艾草、驱虫说明或对应包装细节",
  "action:packaging": "包装或数量展示画面",
  cta: "包装、数量或产品陈列画面",
  "general-product": "通用产品展示画面",
};

function compatibleIntent(target, candidate) {
  const targetIntent = String(target || "");
  const candidateIntent = String(candidate || "");
  if (targetIntent.startsWith("action:")) {
    return targetIntent === candidateIntent;
  }
  if (targetIntent === "general-product") {
    return candidateIntent === "general-product";
  }
  if (targetIntent === "cta") {
    return candidateIntent === "packaging-display"
      || candidateIntent === "general-product"
      || candidateIntent === "action:packaging";
  }
  return false;
}

function shortageLabel(intent) {
  return SHORTAGES[intent] || SHORTAGES["general-product"];
}

module.exports = {
  compatibleIntent,
  shortageLabel,
};
