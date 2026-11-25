const ROLE_ORDER = [
  "opening-full-body",
  "fabric-detail",
  "slimming-silhouette",
  "wearing-effect",
  "movement-drape",
  "side-back",
  "closing-pose",
];

const { inspectPlan } = require("./quality-gate");

const ROLE_WEIGHTS = {
  "opening-full-body": 1.3,
  "fabric-detail": 1.15,
  "slimming-silhouette": 1.2,
  "wearing-effect": 1.25,
  "movement-drape": 1.2,
  "side-back": 1.1,
  "closing-pose": 1.2,
};

const ROLE_DURATIONS = {
  "opening-full-body": 3,
  "fabric-detail": 2.2,
  "slimming-silhouette": 3.2,
  "wearing-effect": 3.4,
  "movement-drape": 3.2,
  "side-back": 3,
  "closing-pose": 2.8,
  unclassified: 2.6,
};

const STRICT_BATCH_OVERLAP = 0.2;
const ADAPTIVE_BATCH_OVERLAP = 0.35;
const VISUAL_DUPLICATE_DISTANCE = 4;

const LEGACY_ROLES = {
  opening: "opening-full-body",
  "full-look": "wearing-effect",
  movement: "movement-drape",
  detail: "fabric-detail",
  closing: "closing-pose",
};

