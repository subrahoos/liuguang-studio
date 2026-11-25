const path = require("node:path");

function normalizedUnit(unit) {
  return [
    String(unit.sourceId || "").toLowerCase(),
    String(unit.shotId || unit.segmentId || "").toLowerCase(),
    path.resolve(String(unit.videoPath || "")).toLowerCase(),
    Number(unit.videoStart || 0).toFixed(3),
    Number(unit.duration || 0).toFixed(3),
    String(unit.role || ""),
    String(unit.audioPath || "").toLowerCase(),
    Number(unit.audioStart || 0).toFixed(3),
  ].join("|");
}

function contentSignature(plan) {
  return (plan.units || []).map(normalizedUnit).join(">");
}

function planSignature(plan) {
  return `${contentSignature(plan)}#visual=${Number(plan.visualVariant) || 0}`;
}

function richnessLevel({ uniqueContent, requested }) {
  const ratio = requested > 0 ? uniqueContent / requested : 0;
  if (ratio >= 3) return "high";
  if (ratio >= 1.5) return "medium";
  return "low";
}

module.exports = {
  contentSignature,
  planSignature,
  richnessLevel,
};
