function speechCoverage({ duration, speechDuration }) {
  const total = Number(duration);
  const speech = Number(speechDuration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(speech) || speech <= 0) return 0;
  return Number(Math.min(1, speech / total).toFixed(4));
}

function classifyMedia(input) {
  const coverage = speechCoverage(input);
  if (coverage <= 0.1) return "product";
  if (coverage >= 0.35) return "speech";
  return "mixed";
}

module.exports = {
  classifyMedia,
  speechCoverage,
};