function round(value) {
  return Number(Number(value).toFixed(3));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeRole(shot) {
  const raw = String(shot.fashionRole || shot.fashionVision?.fashionRole || "");
  const value = LEGACY_ROLES[raw] || raw;
  return ROLE_ORDER.includes(value) ? value : "unclassified";
}

function visualIdentity(shot) {
  const hash = String(shot.visualHash || "").trim();
  return hash
    ? `${shot.sourceId}:hash:${hash}:time:${Number(shot.start).toFixed(2)}`
    : `${shot.sourceId}:time:${Number(shot.start).toFixed(3)}:${Number(shot.duration).toFixed(3)}`;
}

function validVisualHash(value) {
  return /^[0-9a-f]{16}$/i.test(String(value || ""));
}

function visualDistance(left, right) {
  const leftHash = String(left?.visualHash || "");
  const rightHash = String(right?.visualHash || "");
  if (!validVisualHash(leftHash) || !validVisualHash(rightHash)) return Number.POSITIVE_INFINITY;
  let value = BigInt(`0x${leftHash}`) ^ BigInt(`0x${rightHash}`);
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

function similarVisual(left, right) {
  if (left?.visualCluster && right?.visualCluster) {
    return left.visualCluster === right.visualCluster;
  }
  return visualDistance(left, right) <= VISUAL_DUPLICATE_DISTANCE;
}

function assignVisualClusters(shots) {
  const representatives = [];
  return shots.map((shot) => {
    if (!validVisualHash(shot.visualHash)) {
      return { ...shot, visualCluster: `shot:${shot.id}` };
    }
    const clusterIndex = representatives.findIndex((representative) => visualDistance(representative, shot) <= VISUAL_DUPLICATE_DISTANCE);
    if (clusterIndex >= 0) return { ...shot, visualCluster: `visual:${clusterIndex}` };
    representatives.push(shot);
    return { ...shot, visualCluster: `visual:${representatives.length - 1}` };
  });
}

function poseOf(shot) {
  return shot?.fashionPose || shot?.fashionVision?.pose || null;
}

function isOpeningCandidate(shot) {
  const pose = poseOf(shot);
  return shot.fashionRole === "opening-full-body"
    || (String(pose?.bodyFrame || "") === "full-body" && Number(pose?.completeness || 0) >= 0.6);
}

function isClosingCandidate(shot) {
  const pose = poseOf(shot);
  return shot.fashionRole === "closing-pose"
    || (
      ["full-body", "three-quarter"].includes(String(pose?.bodyFrame || ""))
      && Number(pose?.completeness || 0) >= 0.6
      && Number(pose?.stability || 0) >= 0.45
    );
}

function supportsTimelineRole(shot, role) {
  if (role === "opening-full-body") return isOpeningCandidate(shot);
  if (role === "closing-pose") return isClosingCandidate(shot);
  return true;
}

function visualUsage(shot, batchVisuals) {
  return (batchVisuals || []).reduce((total, used) => total + (similarVisual(shot, used) ? 1 : 0), 0);
}

function sourceShots(sources) {
  return (sources || []).flatMap((source) => (source.shots || [])
    .map((shot) => {
      const start = Number(shot.safeStart ?? shot.start);
      const duration = Number(shot.safeDuration ?? shot.duration ?? Number(shot.end) - start);
      if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 1.2) return null;
      if (shot.fashionUsable === false) return null;
      const normalized = {
        ...shot,
        id: shot.id || `${source.id}-${start}`,
        sourceId: source.id,
        path: source.path,
        start,
        duration,
        hasAudio: source.hasAudio !== false,
        fashionRole: normalizeRole(shot),
      };
      return { ...normalized, visualIdentity: visualIdentity(normalized) };
    })
    .filter(Boolean));
}

function shotScore(shot) {
  const roleWeight = ROLE_WEIGHTS[shot.fashionRole] || 0.35;
  const durationScore = Math.min(1, Number(shot.duration) / 3) * 2;
  const clarity = Number(shot.clarityScore) || 0;
  const confidence = Number(shot.intentConfidence) || 0;
  const fashionScore = Number(shot.fashionScore) || 0;
  const pose = shot.fashionPose || shot.fashionVision?.pose || null;
  const poseCompleteness = Number(pose?.completeness) || 0;
  const poseMotion = Number(pose?.motionMagnitude) || 0;
  const poseStability = Number(pose?.stability) || 0;
  const poseFrame = String(pose?.bodyFrame || "");
  const poseOrientation = String(pose?.orientation || "");
  let poseScore = poseCompleteness * 0.65;
  if (poseFrame === "full-body" && ["opening-full-body", "wearing-effect", "slimming-silhouette"].includes(shot.fashionRole)) poseScore += 0.3;
  if (poseOrientation === "side-back" && shot.fashionRole === "side-back") poseScore += 0.35;
  if (poseMotion >= 0.055 && shot.fashionRole === "movement-drape") poseScore += Math.min(0.35, poseMotion * 1.5);
  if (poseStability >= 0.7 && shot.fashionRole === "closing-pose") poseScore += 0.2;
  const penalty = shot.burnedTextRisk ? 0.7 : 0;
  return durationScore + clarity + confidence + fashionScore + roleWeight + poseScore - penalty;
}

function uniqueTimelineShots(shots) {
  const accepted = [];
  const identities = new Set();
  for (const shot of shots) {
    const identity = `${shot.sourceId}:${Number(shot.start).toFixed(3)}:${Number(shot.duration).toFixed(3)}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    accepted.push(shot);
  }
  return accepted;
}

function normalizedSpeechItems(source) {
  const raw = Array.isArray(source.clauses) && source.clauses.length > 1
    ? source.clauses
    : source.transcript;
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      start: Math.max(0, Number(item.start)),
      end: Math.min(Number(source.duration), Number(item.end)),
      text: String(item.text || "").trim(),
    }))
    .filter((item) => item.text && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((left, right) => left.start - right.start);
}

function coherentAudioSpine(source, targetDuration, durationMode) {
  if (source.hasAudio === false || Number(source.speechDuration) < Math.min(8, targetDuration * 0.5)) return null;
  const items = normalizedSpeechItems(source);
  if (!items.length) return null;
  const minimumDuration = Math.min(10, targetDuration * 0.65);
  let best = null;
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left; right < items.length; right += 1) {
      const start = items[left].start;
      const end = items[right].end;
      const duration = end - start;
      if (duration > targetDuration + 0.05) break;
      if (!best || duration > best.duration) {
        best = { start, duration, textCount: right - left + 1 };
      }
    }
  }
  if (!best || best.duration < minimumDuration) return null;
  const planDuration = durationMode === "fixed" ? targetDuration : clamp(best.duration, 12, targetDuration);
  const sourceAudioDuration = Math.max(0, Number(source.duration) - best.start);
  return {
    sourceId: source.id,
    path: source.path,
    start: round(best.start),
    // Clauses locate a coherent speech window; the source audio track remains
    // continuous through the requested duration, including natural pauses.
    audioDuration: round(Math.min(sourceAudioDuration, planDuration)),
    planDuration: round(planDuration),
    textCount: best.textCount,
  };
}

function roleForPosition(index, remaining) {
  if (index === 0) return "opening-full-body";
  if (remaining <= 3.3) return "closing-pose";
  const middle = ROLE_ORDER.slice(1, -1);
  return middle[(index - 1) % middle.length];
}

function pairwiseOverlap(left, right) {
  const overlap = right.units.reduce((sum, unit) => {
    const maximum = left.units.reduce((best, previous) => {
      if (previous.segmentId && previous.segmentId === unit.segmentId) {
        return Math.max(best, Math.min(Number(previous.duration) || 0, Number(unit.duration) || 0));
      }
      if (previous.sourceId && previous.sourceId === unit.sourceId) {
        return Math.max(best, intervalOverlap(previous, unit));
      }
      if (similarVisual(previous, unit)) {
        return Math.max(best, Math.min(Number(previous.duration) || 0, Number(unit.duration) || 0) * 0.75);
      }
      return best;
    }, 0);
    return sum + maximum;
  }, 0);
  return Math.max(0, overlap / Math.max(0.001, Math.min(Number(left.totalDuration), Number(right.totalDuration))));
}

function intervalOverlap(left, right) {
  return Math.max(
    0,
    Math.min(Number(left.videoStart || 0) + Number(left.duration || 0), Number(right.videoStart || 0) + Number(right.duration || 0))
      - Math.max(Number(left.videoStart || 0), Number(right.videoStart || 0)),
  );
}

function chooseShot({ shots, role, usedIds, usedVisuals, previousSource, batchUsage, batchVisuals, random }) {
  return shots
    .filter((shot) => (
      !usedIds.has(shot.id)
      && supportsTimelineRole(shot, role)
      && !usedVisuals.has(shot.visualCluster)
    ))
    .map((shot) => ({ shot, random: random(), batchVisualUsage: visualUsage(shot, batchVisuals) }))
    .sort((left, right) => {
      const leftRole = left.shot.fashionRole === role ? 1 : 0;
      const rightRole = right.shot.fashionRole === role ? 1 : 0;
      return left.batchVisualUsage - right.batchVisualUsage
        || (batchUsage.get(left.shot.id) || 0) - (batchUsage.get(right.shot.id) || 0)
        || rightRole - leftRole
        || Number(left.shot.sourceId === previousSource) - Number(right.shot.sourceId === previousSource)
        || shotScore(right.shot) - shotScore(left.shot)
        || left.random - right.random;
    })[0]?.shot || null;
}

function buildPlan({ shots, targetDuration, variant, seed, audioSpine, audioMode, batchUsage, batchVisuals }) {
  const random = seededRandom(Number(seed) + Number(variant) * 101 + 1);
  const units = [];
  const selectedShots = [];
  const usedIds = new Set();
  const usedVisuals = new Set();
  let outputStart = 0;
  let previousSource = null;

  while (targetDuration - outputStart > 0.05) {
    const remaining = round(targetDuration - outputStart);
    const role = roleForPosition(units.length, remaining);
    const shot = chooseShot({ shots, role, usedIds, usedVisuals, previousSource, batchUsage, batchVisuals, random });
    if (!shot) break;
    const preferred = ROLE_DURATIONS[role] || ROLE_DURATIONS.unclassified;
    const duration = round(Math.min(Number(shot.duration), preferred, remaining));
    if (duration < 0.8) {
      const previous = units.at(-1);
      const previousShot = selectedShots.at(-1);
      const available = previous && previousShot
        ? Math.max(0, Number(previousShot.duration) - Number(previous.duration))
        : 0;
      if (available >= remaining) {
        previous.duration = round(Number(previous.duration) + remaining);
        outputStart = round(outputStart + remaining);
      }
      break;
    }
    units.push({
      sourceId: shot.sourceId,
      shotId: shot.id,
      segmentId: shot.id,
      role: "fashion-shot",
      timelineRole: role,
      fashionRole: shot.fashionRole,
      videoPath: shot.path,
      videoStart: round(shot.start),
      duration,
      audioPath: null,
      audioStart: round(outputStart),
      audioSourceStart: 0,
      outputStart: round(outputStart),
      hasSpeech: false,
      faceState: shot.faceState,
      visualHash: shot.visualHash,
      visualCluster: shot.visualCluster,
      fashionPose: shot.fashionPose || shot.fashionVision?.pose || null,
      visualIntent: shot.visualIntent || "fashion-showcase",
      semanticTags: [...(shot.semanticTags || []), "fashion-showcase", `fashion-role:${shot.fashionRole}`],
      text: "",
    });
    selectedShots.push(shot);
    usedIds.add(shot.id);
    usedVisuals.add(shot.visualCluster);
    previousSource = shot.sourceId;
    outputStart = round(outputStart + duration);
  }

  if (outputStart < targetDuration * 0.94) return null;
  const actualDuration = round(outputStart);
  const roleCoverage = [...new Set(units.map((unit) => unit.fashionRole).filter((role) => role !== "unclassified"))];
  const plan = {
    units,
    totalDuration: actualDuration,
    narrativeSourceId: audioSpine?.sourceId || null,
    narrativeAudioPath: audioSpine?.path || null,
    narrativeAudioStart: audioSpine?.start || 0,
    narrativeAudioDuration: audioSpine?.audioDuration || actualDuration,
    narrativeDuration: actualDuration,
    audioMode,
    retentionRatio: 1,
    editingMode: "fashion-showcase",
    visualVariant: 0,
    diversityLevel: "high",
    roleCoverage,
    qualityWarnings: [
      ...(units.some((unit) => unit.fashionRole === "unclassified")
        ? ["部分镜头尚未完成女装语义识别，已使用基础规则"]
        : []),
      ...(roleCoverage.length < 5 ? [`七类女装镜头当前覆盖 ${roleCoverage.length}/7 类`] : []),
    ],
  };
  return inspectPlan(plan).valid ? plan : null;
}

function emptyBatch(count, countMode, message) {
  return {
    plans: [], countMode, requestedCount: count, roughEstimatedCount: 0,
    meaningfulCapacity: 0, actualCount: 0, eligibleAnchorCount: 0,
    usedAnchorCount: 0, audioSpineCount: 0, exactMatchCount: 0,
    detectedEditingMode: "fashion-showcase", capacityReason: message,
    shortages: [], anchorWarnings: [message], warnings: [message],
  };
}

function durationCandidates(durationMode, countMode, targetDuration) {
  if (durationMode === "smart" && countMode === "smart") return [30, 24, 20, 15];
  return [durationMode === "fixed" ? Number(targetDuration) : 30];
}

function chooseAudioSpine(audioSpines, audioUsage) {
  return [...audioSpines].sort((left, right) => (
    (audioUsage.get(left.sourceId) || 0) - (audioUsage.get(right.sourceId) || 0)
    || String(left.sourceId).localeCompare(String(right.sourceId))
  ))[0] || null;
}

function planForDuration({
  allShots,
  sources,
  count,
  countMode,
  durationMode,
  planningDuration,
  audioMode,
  seed,
}) {
  const totalSourceDuration = (sources || []).reduce((sum, source) => sum + Math.max(0, Number(source.duration) || 0), 0);
  const durationEstimate = clamp(Math.floor(totalSourceDuration / planningDuration), 1, 50);
  const audioSpines = (sources || [])
    .map((source) => coherentAudioSpine(source, planningDuration, durationMode))
    .filter(Boolean)
    .sort((left, right) => right.audioDuration - left.audioDuration || String(left.sourceId).localeCompare(String(right.sourceId)));
  const needsOriginalAudio = audioMode !== "bgm";
  const requestedLimit = countMode === "smart" ? durationEstimate : Number(count);
  const preliminaryCapacity = Math.min(
    requestedLimit,
    durationEstimate,
    needsOriginalAudio ? audioSpines.length : Number.POSITIVE_INFINITY,
  );
  const openingCandidates = allShots.filter(isOpeningCandidate);
  const semanticOpeningCandidates = allShots.filter((shot) => shot.fashionRole === "opening-full-body");
  const stats = { noPlan: 0, signatureRejected: 0, strictOverlapRejected: 0, adaptiveOverlapRejected: 0, adaptiveAccepted: 0 };

  if (preliminaryCapacity < 1) {
    return {
      plans: [], durationEstimate, preliminaryCapacity: 0, audioSpines, openingCandidates,
      semanticOpeningCandidates, planningDuration, stats,
    };
  }

  const plans = [];
  const signatures = new Set();
  const batchUsage = new Map();
  const batchVisuals = [];
  const audioUsage = new Map();
  const overlapLimits = countMode === "smart" && durationMode === "smart"
    ? [STRICT_BATCH_OVERLAP, ADAPTIVE_BATCH_OVERLAP]
    : [STRICT_BATCH_OVERLAP];
  const maxAttempts = Math.max(48, preliminaryCapacity * 40);

  for (const overlapLimit of overlapLimits) {
    for (let attempt = 0; attempt < maxAttempts && plans.length < preliminaryCapacity; attempt += 1) {
      const audioSpine = needsOriginalAudio ? chooseAudioSpine(audioSpines, audioUsage) : null;
      const plan = buildPlan({
        shots: allShots,
        targetDuration: audioSpine?.planDuration || planningDuration,
        variant: attempt + (overlapLimit === ADAPTIVE_BATCH_OVERLAP ? maxAttempts : 0),
        seed,
        audioSpine,
        audioMode,
        batchUsage,
        batchVisuals,
      });
      if (!plan) {
        stats.noPlan += 1;
        continue;
      }
      const signature = plan.units.map((unit) => `${unit.shotId}:${unit.videoStart}:${unit.duration}`).join(">");
      const maxOverlap = plans.reduce((maximum, current) => Math.max(maximum, pairwiseOverlap(current, plan)), 0);
      if (signatures.has(signature)) {
        stats.signatureRejected += 1;
        continue;
      }
      if (maxOverlap > overlapLimit) {
        if (overlapLimit === STRICT_BATCH_OVERLAP) stats.strictOverlapRejected += 1;
        else stats.adaptiveOverlapRejected += 1;
        continue;
      }
      signatures.add(signature);
      plan.maxBatchOverlap = round(maxOverlap);
      plan.overlapTier = overlapLimit === ADAPTIVE_BATCH_OVERLAP ? "adaptive" : "strict";
      plans.push(plan);
      if (plan.overlapTier === "adaptive") stats.adaptiveAccepted += 1;
      if (audioSpine?.sourceId) audioUsage.set(audioSpine.sourceId, (audioUsage.get(audioSpine.sourceId) || 0) + 1);
      for (const unit of plan.units) {
        batchUsage.set(unit.shotId, (batchUsage.get(unit.shotId) || 0) + 1);
        batchVisuals.push(unit);
      }
    }
  }

  return {
    plans,
    durationEstimate,
    preliminaryCapacity,
    audioSpines,
    openingCandidates,
    semanticOpeningCandidates,
    planningDuration,
    stats,
  };
}

function planFashionShowcase({
  sources,
  count,
  countMode = "custom",
  durationMode = "smart",
  targetDuration = null,
  audioMode = "original",
  seed = Date.now(),
}) {
  const allShots = assignVisualClusters(uniqueTimelineShots(sourceShots(sources)));
  if (!allShots.length) return emptyBatch(count, countMode, "没有检测到可用于穿搭展示的有效镜头");
  const candidates = durationCandidates(durationMode, countMode, targetDuration)
    .map((planningDuration) => planForDuration({
      allShots, sources, count, countMode, durationMode, planningDuration, audioMode, seed,
    }))
    .sort((left, right) => (
      right.plans.length - left.plans.length
      || right.plans.reduce((sum, plan) => sum + Number(plan.totalDuration || 0), 0) - left.plans.reduce((sum, plan) => sum + Number(plan.totalDuration || 0), 0)
      || right.planningDuration - left.planningDuration
    ));
  const selected = candidates[0];
  const needsOriginalAudio = audioMode !== "bgm";
  const roughEstimatedCount = selected.durationEstimate;
  const plans = selected.plans;
  plans.forEach((plan, index) => { plan.id = `mix-${String(index + 1).padStart(3, "0")}`; });

  if (!plans.length) {
    const reason = needsOriginalAudio && !selected.audioSpines.length
      ? "没有识别到可保持完整语句的连续原声主线"
      : "单条成片在去重后没有足够的真实女装镜头";
    return {
      ...emptyBatch(count, countMode, reason),
      roughEstimatedCount,
      eligibleAnchorCount: selected.audioSpines.length,
      audioSpineCount: selected.audioSpines.length,
      selectedDuration: selected.planningDuration,
    };
  }

  const poseOpeningCount = Math.max(0, selected.openingCandidates.length - selected.semanticOpeningCandidates.length);
  const constraints = [
    durationMode === "smart" && countMode === "smart"
      ? `智能时长已选择约 ${selected.planningDuration} 秒，以不重复成片数量优先`
      : `成片时长 ${selected.planningDuration} 秒`,
    needsOriginalAudio ? `连续原声主线 ${selected.audioSpines.length} 条` : "仅背景音乐，不受原声主线限制",
    `开场全身候选 ${selected.openingCandidates.length} 个（语义开场 ${selected.semanticOpeningCandidates.length} 个，姿态模型全身补充 ${poseOpeningCount} 个）`,
    "单条成片已拦截重复或近似画面",
  ];
  if (selected.stats.adaptiveAccepted) constraints.push("为增加数量，部分成片跨片素材重合控制在 35% 以内");
  if (plans.length < selected.preliminaryCapacity) {
    if (selected.stats.noPlan) constraints.push(`单条视觉去重后候选不足 ${selected.stats.noPlan} 次`);
    if (selected.stats.strictOverlapRejected || selected.stats.adaptiveOverlapRejected) {
      constraints.push(`跨成片重复限制淘汰 ${selected.stats.strictOverlapRejected + selected.stats.adaptiveOverlapRejected} 个候选`);
    }
  }
  const capacityReason = constraints.join("；");
  const warnings = plans.length < Number(count) || countMode === "smart"
    ? [`预计 ${roughEstimatedCount} 条，最终高质量容量 ${plans.length} 条；${capacityReason}`]
    : [];
  return {
    plans, countMode, requestedCount: Number(count), roughEstimatedCount,
    meaningfulCapacity: plans.length, actualCount: plans.length,
    eligibleAnchorCount: selected.audioSpines.length,
    usedAnchorCount: new Set(plans.map((plan) => plan.narrativeSourceId).filter(Boolean)).size,
    audioSpineCount: selected.audioSpines.length, exactMatchCount: plans.length,
    detectedEditingMode: "fashion-showcase", capacityReason,
    selectedDuration: selected.planningDuration,
    constraintDetails: constraints,
    shortages: [], anchorWarnings: [], warnings,
  };
}

module.exports = { planFashionShowcase };
