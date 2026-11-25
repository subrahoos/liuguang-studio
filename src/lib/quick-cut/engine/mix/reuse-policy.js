function priorUses(shotId, used) {
  return (used || []).filter((item) => item.shotId === shotId);
}

function canReuseShot(shotId, outputStart, used) {
  const prior = priorUses(shotId, used);
  if (prior.length >= 2) return false;
  return prior.every((item) =>
    Number(outputStart) - Number(item.outputStart) >= 8);
}

function variantForReuse(reuseIndex, intent) {
  if (Number(reuseIndex) <= 0) return { kind: "original" };
  if (String(intent).startsWith("action:")) {
    return { kind: "crop", scale: 1.04 };
  }
  return { kind: "mirror" };
}

module.exports = {
  canReuseShot,
  priorUses,
  variantForReuse,
};
