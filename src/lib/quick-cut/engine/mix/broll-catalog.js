const { hammingDistance } = require("../analysis/frame-quality");

function buildBrollCatalog(sources) {
  const candidates = (sources || []).flatMap((source) =>
    (source.shots || []).map((shot) => ({
      ...shot,
      sourceId: source.id,
      path: source.path,
    })))
    .filter((shot) =>
      shot.faceState === "replaceable-product"
      && Number(shot.duration) >= 0.6
      && /^[0-9a-f]{16}$/i.test(String(shot.visualHash || "")))
    .sort((left, right) =>
      (Number(right.clarityScore) || 0)
      - (Number(left.clarityScore) || 0)
      || String(left.id).localeCompare(String(right.id)));

  const catalog = [];
  for (const candidate of candidates) {
    const duplicate = catalog.some((kept) =>
      kept.sourceId === candidate.sourceId
      && hammingDistance(kept.visualHash, candidate.visualHash) <= 6);
    if (!duplicate) catalog.push(candidate);
  }
  return catalog;
}

module.exports = { buildBrollCatalog };
