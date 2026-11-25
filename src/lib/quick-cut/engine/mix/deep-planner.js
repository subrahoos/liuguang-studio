const {
  contentSignature,
  planSignature,
  richnessLevel,
} = require("./diversity");
const { buildBrollCatalog } = require("./broll-catalog");
const { rankBrollCandidates } = require("./broll-matcher");
const { inspectPlan } = require("./quality-gate");
const { planIntentMixes } = require("./intent-planner");
const { planFashionShowcase } = require("./fashion-planner");

class DeepPlannerError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeepPlannerError";
  }
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [
      result[swapIndex],
      result[index],
    ];
  }
  return result;
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function validateInput({ sources, count, durationMode, targetDuration }) {
  if (!Array.isArray(sources) || sources.length < 1) {
    throw new DeepPlannerError("至少需要 1 条有效视频");
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new DeepPlannerError("生成数量必须在 1 到 50 之间");
  }
  if (!["smart", "fixed"].includes(durationMode)) {
    throw new DeepPlannerError("时长模式无效");
  }
  if (
    durationMode === "fixed"
    && (!Number.isFinite(targetDuration) || targetDuration <= 0)
  ) {
    throw new DeepPlannerError("固定时长必须大于 0 秒");
  }
  for (const source of sources) {
    if (!source.id || !source.path || !Array.isArray(source.segments)) {
      throw new DeepPlannerError("素材分析结果不完整");
    }
  }
}

function toUnit(source, segment) {
  return {
    sourceId: source.id,
    segmentId: segment.id || `${source.id}-${segment.start}-${segment.end}`,
    role: segment.hasSpeech ? "speech" : "product",
    videoPath: source.path,
    videoStart: round(segment.start),
    duration: round(segment.duration ?? segment.end - segment.start),
    audioPath: source.hasAudio ? source.path : null,
    audioStart: round(segment.start),
    hasSpeech: Boolean(segment.hasSpeech),
    text: String(segment.text || ""),
  };
}

function sourceDuration(source) {
  const declared = Number(source.duration);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return Math.max(
    0,
    ...source.segments.map((segment) => Number(segment.end) || 0),
  );
}

function narrativeUnit(source, segment, start, end, suffix = "") {
  return {
    sourceId: source.id,
    segmentId: `${segment.id || `${source.id}-${start}-${end}`}${suffix}`,
    role: segment.hasSpeech ? "speech" : "narrative",
    videoPath: source.path,
    videoStart: round(start),
    duration: round(end - start),
    audioPath: source.hasAudio ? source.path : null,
    audioStart: round(start),
    hasSpeech: Boolean(segment.hasSpeech),
    text: segment.hasSpeech ? String(segment.text || "") : "",
  };
}

function buildNarrativeTimeline(source) {
  const totalDuration = sourceDuration(source);
  const segments = [...source.segments]
    .map((segment) => ({
      ...segment,
      start: Math.max(0, Number(segment.start)),
      end: Math.min(
        totalDuration,
        Number(segment.end ?? Number(segment.start) + Number(segment.duration)),
      ),
    }))
    .filter((segment) =>
      Number.isFinite(segment.start)
      && Number.isFinite(segment.end)
      && segment.end > segment.start)
    .sort((left, right) => left.start - right.start);
  const units = [];
  let cursor = 0;

  for (const segment of segments) {
    if (segment.start > cursor) {
      units.push(narrativeUnit(source, {
        id: `${source.id}-gap-${round(cursor)}`,
        hasSpeech: false,
      }, cursor, segment.start));
    }
    const start = Math.max(cursor, segment.start);
    if (segment.end <= start) continue;
    units.push(narrativeUnit(
      source,
      segment,
      start,
      segment.end,
      start === segment.start ? "" : "-clipped",
    ));
    cursor = segment.end;
  }

  if (cursor < totalDuration) {
    units.push(narrativeUnit(source, {
      id: `${source.id}-gap-${round(cursor)}`,
      hasSpeech: false,
    }, cursor, totalDuration));
  }
  return units;
}

function fitFixed(units, targetDuration) {
  const selected = [];
  let total = 0;
  for (const unit of units) {
    if (total + unit.duration <= targetDuration + 0.0001) {
      selected.push(unit);
      total += unit.duration;
    }
  }
  return selected;
}

function fitContiguous(units, targetDuration) {
  const selected = [];
  let total = 0;
  for (const unit of units) {
    if (total + unit.duration > targetDuration + 0.0001) break;
    selected.push(unit);
    total += unit.duration;
  }
  return selected;
}

function reorderAcrossSources(units, random) {
  const remaining = shuffled(units, random);
  const result = [];
  while (remaining.length) {
    const previousSource = result.at(-1)?.sourceId;
    let index = remaining.findIndex((unit) => unit.sourceId !== previousSource);
    if (index < 0) index = 0;
    result.push(remaining.splice(index, 1)[0]);
  }
  return result;
}

function productCandidate({
  units,
  random,
  durationMode,
  targetDuration,
}) {
  const ordered = reorderAcrossSources(units, random);
  if (durationMode === "fixed") {
    return fitFixed(ordered, targetDuration);
  }
  const desired = Math.min(
    ordered.length,
    6 + Math.floor(random() * 5),
  );
  return ordered.slice(0, Math.max(3, desired));
}

