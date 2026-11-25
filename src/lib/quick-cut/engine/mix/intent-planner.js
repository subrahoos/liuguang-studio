const {
  compatibleIntent,
  shortageLabel,
} = require("./intent-compatibility");
const {
  canReuseShot,
  priorUses,
  variantForReuse,
} = require("./reuse-policy");
const { inspectPlan } = require("./quality-gate");

function round(value) {
  return Number(Number(value).toFixed(3));
}

function desiredReplacementRange(duration, mode) {
  if (mode !== "presenter") {
    return { min: 3, max: Number.POSITIVE_INFINITY };
  }
  if (Number(duration) <= 20) return { min: 3, max: 3 };
  if (Number(duration) <= 40) return { min: 3, max: 4 };
  return { min: 3, max: 5 };
}

function usableShots(sources, anchorId) {
  return (sources || []).flatMap((source) =>
    (source.shots || []).map((shot) => ({
      ...shot,
      sourceId: source.id,
      path: source.path,
    })))
    .filter((shot) =>
      shot.sourceId !== anchorId
      && shot.faceState === "replaceable-product"
      && Number(shot.duration) >= 0.6
      && shot.visualIntent
      && shot.visualIntent !== "person-expression")
    .sort((left, right) =>
      (Number(right.intentConfidence) || 0)
      - (Number(left.intentConfidence) || 0)
      || (Number(right.clarityScore) || 0)
      - (Number(left.clarityScore) || 0)
      || String(left.id).localeCompare(String(right.id)));
}

function unitFromTarget(anchor, target, candidate, used) {
  const outputStart = round(target.start);
  const anchorAudioPath = anchor.hasAudio === false ? null : anchor.path;
  const reuseIndex = candidate
    ? priorUses(candidate.id, used).length
    : 0;
  return {
    sourceId: candidate?.sourceId || anchor.id,
    shotId: candidate?.id || target.id,
    segmentId: candidate?.id || target.id,
    role: candidate ? "broll" : "presenter",
    videoPath: candidate?.path || anchor.path,
    videoStart: round(candidate?.start ?? target.start),
    audioPath: anchorAudioPath,
    audioStart: outputStart,
    outputStart,
    duration: round(target.duration),
    semanticTags: [...(target.semanticTags || [])],
    faceState: candidate?.faceState || target.faceState,
    visualHash: candidate?.visualHash || target.visualHash,
    visualIntent: target.visualIntent,
    candidateIntent: candidate?.visualIntent || null,
    variant: candidate
      ? variantForReuse(reuseIndex, target.visualIntent)
      : { kind: "original" },
    reuseIndex,
    hasSpeech: Number(anchor.speechDuration) > 0,
    text: String(target.transcriptText || ""),
  };
}

function candidatesForTarget(target, catalog, used, attempt) {
  const matches = catalog.filter((candidate) =>
    compatibleIntent(target.visualIntent, candidate.visualIntent)
    && Number(candidate.duration) >= Number(target.duration)
    && canReuseShot(candidate.id, target.start, used));
  if (!matches.length) return [];
  const offset = attempt % matches.length;
  return [...matches.slice(offset), ...matches.slice(0, offset)];
}

