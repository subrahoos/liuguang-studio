const { hammingDistance } = require("../analysis/frame-quality");

function semanticScore(targetTags, candidateTags) {
  const target = new Set(targetTags || []);
  const candidate = new Set(candidateTags || []);
  const specificTarget = [...target]
    .filter((tag) => tag !== "generic-product");
  if (specificTarget.some((tag) => candidate.has(tag))) return 1;
  if (!specificTarget.length && candidate.has("generic-product")) return 0.25;
  return 0;
}

function isNovel(hash, usedHashes) {
  return (usedHashes || []).every((usedHash) =>
    hammingDistance(usedHash, hash) > 6);
}

function scoreCandidate({ target, candidate, usedHashes = [] }) {
  const semantic = semanticScore(
    target.semanticTags,
    candidate.semanticTags,
  );
  const duration = Math.min(1, target.duration / candidate.duration);
  const clarity = Number(candidate.clarityScore) || 0;
  const boundary = Math.abs(candidate.duration - target.duration) <= 0.35
    ? 1
    : 0.5;
  const novelty = isNovel(candidate.visualHash, usedHashes) ? 1 : 0;
  return {
    score: Number((
      semantic * 0.45
      + duration * 0.20
      + clarity * 0.15
      + boundary * 0.10
      + novelty * 0.10
    ).toFixed(3)),
    components: {
      semantic,
      duration,
      clarity,
      boundary,
      novelty,
    },
  };
}

function rankBrollCandidates({
  target,
  candidates,
  usedHashes = [],
}) {
  return (candidates || [])
    .filter((candidate) =>
      candidate.faceState === "replaceable-product"
      && candidate.sourceId !== target.sourceId
      && Number(candidate.duration) >= Number(target.duration)
      && semanticScore(
        target.semanticTags,
        candidate.semanticTags,
      ) > 0
      && isNovel(candidate.visualHash, usedHashes))
    .map((candidate) => ({
      candidate,
      ...scoreCandidate({ target, candidate, usedHashes }),
    }))
    .sort((left, right) =>
      right.score - left.score
      || String(left.candidate.id).localeCompare(String(right.candidate.id)));
}

module.exports = {
  rankBrollCandidates,
  scoreCandidate,
  semanticScore,
};