function applyBroll(speechUnits, productUnits, random) {
  if (!productUnits.length) return speechUnits;
  const available = shuffled(productUnits, random);
  return speechUnits.map((speechUnit, index) => {
    if (index % 3 !== 1 || !available.length) return speechUnit;
    const matchIndex = available.findIndex(
      (productUnit) => productUnit.duration >= speechUnit.duration,
    );
    if (matchIndex < 0) return speechUnit;
    const productUnit = available.splice(matchIndex, 1)[0];
    return {
      ...speechUnit,
      sourceId: productUnit.sourceId,
      segmentId: `${speechUnit.segmentId}+${productUnit.segmentId}`,
      role: "broll",
      videoPath: productUnit.videoPath,
      videoStart: productUnit.videoStart,
      audioPath: speechUnit.audioPath,
      audioStart: speechUnit.audioStart,
    };
  });
}

function buildCandidate({
  sources,
  random,
  durationMode,
  targetDuration,
}) {
  const allUnits = sources.flatMap((source) =>
    source.segments.map((segment) => toUnit(source, segment))
      .filter((unit) => unit.duration > 0));
  const speechSources = sources.filter((source) =>
    source.segments.some((segment) => segment.hasSpeech));
  const safeProductSourceIds = new Set(sources
    .filter((source) =>
      source.classification === "product"
      || (!source.classification && source.type === "product"))
    .map((source) => source.id));
  const productUnits = allUnits.filter((unit) =>
    !unit.hasSpeech && safeProductSourceIds.has(unit.sourceId));

  let units;
  let narrative = null;
  if (speechSources.length) {
    narrative = speechSources[
      Math.floor(random() * speechSources.length)
    ];
    const narrativeUnits = buildNarrativeTimeline(narrative);
    units = durationMode === "fixed"
      ? fitContiguous(narrativeUnits, targetDuration)
      : narrativeUnits;
    units = applyBroll(
      units,
      productUnits,
      random,
    );
  } else {
    units = productCandidate({
      units: productUnits,
      random,
      durationMode,
      targetDuration,
    });
  }

  if (!units.length) {
    throw new DeepPlannerError("没有可用于混剪的有效片段");
  }
  const totalDuration = round(
    units.reduce((sum, unit) => sum + unit.duration, 0),
  );
  const narrativeDuration = narrative ? round(sourceDuration(narrative)) : null;
  const retentionRatio = narrativeDuration
    ? round(totalDuration / narrativeDuration)
    : null;
  const qualityWarnings = [];
  if (durationMode === "smart" && retentionRatio !== null
      && retentionRatio < 0.8) {
    qualityWarnings.push("成片时长低于主讲素材的 80%");
  }
  if (narrative && !productUnits.length) {
    qualityWarnings.push("未检测到可安全替换的纯商品 B-roll");
  }
  return {
    units,
    totalDuration,
    narrativeSourceId: narrative?.id || null,
    narrativeDuration,
    retentionRatio,
    qualityWarnings,
  };
}

function planLegacyMixes({
  sources,
  count,
  durationMode = "smart",
  targetDuration = null,
  seed = Date.now(),
}) {
  validateInput({ sources, count, durationMode, targetDuration });
  const random = mulberry32(Number(seed) || 0);
  const contentPlans = [];
  const contentSignatures = new Set();
  const maxAttempts = Math.max(1000, count * 300);

  for (
    let attempt = 0;
    attempt < maxAttempts && contentPlans.length < count * 3;
    attempt += 1
  ) {
    const candidate = buildCandidate({
      sources,
      random,
      durationMode,
      targetDuration,
    });
    const signature = contentSignature(candidate);
    if (contentSignatures.has(signature)) continue;
    contentSignatures.add(signature);
    contentPlans.push(candidate);
  }

  if (!contentPlans.length) {
    throw new DeepPlannerError("当前素材无法生成有效组合");
  }

  const level = richnessLevel({
    uniqueContent: contentPlans.length,
    requested: count,
  });
  const plans = [];
  const planSignatures = new Set();
  for (let index = 0; plans.length < count; index += 1) {
    const sourcePlan = contentPlans[index % contentPlans.length];
    const plan = {
      id: `mix-${String(plans.length + 1).padStart(3, "0")}`,
      ...sourcePlan,
      visualVariant: index,
      diversityLevel: level,
    };
    const signature = planSignature(plan);
    if (planSignatures.has(signature)) continue;
    planSignatures.add(signature);
    plans.push(plan);
  }
  return plans;
}

function renderUnit({ anchor, target, candidate = null }) {
  return {
    sourceId: candidate?.sourceId || anchor.id,
    shotId: candidate?.id || target.id,
    segmentId: candidate?.id || target.id,
    role: candidate ? "broll" : "presenter",
    videoPath: candidate?.path || anchor.path,
    videoStart: round(candidate?.start ?? target.start),
    audioPath: anchor.path,
    audioStart: round(target.start),
    duration: round(target.duration),
    semanticTags: [...(target.semanticTags || ["generic-product"])],
    faceState: candidate?.faceState || target.faceState,
    visualHash: candidate?.visualHash || target.visualHash,
    hasSpeech: true,
    text: String(target.transcriptText || ""),
  };
}