function makePlan({
  anchor,
  sources,
  mode,
  attempt,
  targetDuration,
}) {
  const catalog = usableShots(sources, anchor.id);
  const durationLimit = Number.isFinite(Number(targetDuration))
    && Number(targetDuration) > 0
    ? Math.min(Number(anchor.duration), Number(targetDuration))
    : Number(anchor.duration);
  const targets = [...(anchor.shots || [])]
    .filter((shot) => Number(shot.duration) > 0)
    .map((shot) => {
      const start = Number(shot.start);
      const end = Math.min(Number(shot.end), durationLimit);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }
      return {
        ...shot,
        end: round(end),
        duration: round(end - start),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  const range = desiredReplacementRange(durationLimit, mode);
  const used = [];
  const units = [];
  const shortages = new Map();

  for (const target of targets) {
    const replaceable = mode !== "presenter"
      || target.faceState === "replaceable-product";
    let candidate = null;
    if (
      replaceable
      && target.visualIntent
      && target.visualIntent !== "person-expression"
      && used.length < range.max
    ) {
      candidate = candidatesForTarget(
        target,
        catalog,
        used,
        attempt + units.length,
      )[0] || null;
      if (candidate) {
        used.push({
          shotId: candidate.id,
          outputStart: Number(target.start),
        });
      } else {
        const label = shortageLabel(target.visualIntent);
        shortages.set(label, (shortages.get(label) || 0) + 1);
      }
    }
    units.push(unitFromTarget(anchor, target, candidate, used.slice(
      0,
      candidate ? -1 : undefined,
    )));
  }

  const replacementUnits = units.filter((unit) => unit.role === "broll");
  const distinctShots = new Set(replacementUnits.map((unit) => unit.shotId));
  if (
    replacementUnits.length < range.min
    || distinctShots.size < 2
  ) {
    return { plan: null, shortages };
  }
  const totalDuration = round(units.reduce(
    (sum, unit) => sum + Number(unit.duration),
    0,
  ));
  const plan = {
      units,
      totalDuration,
      narrativeSourceId: anchor.id,
      narrativeAudioPath: anchor.hasAudio === false ? null : anchor.path,
      narrativeDuration: totalDuration,
      editingMode: mode,
      replacementCount: replacementUnits.length,
      externalBrollCount: replacementUnits.length,
      replacementRatio: totalDuration
        ? round(replacementUnits.reduce(
          (sum, unit) => sum + Number(unit.duration),
          0,
        ) / totalDuration)
        : 0,
      shortages: [...shortages.entries()].map(([label, count]) => ({
        label,
        count,
      })),
      visualVariant: 0,
      diversityLevel: "high",
      retentionRatio: 1,
      qualityWarnings: [],
  };
  const inspection = inspectPlan(plan);
  if (!inspection.valid) return { plan: null, shortages };
  return {
    plan: {
      ...plan,
      replacementRatio: inspection.replacementRatio,
      replacementCount: inspection.replacementCount,
      externalBrollCount: inspection.externalBrollCount,
      coveredTags: inspection.coveredTags,
    },
    shortages,
  };
}

function anchorSources(sources) {
  return [...(sources || [])]
    .filter((source) =>
      Array.isArray(source.shots) && source.shots.length);
}

function planSignature(plan) {
  return `${plan.narrativeSourceId}|${plan.units.map((unit) =>
    `${unit.role}:${unit.shotId}:${unit.variant.kind}`).join(">")}`;
}

function anchorWarning(state) {
  const [first] = [...state.shortages.entries()];
  return {
    sourceId: state.anchor.id,
    path: state.anchor.path,
    reason: first
      ? `缺少 ${first[1]} 个${first[0]}`
      : "无法满足至少 3 个准确替换镜头",
  };
}

function findNextPlan({
  state,
  sources,
  signatures,
  attempts,
  aggregateShortages,
  targetDuration,
}) {
  for (let searched = 0; searched < attempts; searched += 1) {
    const result = makePlan({
      anchor: state.anchor,
      sources,
      mode: state.mode,
      attempt: state.nextAttempt,
      targetDuration,
    });
    state.nextAttempt += 1;
    for (const [label, missing] of result.shortages) {
      state.shortages.set(
        label,
        Math.max(state.shortages.get(label) || 0, missing),
      );
      aggregateShortages.set(
        label,
        Math.max(aggregateShortages.get(label) || 0, missing),
      );
    }
    if (!result.plan) continue;
    const signature = planSignature(result.plan);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    return result.plan;
  }
  state.exhausted = true;
  return null;
}

function planIntentMixes({
  sources,
  count,
  modeOverride = "auto",
  seed = 1,
  targetDuration = null,
}) {
  const plans = [];
  const signatures = new Set();
  const aggregateShortages = new Map();
  let detectedEditingMode = null;
  let clauseCount = 0;
  let exactMatchCount = 0;
  const attempts = Math.max(50, Number(count) * 20);
  const states = anchorSources(sources).map((anchor) => {
    const mode = modeOverride === "auto"
      ? anchor.editingMode
      : modeOverride;
    detectedEditingMode ||= mode;
    clauseCount = Math.max(clauseCount, anchor.clauses?.length || 0);
    return {
      anchor,
      mode,
      nextAttempt: Number(seed || 0),
      useCount: 0,
      pendingPlan: null,
      eligible: false,
      exhausted: false,
      shortages: new Map(),
    };
  });

  for (const state of states) {
    state.pendingPlan = findNextPlan({
      state,
      sources,
      signatures,
      attempts,
      aggregateShortages,
      targetDuration,
    });
    state.eligible = Boolean(state.pendingPlan);
  }

  let anchorRound = 1;
  while (plans.length < count) {
    let addedThisRound = 0;
    for (const state of states) {
      if (plans.length >= count) break;
      if (!state.pendingPlan || state.exhausted) continue;
      state.useCount += 1;
      plans.push({
        ...state.pendingPlan,
        anchorRound,
        anchorUseIndex: state.useCount,
      });
      exactMatchCount = Math.max(
        exactMatchCount,
        state.pendingPlan.replacementCount,
      );
      addedThisRound += 1;
      state.pendingPlan = findNextPlan({
        state,
        sources,
        signatures,
        attempts,
        aggregateShortages,
        targetDuration,
      });
    }
    if (!addedThisRound) break;
    anchorRound += 1;
  }

  plans.forEach((plan, index) => {
    plan.id = `mix-${String(index + 1).padStart(3, "0")}`;
  });
  const shortages = [...aggregateShortages.entries()]
    .map(([label, missing]) => ({ label, missing }));
  const warnings = [];
  if (!plans.length) {
    const detail = shortages[0];
    warnings.push(detail
      ? `准确匹配不足，还需要 ${detail.missing} 个${detail.label}`
      : "准确匹配不足，每条成片至少需要 3 个替换镜头");
  } else if (plans.length < count) {
    warnings.push(
      `当前素材只能生成 ${plans.length} 条准确匹配版本，已停止凑数`,
    );
  }
  const anchorUsage = states.map((state) => ({
    sourceId: state.anchor.id,
    path: state.anchor.path,
    count: state.useCount,
  }));
  const anchorWarnings = states
    .filter((state) => !state.eligible)
    .map(anchorWarning);
  return {
    plans,
    requestedCount: count,
    meaningfulCapacity: plans.length,
    eligibleAnchorCount: states.filter((state) => state.eligible).length,
    usedAnchorCount: states.filter((state) => state.useCount > 0).length,
    anchorUsage,
    anchorWarnings,
    warnings,
    shortages,
    detectedEditingMode,
    clauseCount,
    exactMatchCount,
  };
}

module.exports = {
  desiredReplacementRange,
  planIntentMixes,
};