function eligibleNarrativeSources(sources) {
  return sources
    .filter((source) =>
      Array.isArray(source.shots)
      && source.shots.length > 0
      && source.classification !== "product"
      && (
        Number(source.speechDuration) > 0
        || source.segments?.some((segment) => segment.hasSpeech)
      ))
    .sort((left, right) =>
      (Number(right.speechDuration) || 0)
      - (Number(left.speechDuration) || 0)
      || String(left.id).localeCompare(String(right.id)));
}

function targetShotsForMode(source, durationMode, targetDuration) {
  const ordered = [...source.shots]
    .filter((shot) =>
      Number.isFinite(Number(shot.start))
      && Number.isFinite(Number(shot.duration))
      && Number(shot.duration) > 0)
    .sort((left, right) => left.start - right.start);
  if (durationMode === "smart") return ordered;
  return ordered.filter((shot) =>
    Number(shot.end ?? Number(shot.start) + Number(shot.duration))
    <= targetDuration + 0.0001);
}

function faceLockedCandidate({
  anchor,
  targets,
  catalog,
  attempt,
}) {
  const units = [];
  const usedHashes = [];
  let divisor = 1;
  for (const target of targets) {
    let candidate = null;
    if (target.faceState === "replaceable-product") {
      const ranked = rankBrollCandidates({
        target: {
          ...target,
          sourceId: anchor.id,
        },
        candidates: catalog,
        usedHashes,
      });
      if (ranked.length) {
        const candidateIndex = Math.floor(attempt / divisor) % ranked.length;
        candidate = ranked[candidateIndex].candidate;
        divisor *= ranked.length;
        usedHashes.push(candidate.visualHash);
      }
    }
    units.push(renderUnit({ anchor, target, candidate }));
  }
  const totalDuration = round(
    units.reduce((sum, unit) => sum + unit.duration, 0),
  );
  const plan = {
    units,
    totalDuration,
    narrativeSourceId: anchor.id,
    narrativeAudioPath: anchor.path,
    narrativeDuration: totalDuration,
    retentionRatio: 1,
    qualityWarnings: [],
    visualVariant: 0,
  };
  const inspection = inspectPlan(plan);
  return {
    plan: {
      ...plan,
      replacementRatio: inspection.replacementRatio,
      externalBrollCount: inspection.externalBrollCount,
      coveredTags: inspection.coveredTags,
      diversityLevel: inspection.replacementRatio >= 0.25
        ? "high"
        : "medium",
    },
    inspection,
  };
}

function planFaceLockedMixes({
  sources,
  count,
  durationMode,
  targetDuration,
}) {
  const anchors = eligibleNarrativeSources(sources);
  const catalog = buildBrollCatalog(sources);
  const plans = [];
  const signatures = new Set();
  const maxAttempts = Math.max(100, count * 50, catalog.length * 50);

  for (const anchor of anchors) {
    const targets = targetShotsForMode(
      anchor,
      durationMode,
      targetDuration,
    );
    if (!targets.length) continue;
    for (
      let attempt = 0;
      attempt < maxAttempts && plans.length < count;
      attempt += 1
    ) {
      const { plan, inspection } = faceLockedCandidate({
        anchor,
        targets,
        catalog,
        attempt,
      });
      if (!inspection.valid) continue;
      const signature = plan.units.map((unit) =>
        `${unit.role}:${unit.shotId}`).join(">");
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      plans.push(plan);
    }
    if (plans.length >= count) break;
  }

  plans.forEach((plan, index) => {
    plan.id = `mix-${String(index + 1).padStart(3, "0")}`;
  });
  const warnings = [];
  if (!catalog.length || !plans.length) {
    warnings.push("无脸商品镜头不足，无法生成有效混剪版本");
  }
  if (plans.length > 0 && plans.length < count) {
    warnings.push(
      `当前素材只够生成 ${plans.length} 条有效版本，已停止凑数`,
    );
  }
  return {
    plans,
    requestedCount: count,
    meaningfulCapacity: plans.length,
    warnings,
  };
}

function planDeepMixes(options) {
  validateInput(options);
  if (options.modeOverride === "fashion-showcase") {
    return planFashionShowcase(options);
  }
  if (options.sources.some((source) =>
    Array.isArray(source.clauses))) {
    return planIntentMixes({
      sources: options.sources,
      count: options.count,
      modeOverride: options.modeOverride || "auto",
      seed: options.seed,
      targetDuration: options.durationMode === "fixed"
        ? options.targetDuration
        : null,
    });
  }
  if (eligibleNarrativeSources(options.sources).length) {
    return planFaceLockedMixes(options);
  }
  const plans = planLegacyMixes(options);
  return {
    plans,
    requestedCount: options.count,
    meaningfulCapacity: plans.length,
    warnings: [],
  };
}

module.exports = {
  DeepPlannerError,
  planDeepMixes,
};
